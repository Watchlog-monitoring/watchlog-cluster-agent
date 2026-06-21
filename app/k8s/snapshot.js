/**
 * Snapshot assembler. Orchestrates the collectors with per-kind fault
 * isolation (Promise.allSettled), links cross-references, attaches health,
 * rolls up namespace + cluster health, computes the summary, builds the
 * topology graph, and returns the versioned envelope (schema PART C).
 */
const { SCHEMA_VERSION, SNAPSHOT_TYPE } = require('./schema');
const { collectNodes } = require('./collectors/nodes');
const { collectNamespaces } = require('./collectors/namespaces');
const { collectPods } = require('./collectors/pods');
const { collectWorkloads } = require('./collectors/workloads');
const { collectServices } = require('./collectors/services');
const { collectIngresses } = require('./collectors/ingresses');
const { collectStorage } = require('./collectors/storage');
const { collectEvents } = require('./collectors/events');
const { collectLogs } = require('./collectors/logs');
const { collectKubeletSummary } = require('./collectors/kubeletSummary');
const { collectMetricsServer } = require('./collectors/metricsServerFallback');
const { linkInventory } = require('./link');
const { buildTopology } = require('./topology/build');
const health = require('./health/k8sHealth');
const { sumNullable } = require('./units');

function getConfig(env = process.env) {
  return {
    collectEvents: env.K8S_COLLECT_EVENTS !== 'false',
    collectTopology: env.K8S_COLLECT_TOPOLOGY !== 'false',
    collectLogs: env.K8S_COLLECT_LOGS === 'true',
    logLines: parseInt(env.K8S_LOG_LINES || '100', 10),
    maxPods: parseInt(env.K8S_MAX_PODS || '1000', 10),
    maxEvents: parseInt(env.K8S_MAX_EVENTS || '500', 10),
    restartWindowMin: parseInt(env.K8S_RESTART_WINDOW_MIN || '30', 10),
    // Runtime metrics: Kubelet Summary API is the default/primary source.
    metricsSource: env.K8S_METRICS_SOURCE || 'kubelet_summary',
    kubeletTimeoutMs: parseInt(env.K8S_KUBELET_SUMMARY_TIMEOUT_MS || '5000', 10),
    kubeletConcurrency: parseInt(env.K8S_KUBELET_SUMMARY_CONCURRENCY || '3', 10),
    // metrics-server is an OPTIONAL fallback only, off by default.
    metricsServerFallback: env.K8S_ENABLE_METRICS_SERVER_FALLBACK === 'true',
  };
}

const nanoToCores = (n) => (n == null ? null : n / 1e9);

/**
 * Fill runtime metrics from the Kubelet Summary API (primary). For each node/pod
 * it sets the new `metrics` object AND the legacy `usage` ({cpuCores,memoryBytes})
 * for backward compatibility. metrics-server is consulted only to fill gaps and
 * only when explicitly enabled. Never throws — missing metrics => null.
 */
