/**
 * Kubelet Summary API collector — the PRIMARY source of runtime metrics.
 *
 * Calls `GET /api/v1/nodes/{nodeName}/proxy/stats/summary` once per node per
 * collection cycle (via the API server proxy, so it works with the in-cluster
 * ServiceAccount and needs no metrics-server). Each request is bounded by a
 * timeout, requests run with a small concurrency limit, and there is NO
 * aggressive retry — a node that fails simply yields null metrics for that
 * cycle (metadata collection is unaffected).
 *
 * Returns:
 *   {
 *     nodeMetricsByName: { [nodeName]: {cpuUsageNanoCores, memoryWorkingSetBytes,
 *                                       fsUsedBytes, fsCapacityBytes,
 *                                       networkRxBytes, networkTxBytes} },
 *     podMetricsByKey:   { ["ns/name"]: {cpuUsageNanoCores, memoryWorkingSetBytes,
 *                                         networkRxBytes, networkTxBytes,
 *                                         containers: {name: {cpuUsageNanoCores, memoryWorkingSetBytes}},
 *                                         volumes: [{name, usedBytes, capacityBytes}]} },
 *     stats: { success, failure, failedNodes: [] }
 *   }
 */

function num(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function parseNodeSummary(summary) {
  const n = (summary && summary.node) || {};
  return {
    cpuUsageNanoCores: num(n.cpu && n.cpu.usageNanoCores),
    memoryWorkingSetBytes: num(n.memory && n.memory.workingSetBytes),
    fsUsedBytes: num(n.fs && n.fs.usedBytes),
    fsCapacityBytes: num(n.fs && n.fs.capacityBytes),
    networkRxBytes: num(n.network && n.network.rxBytes),
    networkTxBytes: num(n.network && n.network.txBytes),
  };
}

function parsePodSummaries(summary, podMetricsByKey) {
  for (const p of (summary && summary.pods) || []) {
    const ref = p.podRef || {};
    if (!ref.namespace || !ref.name) continue;
    const containers = {};
    for (const c of p.containers || []) {
      containers[c.name] = {
        cpuUsageNanoCores: num(c.cpu && c.cpu.usageNanoCores),
        memoryWorkingSetBytes: num(c.memory && c.memory.workingSetBytes),
      };
    }
    podMetricsByKey[`${ref.namespace}/${ref.name}`] = {
      cpuUsageNanoCores: num(p.cpu && p.cpu.usageNanoCores),
      memoryWorkingSetBytes: num(p.memory && p.memory.workingSetBytes),
      networkRxBytes: num(p.network && p.network.rxBytes),
      networkTxBytes: num(p.network && p.network.txBytes),
      containers,
      volumes: (p.volume || []).map((v) => ({
        name: v.name,
        usedBytes: num(v.usedBytes),
        capacityBytes: num(v.capacityBytes),
      })),
    };
  }
}

async function collectKubeletSummary(client, nodeNames, opts = {}) {
  const timeoutMs = opts.timeoutMs || 5000;
  const concurrency = Math.max(1, opts.concurrency || 3);

  const nodeMetricsByName = {};
  const podMetricsByKey = {};
  const failedNodes = [];
  let success = 0;
  let failure = 0;

  let idx = 0;
  async function worker() {
    /* eslint-disable no-await-in-loop */
    while (idx < nodeNames.length) {
      const nodeName = nodeNames[idx++];
      const path = `/api/v1/nodes/${encodeURIComponent(nodeName)}/proxy/stats/summary`;
      try {
        const res = await client.http.get(path, { timeout: timeoutMs });
        const summary = res.data || {};
        nodeMetricsByName[nodeName] = parseNodeSummary(summary);
        parsePodSummaries(summary, podMetricsByKey);
        success += 1;
      } catch (err) {
        failure += 1;
        failedNodes.push(nodeName);
        console.warn(
          `[k8s] kubelet summary failed for node "${nodeName}": ${err.message}` +
            (err.response ? ` (status ${err.response.status})` : '')
        );
      }
    }
    /* eslint-enable no-await-in-loop */
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, nodeNames.length) }, worker)
  );

  return { nodeMetricsByName, podMetricsByKey, stats: { success, failure, failedNodes } };
}

module.exports = { collectKubeletSummary, parseNodeSummary };
