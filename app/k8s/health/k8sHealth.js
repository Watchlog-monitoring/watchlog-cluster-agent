/**
 * Health scoring engine. Pure + configurable + testable.
 *
 * Every evaluator takes a NORMALIZED resource (as produced by the collectors)
 * and returns { health, reason, signals }, where:
 *   health  ∈ "healthy" | "warning" | "critical" | "unknown"
 *   reason  short machine-ish string (e.g. "CrashLoopBackOff")
 *   signals array of human-readable facts that drove the verdict (for tooltips)
 *
 * Thresholds come from a config object so they are environment-overridable and
 * easy to assert in tests.
 */

const DEFAULT_CONFIG = {
  restartWarn: 5, // pod restarts >= this -> warning
  restartCrit: 20, // pod restarts >= this -> critical
};

// Container waiting reasons that indicate a hard failure.
const CRITICAL_WAITING_REASONS = new Set([
  'CrashLoopBackOff',
  'ImagePullBackOff',
  'ErrImagePull',
  'CreateContainerError',
  'CreateContainerConfigError',
  'InvalidImageName',
  'RunContainerError',
]);

const H = { HEALTHY: 'healthy', WARNING: 'warning', CRITICAL: 'critical', UNKNOWN: 'unknown' };

function result(health, reason, signals = []) {
  return { health, reason: reason || null, signals };
}

// --- Pod ---------------------------------------------------------------------
function evaluatePod(pod, cfg = DEFAULT_CONFIG) {
  const signals = [];
  const phase = pod.phase;

  // Look for a container stuck in a critical waiting reason.
  const containers = pod.containers || [];
  for (const c of containers) {
    if (c.waitingReason && CRITICAL_WAITING_REASONS.has(c.waitingReason)) {
      return result(H.CRITICAL, c.waitingReason, [`container ${c.name}: ${c.waitingReason}`]);
    }
    if (c.lastTerminatedReason === 'OOMKilled') {
      return result(H.CRITICAL, 'OOMKilled', [`container ${c.name} was OOMKilled`]);
    }
  }

  if (phase === 'Failed') return result(H.CRITICAL, 'Failed', ['pod phase Failed']);
  if (phase === 'Unknown' || !phase) return result(H.UNKNOWN, 'Unknown', ['pod phase unknown']);

  const restarts = pod.restarts || 0;
  if (restarts >= cfg.restartCrit) {
    return result(H.CRITICAL, 'HighRestarts', [`${restarts} restarts`]);
  }

  if (phase === 'Succeeded') return result(H.HEALTHY, 'Completed', ['pod Succeeded']);

  if (phase === 'Pending') {
    signals.push('pod Pending');
    return result(H.WARNING, 'Pending', signals);
  }

  // Running
  if (restarts >= cfg.restartWarn) {
    return result(H.WARNING, 'Restarts', [`${restarts} restarts`]);
  }
  if (pod.totalContainers && pod.readyContainers < pod.totalContainers) {
    return result(H.WARNING, 'NotAllReady', [
      `${pod.readyContainers}/${pod.totalContainers} containers ready`,
    ]);
  }
  return result(H.HEALTHY, 'Running', ['Running, all containers ready']);
}

// --- Node --------------------------------------------------------------------
function evaluateNode(node) {
  const conditions = node.conditions || [];
  const byType = {};
  for (const c of conditions) byType[c.type] = c.status;

  if (byType.Ready === undefined) return result(H.UNKNOWN, 'NoData', ['no Ready condition']);
  if (byType.Ready !== 'True') {
    return result(H.CRITICAL, 'NotReady', [`Ready=${byType.Ready}`]);
  }
  const pressures = ['MemoryPressure', 'DiskPressure', 'PIDPressure'].filter(
    (t) => byType[t] === 'True'
  );
  if (pressures.length) {
    return result(H.WARNING, pressures[0], pressures.map((p) => `${p}=True`));
  }
  return result(H.HEALTHY, 'Ready', ['Ready=True']);
}

// --- Deployment / StatefulSet / DaemonSet ------------------------------------
function evaluateWorkload(wl) {
  const r = wl.replicas || {};
  const desired = r.desired || 0;
  const available = r.available != null ? r.available : r.ready || 0;

  if (desired === 0) return result(H.HEALTHY, 'ScaledToZero', ['desired=0']);
  if (available === 0) {
    return result(H.CRITICAL, 'NoneAvailable', [`0/${desired} available`]);
  }
  if (available < desired) {
    return result(H.WARNING, 'Degraded', [`${available}/${desired} available`]);
  }
  return result(H.HEALTHY, 'Available', [`${available}/${desired} available`]);
}