async function applyRuntimeMetrics(client, inv, cfg) {
  const nodeNames = inv.nodes.map((n) => n.name).filter(Boolean);
  let nodeMap = {};
  let podMap = {};
  let stats = { success: 0, failure: 0, failedNodes: [] };

  if (cfg.metricsSource !== 'none' && nodeNames.length) {
    try {
      const kube = await collectKubeletSummary(client, nodeNames, {
        timeoutMs: cfg.kubeletTimeoutMs,
        concurrency: cfg.kubeletConcurrency,
      });
      nodeMap = kube.nodeMetricsByName;
      podMap = kube.podMetricsByKey;
      stats = kube.stats;
    } catch (err) {
      console.warn('[k8s] kubelet summary collection failed entirely:', err.message);
    }
  }

  // Optional metrics-server fallback (off by default) — only fills gaps.
  let fallbackUsed = false;
  const missingNodes = nodeNames.filter((n) => !nodeMap[n]);
  if (cfg.metricsServerFallback && (missingNodes.length || stats.success === 0)) {
    try {
      const ms = await collectMetricsServer(client);
      if (ms.available) {
        fallbackUsed = true;
        for (const [k, v] of Object.entries(ms.nodeMetricsByName)) if (!nodeMap[k]) nodeMap[k] = v;
        for (const [k, v] of Object.entries(ms.podMetricsByKey)) if (!podMap[k]) podMap[k] = v;
      }
    } catch (err) {
      console.warn('[k8s] metrics-server fallback failed:', err.message);
    }
  }

  // Merge node metrics.
  for (const node of inv.nodes) {
    const m = nodeMap[node.name];
    if (m) {
      node.metrics = {
        cpuUsageNanoCores: m.cpuUsageNanoCores,
        memoryWorkingSetBytes: m.memoryWorkingSetBytes,
        fsUsedBytes: m.fsUsedBytes,
        fsCapacityBytes: m.fsCapacityBytes,
      };
      node.usage = {
        cpuCores: nanoToCores(m.cpuUsageNanoCores),
        memoryBytes: m.memoryWorkingSetBytes,
      };
    }
  }

  // Merge pod + container metrics.
  for (const pod of inv.pods) {
    const m = podMap[`${pod.namespace}/${pod.name}`];
    if (m) {
      pod.metrics = {
        cpuUsageNanoCores: m.cpuUsageNanoCores,
        memoryWorkingSetBytes: m.memoryWorkingSetBytes,
        networkRxBytes: m.networkRxBytes,
        networkTxBytes: m.networkTxBytes,
      };
      pod.usage = {
        cpuCores: nanoToCores(m.cpuUsageNanoCores),
        memoryBytes: m.memoryWorkingSetBytes,
      };
      for (const c of pod.containers || []) {
        const cm = m.containers && m.containers[c.name];
        if (cm) c.usage = { cpuCores: nanoToCores(cm.cpuUsageNanoCores), memoryBytes: cm.memoryWorkingSetBytes };
      }
    }
  }

  return {
    source: cfg.metricsSource,
    kubeletSuccess: stats.success,
    kubeletFailure: stats.failure,
    failedNodes: stats.failedNodes,
    nodesWithoutMetrics: inv.nodes.filter((n) => !n.metrics).map((n) => n.name),
    fallbackEnabled: cfg.metricsServerFallback,
    fallbackUsed,
  };
}

// Run a collector promise safely; on rejection return a fallback + error note.
async function settle(label, promise, fallback) {
  try {
    return await promise;
  } catch (err) {
    return { ...fallback, errors: [{ kind: label, message: err.message }] };
  }
}

/** Derive a stable clusterId from the cluster name + kube-system namespace uid. */
function deriveClusterId(clusterName, namespaces) {
  const kubeSystem = (namespaces || []).find((n) => n.name === 'kube-system');
  const suffix = kubeSystem && kubeSystem.uid ? kubeSystem.uid.slice(0, 8) : 'nouid';
  return `${clusterName}:${suffix}`;
}

function attachHealth(inv, cfg, now = new Date()) {
  for (const p of inv.pods) Object.assign(p, health.evaluatePod(p, cfg, now));
  for (const n of inv.nodes) Object.assign(n, health.evaluateNode(n));
  const wl = inv.workloads;
  for (const d of wl.deployments) Object.assign(d, health.evaluateWorkload(d));
  for (const s of wl.statefulSets) Object.assign(s, health.evaluateWorkload(s));
  for (const d of wl.daemonSets) Object.assign(d, health.evaluateWorkload(d));
  for (const r of wl.replicaSets) Object.assign(r, health.evaluateReplicaSet(r));
  for (const j of wl.jobs) Object.assign(j, health.evaluateJob(j));
  for (const c of wl.cronJobs) Object.assign(c, health.evaluateCronJob(c));
  for (const s of inv.services) Object.assign(s, health.evaluateService(s));
  for (const i of inv.ingresses) Object.assign(i, health.evaluateIngress(i));
  for (const pvc of inv.persistentVolumeClaims) Object.assign(pvc, health.evaluatePVC(pvc));
  for (const pv of inv.persistentVolumes) Object.assign(pv, health.evaluatePV(pv));

  // Namespace roll-up = worst of its member resources.
  const byNs = {};
  const push = (r) => {
    if (!r.namespace) return;
    (byNs[r.namespace] = byNs[r.namespace] || []).push(r.health);
  };
  inv.pods.forEach(push);
  [].concat(wl.deployments, wl.statefulSets, wl.daemonSets, wl.jobs, wl.cronJobs).forEach(push);
  inv.services.forEach(push);
  inv.ingresses.forEach(push);
  inv.persistentVolumeClaims.forEach(push);
  for (const ns of inv.namespaces) {
    ns.health = health.rollup(byNs[ns.name] || []);
  }
  inv.clusterHealth = health.rollup(inv.namespaces.map((n) => n.health).concat(inv.nodes.map((n) => n.health)));
}

