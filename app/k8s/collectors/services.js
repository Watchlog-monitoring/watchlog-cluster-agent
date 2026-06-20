/**
 * Service collector + Endpoints collector. The Service→Pod selector match and
 * endpoint readiness counts are resolved here so the health engine and topology
 * builder can consume precomputed matchedPodUids / endpointsReady.
 */
const { calculateAge } = require('../units');

async function collectServices(client, now) {
  const svcRes = await client.softListAll('/api/v1/services', { pageSize: 300 });
  const epRes = await client.softListAll('/api/v1/endpoints', { pageSize: 300 });

  // Endpoints share name+namespace with their Service.
  const epByKey = {};
  for (const ep of epRes.items) {
    const key = `${ep.metadata.namespace}/${ep.metadata.name}`;
    let ready = 0;
    let notReady = 0;
    for (const sub of ep.subsets || []) {
      ready += (sub.addresses || []).length;
      notReady += (sub.notReadyAddresses || []).length;
    }
    epByKey[key] = { ready, total: ready + notReady };
  }

  const services = svcRes.items.map((svc) => {
    const spec = svc.spec || {};
    const key = `${svc.metadata.namespace}/${svc.metadata.name}`;
    const ep = epByKey[key] || { ready: 0, total: 0 };
    return {
      uid: svc.metadata.uid,
      kind: 'service',
      name: svc.metadata.name,
      namespace: svc.metadata.namespace,
      labels: svc.metadata.labels || {},
      type: spec.type || 'ClusterIP',
      clusterIP: spec.clusterIP,
      externalIPs: spec.externalIPs || [],
      ports: (spec.ports || []).map((p) => ({
        name: p.name,
        port: p.port,
        targetPort: p.targetPort,
        protocol: p.protocol,
        nodePort: p.nodePort,
      })),
      selector: spec.selector || {},
      endpointsReady: ep.ready,
      endpointsTotal: ep.total,
      matchedPodUids: [], // filled by link step (needs pods)
      loadBalancer: {
        ingress: ((svc.status && svc.status.loadBalancer && svc.status.loadBalancer.ingress) || []).map(
          (i) => i.ip || i.hostname
        ),
      },
      createdAt: svc.metadata.creationTimestamp,
      age: calculateAge(svc.metadata.creationTimestamp, now),
    };
  });

  return {
    services,
    errors: [svcRes.error, epRes.error]
      .filter(Boolean)
      .map((e) => ({ kind: 'services', ...e })),
  };
}

module.exports = { collectServices };