// --- ReplicaSet --------------------------------------------------------------
function evaluateReplicaSet(rs) {
  const r = rs.replicas || {};
  const desired = r.desired || 0;
  const ready = r.ready || 0;
  if (desired === 0) return result(H.HEALTHY, 'Inactive', ['desired=0']);
  if (ready === 0) return result(H.CRITICAL, 'NoneReady', [`0/${desired} ready`]);
  if (ready < desired) return result(H.WARNING, 'Degraded', [`${ready}/${desired} ready`]);
  return result(H.HEALTHY, 'Ready', [`${ready}/${desired} ready`]);
}

// --- Job ---------------------------------------------------------------------
function evaluateJob(job) {
  const j = job.job || {};
  if (j.failed > 0) return result(H.CRITICAL, 'Failed', [`${j.failed} failed`]);
  if (j.succeeded > 0 && (j.active || 0) === 0) {
    return result(H.HEALTHY, 'Complete', [`${j.succeeded} succeeded`]);
  }
  if (j.active > 0) return result(H.WARNING, 'Active', [`${j.active} active`]);
  return result(H.UNKNOWN, 'Pending', ['no active/succeeded/failed']);
}

// --- CronJob -----------------------------------------------------------------
function evaluateCronJob(cj) {
  const c = cj.cronJob || {};
  if (c.suspend) return result(H.WARNING, 'Suspended', ['suspend=true']);
  if (!c.lastScheduleTime) return result(H.UNKNOWN, 'NeverScheduled', ['no lastScheduleTime']);
  return result(H.HEALTHY, 'Scheduled', [`last schedule ${c.lastScheduleTime}`]);
}

// --- Service -----------------------------------------------------------------
function evaluateService(svc) {
  if (svc.type === 'ExternalName') return result(H.HEALTHY, 'ExternalName', ['ExternalName']);
  const hasSelector = svc.selector && Object.keys(svc.selector).length > 0;
  const ready = svc.endpointsReady || 0;
  if (ready > 0) return result(H.HEALTHY, 'HasEndpoints', [`${ready} ready endpoints`]);
  if (hasSelector && (svc.matchedPodUids || []).length === 0) {
    return result(H.CRITICAL, 'NoMatchingPods', ['selector set but 0 matching pods']);
  }
  return result(H.WARNING, 'NoEndpoints', ['0 ready endpoints']);
}

// --- Ingress -----------------------------------------------------------------
function evaluateIngress(ing) {
  if ((ing.missingBackends || []).length > 0) {
    return result(H.CRITICAL, 'MissingBackend', [
      `missing services: ${ing.missingBackends.join(', ')}`,
    ]);
  }
  const lbReady = ing.loadBalancer && (ing.loadBalancer.ingress || []).length > 0;
  if (!lbReady) return result(H.WARNING, 'NoAddress', ['load balancer has no address yet']);
  return result(H.HEALTHY, 'Routed', ['all backends resolve']);
}

// --- PVC ---------------------------------------------------------------------
function evaluatePVC(pvc) {
  switch (pvc.status) {
    case 'Bound':
      return result(H.HEALTHY, 'Bound', ['Bound']);
    case 'Pending':
      return result(H.WARNING, 'Pending', ['Pending']);
    case 'Lost':
      return result(H.CRITICAL, 'Lost', ['Lost']);
    default:
      return result(H.UNKNOWN, 'Unknown', [`status ${pvc.status}`]);
  }
}

// --- PV ----------------------------------------------------------------------
function evaluatePV(pv) {
  switch (pv.status) {
    case 'Bound':
    case 'Available':
      return result(H.HEALTHY, pv.status, [pv.status]);
    case 'Released':
      return result(H.WARNING, 'Released', ['Released']);
    case 'Failed':
      return result(H.CRITICAL, 'Failed', ['Failed']);
    default:
      return result(H.UNKNOWN, 'Unknown', [`status ${pv.status}`]);
  }
}

// --- Roll-up (namespace / cluster) ------------------------------------------
const RANK = { healthy: 0, unknown: 1, warning: 2, critical: 3 };

/** Worst health across a list of health strings. Empty -> "healthy". */
function rollup(healths) {
  let worst = H.HEALTHY;
  for (const h of healths) {
    if (RANK[h] > RANK[worst]) worst = h;
  }
  return worst;
}

module.exports = {
  HEALTH: H,
  DEFAULT_CONFIG,
  evaluatePod,
  evaluateNode,
  evaluateWorkload,
  evaluateReplicaSet,
  evaluateJob,
  evaluateCronJob,
  evaluateService,
  evaluateIngress,
  evaluatePVC,
  evaluatePV,
  rollup,
};