function buildSummary(inv) {
  const pods = inv.pods;
  const byPhase = (ph) => pods.filter((p) => p.phase === ph).length;
  const countHealth = (val) => {
    let c = 0;
    const lists = [inv.nodes, pods, inv.services, inv.ingresses, inv.persistentVolumeClaims,
      inv.workloads.deployments, inv.workloads.statefulSets, inv.workloads.daemonSets];
    for (const list of lists) for (const r of list) if (r.health === val) c++;
    return c;
  };
  return {
    nodesTotal: inv.nodes.length,
    nodesReady: inv.nodes.filter((n) => n.status === 'Ready').length,
    namespacesTotal: inv.namespaces.length,
    podsTotal: pods.length,
    podsRunning: byPhase('Running'),
    podsPending: byPhase('Pending'),
    podsFailed: byPhase('Failed'),
    podsSucceeded: byPhase('Succeeded'),
    podsUnknown: pods.filter((p) => !p.phase || p.phase === 'Unknown').length,
    deploymentsTotal: inv.workloads.deployments.length,
    statefulSetsTotal: inv.workloads.statefulSets.length,
    daemonSetsTotal: inv.workloads.daemonSets.length,
    replicaSetsTotal: inv.workloads.replicaSets.length,
    jobsTotal: inv.workloads.jobs.length,
    cronJobsTotal: inv.workloads.cronJobs.length,
    servicesTotal: inv.services.length,
    ingressesTotal: inv.ingresses.length,
    pvTotal: inv.persistentVolumes.length,
    pvcTotal: inv.persistentVolumeClaims.length,
    cpu: {
      usageCores: sumNullable(inv.nodes.map((n) => n.usage && n.usage.cpuCores)),
      capacityCores: sumNullable(inv.nodes.map((n) => n.capacity && n.capacity.cpuCores)),
      requestsCores: sumNullable(pods.map((p) => p.requests && p.requests.cpuCores)),
      limitsCores: sumNullable(pods.map((p) => p.limits && p.limits.cpuCores)),
    },
    memory: {
      usageBytes: sumNullable(inv.nodes.map((n) => n.usage && n.usage.memoryBytes)),
      capacityBytes: sumNullable(inv.nodes.map((n) => n.capacity && n.capacity.memoryBytes)),
      requestsBytes: sumNullable(pods.map((p) => p.requests && p.requests.memoryBytes)),
      limitsBytes: sumNullable(pods.map((p) => p.limits && p.limits.memoryBytes)),
    },
    restartCount: pods.reduce((s, p) => s + (p.restarts || 0), 0),
    warningCount: countHealth('warning'),
    criticalCount: countHealth('critical'),
    health: inv.clusterHealth,
  };
}

/**
 * Build a full snapshot.
 * @param {object} client  from createClient()
 * @param {string} clusterName
 * @param {string} apiKey
 * @param {object} env
 * @param {Date}   now (injectable for tests)
 */
