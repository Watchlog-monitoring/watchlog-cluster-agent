/**
 * Pod collector. Produces fully normalized pods (cores/bytes), including
 * per-container state/usage, owner references, and mounted PVC names (for
 * Pod→PVC topology edges). Health attached later.
 */
const { parseCpuCores, parseBytes, sumNullable, calculateAge } = require('../units');

function containerSpecMap(pod) {
  const map = {};
  for (const c of (pod.spec && pod.spec.containers) || []) map[c.name] = c;
  return map;
}

function containerStatusMap(pod) {
  const map = {};
  for (const s of (pod.status && pod.status.containerStatuses) || []) map[s.name] = s;
  return map;
}

function pvcNamesFromVolumes(pod) {
  const vols = [];
  for (const v of (pod.spec && pod.spec.volumes) || []) {
    if (v.persistentVolumeClaim && v.persistentVolumeClaim.claimName) {
      vols.push({ name: v.name, pvcName: v.persistentVolumeClaim.claimName });
    }
  }
  return vols;
}

async function collectPods(client, now, maxPods) {
  // Metadata only — runtime metrics are filled later from the Kubelet Summary API.
  const { items, truncated, error } = await client.softListAll('/api/v1/pods', {
    pageSize: 500,
    maxItems: maxPods,
  });

  const pods = items.map((pod) => {
    const specMap = containerSpecMap(pod);
    const statusMap = containerStatusMap(pod);

    const containers = ((pod.spec && pod.spec.containers) || []).map((c) => {
      const st = statusMap[c.name] || {};
      const state = st.state || {};
      let stateName = 'unknown';
      let waitingReason = null;
      if (state.running) stateName = 'running';
      else if (state.waiting) { stateName = 'waiting'; waitingReason = state.waiting.reason; }
      else if (state.terminated) stateName = 'terminated';
      const req = (c.resources && c.resources.requests) || {};
      const lim = (c.resources && c.resources.limits) || {};
      return {
        name: c.name,
        image: c.image,
        ready: !!st.ready,
        restartCount: st.restartCount || 0,
        state: stateName,
        waitingReason,
        lastTerminatedReason:
          st.lastState && st.lastState.terminated && st.lastState.terminated.reason,
        usage: null, // {cpuCores, memoryBytes} — filled from Kubelet Summary
        requests: { cpuCores: parseCpuCores(req.cpu), memoryBytes: parseBytes(req.memory) },
        limits: { cpuCores: parseCpuCores(lim.cpu), memoryBytes: parseBytes(lim.memory) },
      };
    });

    const statuses = (pod.status && pod.status.containerStatuses) || [];
    return {
      uid: pod.metadata.uid,
      kind: 'pod',
      name: pod.metadata.name,
      namespace: pod.metadata.namespace,
      nodeName: pod.spec && pod.spec.nodeName,
      labels: pod.metadata.labels || {},
      annotations: pod.metadata.annotations || {},
      ownerReferences: (pod.metadata.ownerReferences || []).map((o) => ({
        kind: o.kind,
        name: o.name,
        uid: o.uid,
      })),
      phase: pod.status && pod.status.phase,
      qosClass: pod.status && pod.status.qosClass,
      podIP: pod.status && pod.status.podIP,
      hostIP: pod.status && pod.status.hostIP,
      startTime: pod.status && pod.status.startTime,
      conditions: (pod.status && pod.status.conditions || []).map((c) => ({
        type: c.type,
        status: c.status,
        reason: c.reason,
        lastTransitionTime: c.lastTransitionTime,
      })),
      readyContainers: statuses.filter((c) => c.ready).length,
      totalContainers: statuses.length || containers.length,
      restarts: statuses.reduce((s, c) => s + (c.restartCount || 0), 0),
      containers,
      volumes: pvcNamesFromVolumes(pod),
      usage: null, // {cpuCores, memoryBytes} — filled from Kubelet Summary (back-compat)
      metrics: null, // {cpuUsageNanoCores, memoryWorkingSetBytes, networkRxBytes, networkTxBytes}
      requests: {
        cpuCores: sumNullable(containers.map((c) => c.requests.cpuCores)),
        memoryBytes: sumNullable(containers.map((c) => c.requests.memoryBytes)),
      },
      limits: {
        cpuCores: sumNullable(containers.map((c) => c.limits.cpuCores)),
        memoryBytes: sumNullable(containers.map((c) => c.limits.memoryBytes)),
      },
      createdAt: pod.metadata.creationTimestamp,
      age: calculateAge(pod.metadata.creationTimestamp, now),
    };
  });

  const errors = [];
  if (error) errors.push({ kind: 'pods', ...error });

  return { pods, truncated, errors };
}

module.exports = { collectPods };
