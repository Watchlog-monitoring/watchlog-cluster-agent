/**
 * Ingress collector. Backend service references are extracted; resolution to
 * actual service uids (and detection of missing backends) happens in the link
 * step where the full service list is available.
 */
const { calculateAge } = require('../units');

async function collectIngresses(client, now) {
  const { items, truncated, error } = await client.softListAll(
    '/apis/networking.k8s.io/v1/ingresses',
    { pageSize: 200 }
  );

  const ingresses = items.map((ing) => {
    const spec = ing.spec || {};
    const rules = (spec.rules || []).map((r) => ({
      host: r.host,
      paths: ((r.http && r.http.paths) || []).map((p) => ({
        path: p.path,
        pathType: p.pathType,
        serviceName: p.backend && p.backend.service && p.backend.service.name,
        servicePort:
          p.backend &&
          p.backend.service &&
          p.backend.service.port &&
          (p.backend.service.port.number || p.backend.service.port.name),
      })),
    }));
    // Collect the set of referenced backend service names (incl. defaultBackend).
    const backendServiceNames = new Set();
    for (const r of rules) {
      for (const p of r.paths) if (p.serviceName) backendServiceNames.add(p.serviceName);
    }
    if (spec.defaultBackend && spec.defaultBackend.service && spec.defaultBackend.service.name) {
      backendServiceNames.add(spec.defaultBackend.service.name);
    }
    return {
      uid: ing.metadata.uid,
      kind: 'ingress',
      name: ing.metadata.name,
      namespace: ing.metadata.namespace,
      labels: ing.metadata.labels || {},
      ingressClass: spec.ingressClassName,
      rules,
      tls: (spec.tls || []).map((t) => ({ hosts: t.hosts, secretName: t.secretName })),
      backendServiceNames: Array.from(backendServiceNames),
      backendServiceUids: [], // filled by link step
      missingBackends: [], // filled by link step
      loadBalancer: {
        ingress: ((ing.status && ing.status.loadBalancer && ing.status.loadBalancer.ingress) || []).map(
          (i) => i.ip || i.hostname
        ),
      },
      createdAt: ing.metadata.creationTimestamp,
      age: calculateAge(ing.metadata.creationTimestamp, now),
    };
  });

  return {
    ingresses,
    truncated,
    errors: error ? [{ kind: 'ingresses', ...error }] : [],
  };
}

module.exports = { collectIngresses };