async function buildSnapshot(client, clusterName, apiKey, env = process.env, now = new Date()) {
  const cfg = getConfig(env);
  const startedAt = Date.now ? undefined : undefined; // duration computed by caller; avoid Date.now in tests
  const errors = [];
  const flags = { truncated: false };

  const [nodesR, nsR, podsR, wlR, svcR, ingR, stoR] = await Promise.all([
    settle('nodes', collectNodes(client, now), { nodes: [], metricsAvailable: false }),
    settle('namespaces', collectNamespaces(client, now), { namespaces: [] }),
    settle('pods', collectPods(client, now, cfg.maxPods), { pods: [], metricsAvailable: false }),
    settle('workloads', collectWorkloads(client, now), {
      workloads: { deployments: [], statefulSets: [], daemonSets: [], replicaSets: [], jobs: [], cronJobs: [] },
    }),
    settle('services', collectServices(client, now), { services: [] }),
    settle('ingresses', collectIngresses(client, now), { ingresses: [] }),
    settle('storage', collectStorage(client, now), { persistentVolumes: [], persistentVolumeClaims: [] }),
  ]);

  for (const r of [nodesR, nsR, podsR, wlR, svcR, ingR, stoR]) {
    if (r.errors) errors.push(...r.errors);
    if (r.truncated) flags.truncated = true;
  }

  const clusterId = deriveClusterId(clusterName, nsR.namespaces);

  const inv = {
    clusterId,
    clusterName,
    nodes: nodesR.nodes,
    namespaces: nsR.namespaces,
    pods: podsR.pods,
    workloads: wlR.workloads,
    services: svcR.services,
    ingresses: ingR.ingresses,
    persistentVolumes: stoR.persistentVolumes,
    persistentVolumeClaims: stoR.persistentVolumeClaims,
  };

  linkInventory(inv);

  // Runtime metrics from the Kubelet Summary API (primary source — no
  // metrics-server dependency). Fills node/pod/container usage + metrics.
  const metricsInfo = await applyRuntimeMetrics(client, inv, cfg);
  console.log(
    `[k8s] metrics source=${metricsInfo.source} | kubelet ok=${metricsInfo.kubeletSuccess} ` +
      `fail=${metricsInfo.kubeletFailure} | nodes without metrics=${metricsInfo.nodesWithoutMetrics.length}` +
      (metricsInfo.nodesWithoutMetrics.length ? ` [${metricsInfo.nodesWithoutMetrics.join(', ')}]` : '') +
      ` | metrics-server fallback=${metricsInfo.fallbackEnabled ? (metricsInfo.fallbackUsed ? 'used' : 'enabled') : 'disabled'}`
  );
  if (metricsInfo.kubeletFailure > 0) {
    errors.push({ kind: 'kubelet-summary', message: `${metricsInfo.kubeletFailure} node(s) failed: ${metricsInfo.failedNodes.join(', ')}` });
  }

  attachHealth(inv, cfg, now);

  // Events (optional).
  let events = [];
  if (cfg.collectEvents) {
    const evR = await settle('events', collectEvents(client, clusterId, cfg.maxEvents), { events: [] });
    events = evR.events;
    if (evR.errors) errors.push(...evR.errors);
    if (evR.truncated) flags.truncated = true;
  }

  // Logs (optional, off by default).
  let logs = [];
  if (cfg.collectLogs) {
    const logR = await settle('logs', collectLogs(client, inv.pods, clusterId, {
      logLines: cfg.logLines,
    }), { logs: [] });
    logs = logR.logs;
    if (logR.errors) errors.push(...logR.errors);
  }

  // Topology.
  const topology = cfg.collectTopology
    ? buildTopology(inv)
    : { nodes: [], edges: [] };

  const summary = buildSummary(inv);

  return {
    type: SNAPSHOT_TYPE,
    schemaVersion: SCHEMA_VERSION,
    apiKey,
    clusterId,
    clusterName,
    timestamp: now.toISOString(),
    partial: errors.length > 0 || flags.truncated,
    errors,
    summary,
    nodes: inv.nodes,
    namespaces: inv.namespaces,
    workloads: inv.workloads,
    pods: inv.pods,
    services: inv.services,
    ingresses: inv.ingresses,
    persistentVolumes: inv.persistentVolumes,
    persistentVolumeClaims: inv.persistentVolumeClaims,
    events,
    logs,
    topology,
  };
}

module.exports = { buildSnapshot, getConfig, deriveClusterId, attachHealth, buildSummary };
