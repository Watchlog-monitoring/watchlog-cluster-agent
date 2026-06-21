/**
 * Topology graph builder. Pure + deterministic + O(N).
 *
 * Input: a normalized inventory (resources already carry uid/name/namespace/
 * health/status and relationship hints such as ownerReferences, nodeName,
 * volumes, matchedPodUids, backendServiceUids).
 *
 * Output: { nodes, edges } where node.id is a STABLE, human-readable id of the
 * form "<type>/<namespace>/<name>" (namespace omitted for cluster-scoped
 * resources). Stable ids let the UI diff/animate across snapshots.
 *
 * Edges are derived purely from data already on the resources:
 *   owns         ownerReferences (Deployment→RS, RS→Pod, STS/DS/Job→Pod, CronJob→Job)
 *   belongs_to   namespace membership + Cluster→Namespace
 *   schedules    Node→Pod via pod.nodeName
 *   selects      Service→Pod via precomputed matchedPodUids
 *   routes_to    Ingress→Service via backendServiceUids (broken if missing)
 *   mounts       Pod→PVC (pod.volumes), PVC→PV (pvc.volumeName)
 */

const CLUSTER_TYPE = 'cluster';

function nsPart(ns) {
  return ns || '_';
}

function nodeId(type, namespace, name) {
  // Cluster-scoped types have no namespace in their id.
  if (['cluster', 'node', 'pv', 'namespace'].includes(type)) {
    return `${type}/${name}`;
  }
  return `${type}/${nsPart(namespace)}/${name}`;
}

function edgeId(type, source, target) {
  return `${type}:${source}->${target}`;
}

function toNode(type, r, parentId) {
  return {
    id: nodeId(type, r.namespace, r.name),
    type,
    name: r.name,
    namespace: r.namespace || null,
    status: r.status != null ? r.status : r.phase || null,
    health: r.health || 'unknown',
    labels: r.labels || {},
    uid: r.uid || null,
    reason: r.reason || null, // health reason ("why") so the UI can explain the state
    metrics: {
      ...(r.metrics || (r.usage ? { ...r.usage } : {})),
      ...(r.restarts != null ? { restarts: r.restarts } : {}),
    },
    // carry identifiers the UI needs to deep-link (e.g. pod -> NodeDetails/PodDetails)
    metadata: {
      ...(r.topoMeta || {}),
      ...(r.nodeName ? { nodeName: r.nodeName } : {}),
      ...(r.age && r.age.humanReadable ? { age: r.age.humanReadable } : {}),
    },
    parentId: parentId || null,
  };
}

/**
 * @param {object} inv normalized inventory
 * @returns {{nodes: object[], edges: object[]}}
 */
