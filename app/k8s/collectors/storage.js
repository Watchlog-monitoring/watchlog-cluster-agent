/**
 * Storage collector: PersistentVolumes (cluster-scoped) and
 * PersistentVolumeClaims (namespaced). Pod→PVC mounts and PVC→PV binding are
 * derived in the topology builder from volumeName / pod volumes.
 */
const { parseBytes, calculateAge } = require('../units');

async function collectStorage(client, now) {
  const pvRes = await client.softListAll('/api/v1/persistentvolumes', { pageSize: 200 });
  const pvcRes = await client.softListAll('/api/v1/persistentvolumeclaims', { pageSize: 300 });

  const persistentVolumes = pvRes.items.map((pv) => {
    const spec = pv.spec || {};
    const cap = spec.capacity || {};
    let source = 'unknown';
    for (const k of ['csi', 'hostPath', 'nfs', 'local', 'awsElasticBlockStore', 'gcePersistentDisk']) {
      if (spec[k]) { source = k; break; }
    }
    return {
      uid: pv.metadata.uid,
      kind: 'pv',
      name: pv.metadata.name,
      namespace: null,
      labels: pv.metadata.labels || {},
      status: pv.status && pv.status.phase, // Available|Bound|Released|Failed
      capacityBytes: parseBytes(cap.storage),
      storageClass: spec.storageClassName,
      accessModes: spec.accessModes || [],
      reclaimPolicy: spec.persistentVolumeReclaimPolicy,
      claimRef: spec.claimRef
        ? { namespace: spec.claimRef.namespace, name: spec.claimRef.name, uid: spec.claimRef.uid }
        : null,
      source,
      createdAt: pv.metadata.creationTimestamp,
      age: calculateAge(pv.metadata.creationTimestamp, now),
    };
  });

  const persistentVolumeClaims = pvcRes.items.map((pvc) => {
    const spec = pvc.spec || {};
    const status = pvc.status || {};
    return {
      uid: pvc.metadata.uid,
      kind: 'pvc',
      name: pvc.metadata.name,
      namespace: pvc.metadata.namespace,
      labels: pvc.metadata.labels || {},
      status: status.phase, // Bound|Pending|Lost
      volumeName: spec.volumeName,
      storageClass: spec.storageClassName,
      accessModes: spec.accessModes || [],
      capacityBytes: parseBytes(status.capacity && status.capacity.storage),
      requestBytes: parseBytes(
        spec.resources && spec.resources.requests && spec.resources.requests.storage
      ),
      mountedByPodUids: [], // filled by link step
      createdAt: pvc.metadata.creationTimestamp,
      age: calculateAge(pvc.metadata.creationTimestamp, now),
    };
  });

  return {
    persistentVolumes,
    persistentVolumeClaims,
    errors: [pvRes.error, pvcRes.error].filter(Boolean).map((e) => ({ kind: 'storage', ...e })),
  };
}

module.exports = { collectStorage };
