/**
 * Optional, bounded pod-log collector. OFF by default (K8S_COLLECT_LOGS).
 *
 * To avoid overloading large clusters, when enabled it only fetches a short
 * tail for pods that look unhealthy (non-Running or with restarts), capped by
 * a pod budget and run with limited concurrency. This is intentionally
 * conservative; live streaming remains a separate future path (watchPods.js).
 */
const SEVERITY_RE = /\b(ERROR|WARN(?:ING)?|INFO|DEBUG|TRACE|FATAL)\b/i;
// klog/glog prefix used by most Kubernetes components, e.g. "I0619 21:12:59.518".
const KLOG_RE = /^([IWEF])\d{4}\s/;
const KLOG_MAP = { I: 'INFO', W: 'WARNING', E: 'ERROR', F: 'FATAL' };

function severityOf(line) {
  const klog = line.match(KLOG_RE);
  if (klog) return KLOG_MAP[klog[1]];
  const m = line.match(SEVERITY_RE);
  if (!m) return 'UNKNOWN';
  const s = m[1].toUpperCase();
  return s === 'WARN' ? 'WARNING' : s;
}

async function tailPodLog(client, pod, tailLines) {
  const container = (pod.containers && pod.containers[0] && pod.containers[0].name) || undefined;
  const path = `/api/v1/namespaces/${pod.namespace}/pods/${pod.name}/log`;
  try {
    const res = await client.http.get(path, {
      params: { tailLines, timestamps: true, container },
      responseType: 'text',
      transformResponse: [(d) => d],
    });
    const lines = String(res.data || '')
      .split('\n')
      .filter(Boolean);
    return lines.map((line) => {
      const spaceIdx = line.indexOf(' ');
      const ts = spaceIdx > 0 ? line.slice(0, spaceIdx) : null;
      const message = spaceIdx > 0 ? line.slice(spaceIdx + 1) : line;
      return {
        clusterId: null, // filled by caller
        namespace: pod.namespace,
        podName: pod.name,
        containerName: container || null,
        nodeName: pod.nodeName || null,
        timestamp: ts || pod.startTime,
        message,
        severity: severityOf(message),
      };
    });
  } catch (err) {
    return [];
  }
}

async function collectLogs(client, pods, clusterId, opts) {
  const { logLines = 100, maxPods = 50, concurrency = 5 } = opts || {};
  // Prioritize unhealthy pods.
  const candidates = pods
    .filter((p) => p.phase !== 'Succeeded')
    .filter((p) => p.health === 'critical' || p.health === 'warning' || (p.restarts || 0) > 0)
    .slice(0, maxPods);

  const out = [];
  let idx = 0;
  async function worker() {
    /* eslint-disable no-await-in-loop */
    while (idx < candidates.length) {
      const pod = candidates[idx++];
      const lines = await tailPodLog(client, pod, logLines);
      for (const l of lines) {
        l.clusterId = clusterId;
        out.push(l);
      }
    }
    /* eslint-enable no-await-in-loop */
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, candidates.length) }, worker));
  return { logs: out, errors: [] };
}

module.exports = { collectLogs, severityOf };
