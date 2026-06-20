/**
 * Node collector. Returns normalized node objects (cores/bytes), plus the raw
 * metrics availability so the snapshot can flag `partial` when metrics-server
 * is down. Health is attached later, after pod counts are known.
 */
const { parseCpuCores, parseBytes, parseIntSafe, calculateAge } = require('../units');

function rolesFromLabels(labels = {}) {
  const roles = [];
  for (const key of Object.keys(labels)) {
    const m = key.match(/^node-role\.kubernetes\.io\/(.+)$/);
    if (m) roles.push(m[1] || 'worker');
  }
  return roles.length ? roles : ['worker'];
}

async function collectNodes(client, now) {
  // Metadata only — runtime metrics are filled later from the Kubelet Summary API.
  const { items, truncated, error } = await client.softListAll('/api/v1/nodes', {
    pageSize: 200,
  });

  const nodes = items.map((node) => {
    const cap = node.status.capacity || {};
    const alloc = node.status.allocatable || {};
    return {
      uid: node.metadata.uid,
      kind: 'node',
      name: node.metadata.name,
      namespace: null,
      labels: node.metadata.labels || {},
      annotations: node.metadata.annotations || {},
      roles: rolesFromLabels(node.metadata.labels),
      status: (node.status.conditions || []).find((c) => c.type === 'Ready')
        ? (node.status.conditions.find((c) => c.type === 'Ready').status === 'True'
            ? 'Ready'
            : 'NotReady')
        : 'Unknown',
      conditions: (node.status.conditions || []).map((c) => ({
        type: c.type,
        status: c.status,
        reason: c.reason,
        message: c.message,
        lastTransitionTime: c.lastTransitionTime,
      })),
      taints: (node.spec && node.spec.taints) || [],
      nodeInfo: node.status.nodeInfo || {},
      capacity: {
        cpuCores: parseCpuCores(cap.cpu),
        memoryBytes: parseBytes(cap.memory),
        pods: parseIntSafe(cap.pods),
        ephemeralStorageBytes: parseBytes(cap['ephemeral-storage']),
      },
      allocatable: {
        cpuCores: parseCpuCores(alloc.cpu),
        memoryBytes: parseBytes(alloc.memory),
        pods: parseIntSafe(alloc.pods),
        ephemeralStorageBytes: parseBytes(alloc['ephemeral-storage']),
      },
      usage: null, // {cpuCores, memoryBytes} — filled from Kubelet Summary (back-compat)
      metrics: null, // {cpuUsageNanoCores, memoryWorkingSetBytes, fsUsedBytes, fsCapacityBytes} — filled from Kubelet Summary
      podsRunning: 0, // filled by link step
      podsTotal: 0,
      createdAt: node.metadata.creationTimestamp,
      age: calculateAge(node.metadata.creationTimestamp, now),
    };
  });

  const errors = [];
  if (error) errors.push({ kind: 'nodes', ...error });

  return { nodes, truncated, errors };
}

module.exports = { collectNodes };
