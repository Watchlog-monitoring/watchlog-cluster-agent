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
  const { items, truncated, error } = await client.softListAll('/api/v1/pods', {
    pageSize: 500,
    maxItems: maxPods,
  });
  const metricsRes = await client.softListAll('/apis/metrics.k8s.io/v1beta1/pods', {
    pageSize: 500,
  });
  const usageByKey = {};
  for (const pm of metricsRes.items) {
    const key = `${pm.metadata.namespace}/${pm.metadata.name}`;
    const containers = {};
    for (const c of pm.containers || []) {
      containers[c.name] = {
        cpuCores: parseCpuCores(c.usage && c.usage.cpu),
        memoryBytes: parseBytes(c.usage && c.usage.memory),
      };
    }
    usageByKey[key] = containers;
  }

  const pods = items.map((pod) => {
    const key = `${pod.metadata.namespace}/${pod.metadata.name}`;
    const specMap = containerSpecMap(pod);
    const statusMap = containerStatusMap(pod);
    const usageMap = usageByKey[key] || {};
    const metricsAvailable = !metricsRes.error && usageByKey[key] !== undefined;

    const containers = ((pod.spec && pod.spec.containers) || []).map((c) => {
      const st = statusMap[c.name] || {};
      const usage = usageMap[c.name] || null;
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
        usage,
        requests: { cpuCores: parseCpuCores(req.cpu), memoryBytes: parseBytes(req.memory) },
        limits: { cpuCores: parseCpuCores(lim.cpu), memoryBytes: parseBytes(lim.memory) },
      };
    });

    const usageTotal = metricsAvailable
      ? {
          cpuCores: sumNullable(containers.map((c) => c.usage && c.usage.cpuCores)),
          memoryBytes: sumNullable(containers.map((c) => c.usage && c.usage.memoryBytes)),
        }
      : null;

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
      usage: usageTotal,
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
  if (metricsRes.error) errors.push({ kind: 'pod-metrics', ...metricsRes.error });

  return {
    pods,
    truncated,
    errors,
    metricsAvailable: !metricsRes.error,
  };
}

module.exports = { collectPods };