function buildTopology(inv) {
  const nodes = [];
  const edges = [];
  const seenNode = new Set();
  const seenEdge = new Set();

  // uid -> topology node id, so ownerReferences (which use uids) can resolve.
  const uidToId = new Map();
  // service uid -> id (for ingress routes_to), pv name -> id, pvc key -> id.
  const pvByName = new Map();
  const pvcByKey = new Map(); // `${namespace}/${name}` -> id

  function addNode(type, r, parentId) {
    const n = toNode(type, r, parentId);
    if (!seenNode.has(n.id)) {
      seenNode.add(n.id);
      nodes.push(n);
    }
    if (r.uid) uidToId.set(r.uid, n.id);
    return n.id;
  }

  function addEdge(type, source, target, extra = {}) {
    if (!source || !target) return;
    const id = edgeId(type, source, target);
    if (seenEdge.has(id)) return;
    seenEdge.add(id);
    edges.push({
      id,
      source,
      target,
      type,
      status: extra.status || 'ok',
      metrics: extra.metrics || {},
      metadata: extra.metadata || {},
    });
  }

  // 1) Cluster root.
  const clusterNode = {
    id: nodeId(CLUSTER_TYPE, null, inv.clusterName || inv.clusterId),
    type: CLUSTER_TYPE,
    name: inv.clusterName || inv.clusterId,
    namespace: null,
    status: 'Active',
    health: inv.clusterHealth || 'unknown',
    labels: {},
    metrics: inv.clusterMetrics || {},
    metadata: { clusterId: inv.clusterId },
    parentId: null,
  };
  nodes.push(clusterNode);
  seenNode.add(clusterNode.id);
  const clusterId = clusterNode.id;

  // 2) Namespaces (Cluster -> Namespace).
  const nsId = {};
  for (const ns of inv.namespaces || []) {
    const id = addNode('namespace', ns, clusterId);
    nsId[ns.name] = id;
    addEdge('belongs_to', id, clusterId);
  }
  // Ensure a namespace node exists even if a namespace list was missing.
  function ensureNs(name) {
    if (!name) return clusterId;
    if (nsId[name]) return nsId[name];
    const id = addNode('namespace', { name, status: 'Active', health: 'unknown' }, clusterId);
    nsId[name] = id;
    addEdge('belongs_to', id, clusterId);
    return id;
  }

  // 3) Physical nodes (cluster-scoped).
  const physNodeId = {};
  for (const n of inv.nodes || []) {
    const id = addNode('node', n, clusterId);
    physNodeId[n.name] = id;
  }

  // 4) Workloads. parentId = namespace; owner edges resolved in pass 8.
  const wl = inv.workloads || {};
  const workloadKinds = [
    ['deployment', wl.deployments],
    ['statefulset', wl.statefulSets],
    ['daemonset', wl.daemonSets],
    ['replicaset', wl.replicaSets],
    ['job', wl.jobs],
    ['cronjob', wl.cronJobs],
  ];
  for (const [type, list] of workloadKinds) {
    for (const r of list || []) {
      const parent = ensureNs(r.namespace);
      const id = addNode(type, r, parent);
      addEdge('belongs_to', id, parent);
    }
  }

  // 5) PVs (cluster-scoped).
  for (const pv of inv.persistentVolumes || []) {
    const id = addNode('pv', pv, clusterId);
    pvByName.set(pv.name, id);
  }

  // 6) PVCs.
  for (const pvc of inv.persistentVolumeClaims || []) {
    const parent = ensureNs(pvc.namespace);
    const id = addNode('pvc', pvc, parent);
    pvcByKey.set(`${pvc.namespace}/${pvc.name}`, id);
    addEdge('belongs_to', id, parent);
    // PVC -> PV
    if (pvc.volumeName && pvByName.has(pvc.volumeName)) {
      addEdge('mounts', id, pvByName.get(pvc.volumeName));
    }
  }

  // 7) Pods.
  for (const pod of inv.pods || []) {
    const parent = ensureNs(pod.namespace);
    const id = addNode('pod', pod, parent);
    addEdge('belongs_to', id, parent);
    // Node -> Pod
    if (pod.nodeName && physNodeId[pod.nodeName]) {
      addEdge('schedules', physNodeId[pod.nodeName], id);
    }
    // Pod -> PVC
    for (const vol of pod.volumes || []) {
      if (vol.pvcName) {
        const pvcId = pvcByKey.get(`${pod.namespace}/${vol.pvcName}`);
        if (pvcId) addEdge('mounts', id, pvcId);
      }
    }
  }

  // 8) Owner edges (owns) for every resource carrying ownerReferences.
  //    Resolve via uid map; if owner uid unknown, mark target node orphan.
  function linkOwners(list, type) {
    for (const r of list || []) {
      const childId = nodeId(type, r.namespace, r.name);
      const owners = r.ownerReferences || [];
      let linked = false;
      for (const o of owners) {
        const ownerId = uidToId.get(o.uid);
        if (ownerId) {
          addEdge('owns', ownerId, childId);
          // Tighten parentId to the owner for tree layout.
          const node = nodes.find((n) => n.id === childId);
          if (node) node.parentId = ownerId;
          linked = true;
        }
      }
      if (owners.length && !linked) {
        const node = nodes.find((n) => n.id === childId);
        if (node) node.metadata.orphan = true;
      }
    }
  }
  linkOwners(inv.pods, 'pod');
  linkOwners(wl.replicaSets, 'replicaset');
  linkOwners(wl.jobs, 'job');
  // (Deployments own ReplicaSets, CronJobs own Jobs — both covered above by
  // walking the child's ownerReferences.)

  // 9) Service -> Pod (selects), and Ingress -> Service (routes_to).
  const podUidToId = new Map();
  for (const pod of inv.pods || []) {
    if (pod.uid) podUidToId.set(pod.uid, nodeId('pod', pod.namespace, pod.name));
  }
  const svcUidToId = new Map();
  for (const svc of inv.services || []) {
    const parent = ensureNs(svc.namespace);
    const id = addNode('service', svc, parent);
    if (svc.uid) svcUidToId.set(svc.uid, id);
    addEdge('belongs_to', id, parent);
    const matched = svc.matchedPodUids || [];
    for (const podUid of matched) {
      const podId = podUidToId.get(podUid);
      if (podId) {
        addEdge('selects', id, podId, {
          status: (svc.endpointsReady || 0) > 0 ? 'ok' : 'degraded',
        });
      }
    }
  }

  for (const ing of inv.ingresses || []) {
    const parent = ensureNs(ing.namespace);
    const id = addNode('ingress', ing, parent);
    addEdge('belongs_to', id, parent);
    for (const svcUid of ing.backendServiceUids || []) {
      const svcId = svcUidToId.get(svcUid);
      if (svcId) addEdge('routes_to', id, svcId);
    }
    for (const missing of ing.missingBackends || []) {
      // Represent a broken route to a non-existent service target.
      addEdge('routes_to', id, nodeId('service', ing.namespace, missing), {
        status: 'broken',
        metadata: { missing: true },
      });
    }
  }

  return { nodes, edges };
}

module.exports = { buildTopology, nodeId, edgeId };
