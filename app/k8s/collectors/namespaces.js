/**
 * Namespace collector. Health is rolled up later from member resources.
 */
const { calculateAge } = require('../units');

async function collectNamespaces(client, now) {
  const { items, truncated, error } = await client.softListAll('/api/v1/namespaces', {
    pageSize: 200,
  });
  const namespaces = items.map((ns) => ({
    uid: ns.metadata.uid,
    kind: 'namespace',
    name: ns.metadata.name,
    namespace: null,
    status: ns.status && ns.status.phase, // Active | Terminating
    labels: ns.metadata.labels || {},
    annotations: ns.metadata.annotations || {},
    podsTotal: 0, // filled by link step
    createdAt: ns.metadata.creationTimestamp,
    age: calculateAge(ns.metadata.creationTimestamp, now),
  }));
  return {
    namespaces,
    truncated,
    errors: error ? [{ kind: 'namespaces', ...error }] : [],
  };
}

module.exports = { collectNamespaces };
