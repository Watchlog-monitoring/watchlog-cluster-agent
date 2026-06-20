/**
 * Event collector. Prioritizes Warning events and well-known failure reasons,
 * keeps at most maxEvents (most recent first). Tries events.k8s.io/v1, falls
 * back to the core /api/v1/events endpoint.
 */
const PRIORITY_REASONS = new Set([
  'FailedScheduling', 'BackOff', 'Unhealthy', 'FailedMount', 'ImagePullBackOff',
  'Failed', 'Killing', 'Pulling', 'Pulled', 'Created', 'Started',
]);

function lastTs(ev) {
  return (
    ev.lastTimestamp ||
    ev.deprecatedLastTimestamp ||
    (ev.series && ev.series.lastObservedTime) ||
    ev.eventTime ||
    (ev.metadata && ev.metadata.creationTimestamp)
  );
}

function normalize(ev, clusterId) {
  const obj = ev.involvedObject || ev.regarding || {};
  const type = ev.type || 'Normal';
  return {
    uid: ev.metadata && ev.metadata.uid,
    clusterId,
    namespace: (ev.metadata && ev.metadata.namespace) || obj.namespace,
    type,
    reason: ev.reason,
    message: ev.message || ev.note,
    involvedObject: {
      kind: obj.kind,
      name: obj.name,
      uid: obj.uid,
      namespace: obj.namespace,
    },
    source:
      (ev.source && (ev.source.component || ev.source.host)) ||
      (ev.reportingController) ||
      null,
    count: ev.count || (ev.series && ev.series.count) || 1,
    firstTimestamp: ev.firstTimestamp || ev.eventTime,
    lastTimestamp: lastTs(ev),
    severity: type === 'Warning' ? 'warning' : 'info',
  };
}

async function collectEvents(client, clusterId, maxEvents) {
  let res = await client.softListAll('/apis/events.k8s.io/v1/events', { pageSize: 500 });
  if (res.error) {
    res = await client.softListAll('/api/v1/events', { pageSize: 500 });
  }
  let events = res.items.map((e) => normalize(e, clusterId));

  // Sort priority + recency, then cap.
  events.sort((a, b) => {
    const pa = PRIORITY_REASONS.has(a.reason) || a.type === 'Warning' ? 1 : 0;
    const pb = PRIORITY_REASONS.has(b.reason) || b.type === 'Warning' ? 1 : 0;
    if (pa !== pb) return pb - pa;
    return new Date(b.lastTimestamp || 0) - new Date(a.lastTimestamp || 0);
  });
  let truncated = false;
  if (events.length > maxEvents) {
    events = events.slice(0, maxEvents);
    truncated = true;
  }

  return {
    events,
    truncated,
    errors: res.error ? [{ kind: 'events', ...res.error }] : [],
  };
}

module.exports = { collectEvents, PRIORITY_REASONS };
