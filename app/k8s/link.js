/**
 * Cross-reference / linking step. Pure. Runs after all collectors return raw
 * normalized resources but before health + topology, filling in the fields that
 * require visibility across resource kinds:
 *   - node.podsRunning / podsTotal
 *   - namespace.podsTotal
 *   - service.matchedPodUids (label-selector match within namespace)
 *   - ingress.backendServiceUids / missingBackends
 *   - pvc.mountedByPodUids
 */

function selectorMatches(selector, labels) {
  const keys = Object.keys(selector || {});
  if (keys.length === 0) return false; // empty selector matches nothing for our purposes
  return keys.every((k) => labels && labels[k] === selector[k]);
}

function linkInventory(inv) {
  const pods = inv.pods || [];

  // Node pod counts.
  const nodeRunning = {};
  const nodeTotal = {};
  const nsTotal = {};
  for (const pod of pods) {
    if (pod.nodeName) {
      nodeTotal[pod.nodeName] = (nodeTotal[pod.nodeName] || 0) + 1;
      if (pod.phase === 'Running') nodeRunning[pod.nodeName] = (nodeRunning[pod.nodeName] || 0) + 1;
    }
    if (pod.namespace) nsTotal[pod.namespace] = (nsTotal[pod.namespace] || 0) + 1;
  }
  for (const n of inv.nodes || []) {
    n.podsRunning = nodeRunning[n.name] || 0;
    n.podsTotal = nodeTotal[n.name] || 0;
  }
  for (const ns of inv.namespaces || []) {
    ns.podsTotal = nsTotal[ns.name] || 0;
  }

  // Index pods by namespace for selector matching.
  const podsByNs = {};
  for (const pod of pods) {
    (podsByNs[pod.namespace] = podsByNs[pod.namespace] || []).push(pod);
  }

  // Service -> Pod selector match.
  for (const svc of inv.services || []) {
    if (svc.type === 'ExternalName') continue;
    const candidates = podsByNs[svc.namespace] || [];
    svc.matchedPodUids = candidates
      .filter((p) => selectorMatches(svc.selector, p.labels))
      .map((p) => p.uid);
  }

  // Ingress -> Service resolution.
  const svcByKey = {};
  for (const svc of inv.services || []) {
    svcByKey[`${svc.namespace}/${svc.name}`] = svc;
  }
  for (const ing of inv.ingresses || []) {
    const uids = [];
    const missing = [];
    for (const name of ing.backendServiceNames || []) {
      const svc = svcByKey[`${ing.namespace}/${name}`];
      if (svc) uids.push(svc.uid);
      else missing.push(name);
    }
    ing.backendServiceUids = uids;
    ing.missingBackends = missing;
  }

  // PVC -> mounted-by pods.
  const pvcMounts = {};
  for (const pod of pods) {
    for (const vol of pod.volumes || []) {
      if (vol.pvcName) {
        const key = `${pod.namespace}/${vol.pvcName}`;
        (pvcMounts[key] = pvcMounts[key] || []).push(pod.uid);
      }
    }
  }
  for (const pvc of inv.persistentVolumeClaims || []) {
    pvc.mountedByPodUids = pvcMounts[`${pvc.namespace}/${pvc.name}`] || [];
  }

  return inv;
}

module.exports = { linkInventory, selectorMatches };
