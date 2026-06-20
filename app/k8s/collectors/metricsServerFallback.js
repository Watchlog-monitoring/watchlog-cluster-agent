/**
 * OPTIONAL metrics-server fallback. Disabled by default
 * (K8S_ENABLE_METRICS_SERVER_FALLBACK=false). Only used to fill gaps for nodes
 * whose Kubelet Summary call failed, and only when explicitly enabled. Never a
 * hard dependency: if metrics.k8s.io is absent, this returns empty maps without
 * throwing.
 */
const { parseCpuCores, parseBytes } = require('../units');

async function collectMetricsServer(client) {
  const nodeRes = await client.softListAll('/apis/metrics.k8s.io/v1beta1/nodes', { pageSize: 200 });
  const podRes = await client.softListAll('/apis/metrics.k8s.io/v1beta1/pods', { pageSize: 500 });

  const nodeMetricsByName = {};
  for (const m of nodeRes.items) {
    nodeMetricsByName[m.metadata.name] = {
      cpuUsageNanoCores: toNano(parseCpuCores(m.usage && m.usage.cpu)),
      memoryWorkingSetBytes: parseBytes(m.usage && m.usage.memory),
      fsUsedBytes: null,
      fsCapacityBytes: null,
      networkRxBytes: null,
      networkTxBytes: null,
    };
  }

  const podMetricsByKey = {};
  for (const pm of podRes.items) {
    const containers = {};
    for (const c of pm.containers || []) {
      containers[c.name] = {
        cpuUsageNanoCores: toNano(parseCpuCores(c.usage && c.usage.cpu)),
        memoryWorkingSetBytes: parseBytes(c.usage && c.usage.memory),
      };
    }
    const totalCpu = Object.values(containers).reduce((s, c) => s + (c.cpuUsageNanoCores || 0), 0);
    const totalMem = Object.values(containers).reduce((s, c) => s + (c.memoryWorkingSetBytes || 0), 0);
    podMetricsByKey[`${pm.metadata.namespace}/${pm.metadata.name}`] = {
      cpuUsageNanoCores: totalCpu || null,
      memoryWorkingSetBytes: totalMem || null,
      networkRxBytes: null,
      networkTxBytes: null,
      containers,
      volumes: [],
    };
  }

  return {
    nodeMetricsByName,
    podMetricsByKey,
    available: !nodeRes.error,
    error: nodeRes.error || podRes.error || null,
  };
}

function toNano(cores) {
  return cores == null ? null : Math.round(cores * 1e9);
}

module.exports = { collectMetricsServer };
