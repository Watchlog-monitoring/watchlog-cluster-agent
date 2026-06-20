/**
 * Shared, versioned Kubernetes snapshot schema + lightweight validator.
 *
 * This module is intentionally dependency-free so the exact same file can be
 * copied into server-agent for validation. The validator is permissive about
 * UNKNOWN extra keys (forward-compatibility) but strict about required keys and
 * the schemaVersion, so older consumers never break when new fields are added.
 *
 * Keep cluster-agent/app/k8s/schema.js and server-agent/k8s/schema.js identical.
 */

const SCHEMA_VERSION = 2;

const SNAPSHOT_TYPE = 'kubernetes_snapshot';
const CHUNK_TYPE = 'kubernetes_snapshot_chunk';

// Topology node types.
const NODE_TYPES = [
  'cluster', 'namespace', 'node',
  'deployment', 'replicaset', 'statefulset', 'daemonset', 'job', 'cronjob',
  'pod', 'service', 'ingress', 'pvc', 'pv',
];

// Topology edge types. `communicates_with` is reserved for future
// OpenTelemetry service maps / network flow data.
const EDGE_TYPES = [
  'owns', 'belongs_to', 'schedules', 'selects', 'routes_to', 'mounts',
  'communicates_with',
];

const HEALTH_VALUES = ['healthy', 'warning', 'critical', 'unknown'];

// Workload kinds carried under snapshot.workloads.
const WORKLOAD_KINDS = [
  'deployments', 'statefulSets', 'daemonSets', 'replicaSets', 'jobs', 'cronJobs',
];

/**
 * Validate a fully-assembled (de-chunked, decompressed) snapshot envelope.
 * Returns { valid: boolean, errors: string[] }.
 *
 * Strict on: type, schemaVersion, clusterId/clusterName, the presence of the
 * core arrays/objects with the right JS types. Lenient on nested fields and any
 * extra keys.
 */
function validateSnapshot(payload) {
  const errors = [];

  if (!payload || typeof payload !== 'object') {
    return { valid: false, errors: ['payload is not an object'] };
  }

  if (payload.type !== SNAPSHOT_TYPE) {
    errors.push(`type must be "${SNAPSHOT_TYPE}", got "${payload.type}"`);
  }

  if (payload.schemaVersion !== SCHEMA_VERSION) {
    errors.push(
      `schemaVersion must be ${SCHEMA_VERSION}, got ${payload.schemaVersion}`
    );
  }

  for (const key of ['clusterId', 'clusterName']) {
    if (typeof payload[key] !== 'string' || !payload[key]) {
      errors.push(`${key} must be a non-empty string`);
    }
  }

  if (typeof payload.timestamp !== 'string' || !payload.timestamp) {
    errors.push('timestamp must be a non-empty ISO string');
  }

  // Core collections must be the right shape if present.
  const arrayKeys = [
    'nodes', 'namespaces', 'pods', 'services', 'ingresses',
    'persistentVolumes', 'persistentVolumeClaims', 'events', 'logs',
  ];
  for (const key of arrayKeys) {
    if (payload[key] !== undefined && !Array.isArray(payload[key])) {
      errors.push(`${key} must be an array when present`);
    }
  }

  if (payload.summary !== undefined && typeof payload.summary !== 'object') {
    errors.push('summary must be an object when present');
  }

  if (payload.workloads !== undefined) {
    if (typeof payload.workloads !== 'object') {
      errors.push('workloads must be an object when present');
    } else {
      for (const k of WORKLOAD_KINDS) {
        if (payload.workloads[k] !== undefined && !Array.isArray(payload.workloads[k])) {
          errors.push(`workloads.${k} must be an array when present`);
        }
      }
    }
  }

  if (payload.topology !== undefined) {
    const t = payload.topology;
    if (typeof t !== 'object' || t === null) {
      errors.push('topology must be an object when present');
    } else {
      if (t.nodes !== undefined && !Array.isArray(t.nodes)) {
        errors.push('topology.nodes must be an array when present');
      }
      if (t.edges !== undefined && !Array.isArray(t.edges)) {
        errors.push('topology.edges must be an array when present');
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Validate a chunk wrapper (one piece of a chunked snapshot).
 */
function validateChunk(chunk) {
  const errors = [];
  if (!chunk || typeof chunk !== 'object') {
    return { valid: false, errors: ['chunk is not an object'] };
  }
  if (chunk.type !== CHUNK_TYPE) {
    errors.push(`type must be "${CHUNK_TYPE}"`);
  }
  for (const key of ['snapshotId', 'clusterId']) {
    if (typeof chunk[key] !== 'string' || !chunk[key]) {
      errors.push(`${key} must be a non-empty string`);
    }
  }
  for (const key of ['seq', 'total']) {
    if (!Number.isInteger(chunk[key]) || chunk[key] < 0) {
      errors.push(`${key} must be a non-negative integer`);
    }
  }
  if (chunk.data === undefined || chunk.data === null) {
    errors.push('data is required');
  }
  return { valid: errors.length === 0, errors };
}

module.exports = {
  SCHEMA_VERSION,
  SNAPSHOT_TYPE,
  CHUNK_TYPE,
  NODE_TYPES,
  EDGE_TYPES,
  HEALTH_VALUES,
  WORKLOAD_KINDS,
  validateSnapshot,
  validateChunk,
};
