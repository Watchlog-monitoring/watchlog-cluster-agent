/**
 * Unit tests for the pure v2 Kubernetes pipeline modules.
 * Run with:  node --test
 * (Uses the Node built-in test runner — no extra dependencies.)
 */
const { test } = require('node:test');
const assert = require('node:assert');

const units = require('../app/k8s/units');
const health = require('../app/k8s/health/k8sHealth');
const { buildTopology } = require('../app/k8s/topology/build');
const { linkInventory, selectorMatches } = require('../app/k8s/link');
const { validateSnapshot, validateChunk, SCHEMA_VERSION } = require('../app/k8s/schema');

// --- units ------------------------------------------------------------------
test('parseCpuCores handles m/n/plain', () => {
  assert.strictEqual(units.parseCpuCores('500m'), 0.5);
  assert.strictEqual(units.parseCpuCores('2'), 2);
  assert.strictEqual(units.parseCpuCores('250000000n'), 0.25);
  assert.strictEqual(units.parseCpuCores(null), null);
});

test('parseBytes handles Ki/Mi/Gi/plain', () => {
  assert.strictEqual(units.parseBytes('128Mi'), 128 * 1024 * 1024);
  assert.strictEqual(units.parseBytes('1Gi'), 1024 ** 3);
  assert.strictEqual(units.parseBytes('1000'), 1000);
  assert.strictEqual(units.parseBytes('1k'), 1000);
  assert.strictEqual(units.parseBytes(undefined), null);
});

// --- health -----------------------------------------------------------------
test('pod health: CrashLoopBackOff is critical', () => {
  const r = health.evaluatePod({
    phase: 'Running',
    containers: [{ name: 'c', waitingReason: 'CrashLoopBackOff' }],
  });
  assert.strictEqual(r.health, 'critical');
  assert.strictEqual(r.reason, 'CrashLoopBackOff');
});

test('pod health: high restarts warns, very high is critical', () => {
  const cfg = health.DEFAULT_CONFIG;
  assert.strictEqual(
    health.evaluatePod({ phase: 'Running', restarts: 6, readyContainers: 1, totalContainers: 1, containers: [] }, cfg).health,
    'warning'
  );
  assert.strictEqual(
    health.evaluatePod({ phase: 'Running', restarts: 50, containers: [] }, cfg).health,
    'critical'
  );
});

test('pod health: running + all ready is healthy', () => {
  const r = health.evaluatePod({ phase: 'Running', restarts: 0, readyContainers: 2, totalContainers: 2, containers: [] });
  assert.strictEqual(r.health, 'healthy');
});

test('node health: NotReady critical, pressure warns', () => {
  assert.strictEqual(health.evaluateNode({ conditions: [{ type: 'Ready', status: 'False' }] }).health, 'critical');
  assert.strictEqual(
    health.evaluateNode({ conditions: [{ type: 'Ready', status: 'True' }, { type: 'MemoryPressure', status: 'True' }] }).health,
    'warning'
  );
  assert.strictEqual(health.evaluateNode({ conditions: [{ type: 'Ready', status: 'True' }] }).health, 'healthy');
});

test('deployment health: available vs desired', () => {
  assert.strictEqual(health.evaluateWorkload({ replicas: { desired: 3, available: 3 } }).health, 'healthy');
  assert.strictEqual(health.evaluateWorkload({ replicas: { desired: 3, available: 1 } }).health, 'warning');
  assert.strictEqual(health.evaluateWorkload({ replicas: { desired: 3, available: 0 } }).health, 'critical');
});

test('service health: selector but no pods is critical', () => {
  assert.strictEqual(
    health.evaluateService({ type: 'ClusterIP', selector: { app: 'x' }, endpointsReady: 0, matchedPodUids: [] }).health,
    'critical'
  );
  assert.strictEqual(
    health.evaluateService({ type: 'ClusterIP', selector: { app: 'x' }, endpointsReady: 2, matchedPodUids: ['p'] }).health,
    'healthy'
  );
});

test('pvc health maps phase', () => {
  assert.strictEqual(health.evaluatePVC({ status: 'Bound' }).health, 'healthy');
  assert.strictEqual(health.evaluatePVC({ status: 'Pending' }).health, 'warning');
  assert.strictEqual(health.evaluatePVC({ status: 'Lost' }).health, 'critical');
});

test('rollup returns worst', () => {
  assert.strictEqual(health.rollup(['healthy', 'warning', 'critical']), 'critical');
  assert.strictEqual(health.rollup(['healthy', 'healthy']), 'healthy');
  assert.strictEqual(health.rollup([]), 'healthy');
});

// --- link -------------------------------------------------------------------
test('selectorMatches requires all keys, empty selector matches nothing', () => {
  assert.strictEqual(selectorMatches({ app: 'x' }, { app: 'x', t: '1' }), true);
  assert.strictEqual(selectorMatches({ app: 'x' }, { app: 'y' }), false);
  assert.strictEqual(selectorMatches({}, { app: 'x' }), false);
});

function fixtureInventory() {
  return {
    clusterId: 'c1:abcd', clusterName: 'dev',
    namespaces: [{ uid: 'ns', name: 'default', status: 'Active' }],
    nodes: [{ uid: 'n1', kind: 'node', name: 'node-a', status: 'Ready', conditions: [{ type: 'Ready', status: 'True' }] }],
    workloads: {
      deployments: [{ uid: 'd1', kind: 'deployment', name: 'web', namespace: 'default', replicas: { desired: 1, available: 1 }, ownerReferences: [] }],
      statefulSets: [], daemonSets: [],
      replicaSets: [{ uid: 'rs1', kind: 'replicaset', name: 'web-x', namespace: 'default', replicas: { desired: 1, ready: 1 }, ownerReferences: [{ kind: 'Deployment', name: 'web', uid: 'd1' }] }],
      jobs: [], cronJobs: [],
    },
    pods: [{ uid: 'p1', kind: 'pod', name: 'web-x-1', namespace: 'default', nodeName: 'node-a', phase: 'Running', labels: { app: 'web' }, readyContainers: 1, totalContainers: 1, restarts: 0, containers: [], volumes: [{ name: 'd', pvcName: 'pvc1' }], ownerReferences: [{ kind: 'ReplicaSet', name: 'web-x', uid: 'rs1' }] }],
    services: [{ uid: 's1', kind: 'service', name: 'web', namespace: 'default', type: 'ClusterIP', selector: { app: 'web' }, endpointsReady: 1 }],
    ingresses: [{ uid: 'i1', kind: 'ingress', name: 'web', namespace: 'default', backendServiceNames: ['web', 'gone'], loadBalancer: { ingress: ['1.1.1.1'] } }],
    persistentVolumes: [{ uid: 'pv1', kind: 'pv', name: 'pv-a', status: 'Bound' }],
    persistentVolumeClaims: [{ uid: 'pvc1u', kind: 'pvc', name: 'pvc1', namespace: 'default', status: 'Bound', volumeName: 'pv-a' }],
  };
}

test('linkInventory resolves cross-references', () => {
  const inv = linkInventory(fixtureInventory());
  assert.strictEqual(inv.nodes[0].podsRunning, 1);
  assert.deepStrictEqual(inv.services[0].matchedPodUids, ['p1']);
  assert.deepStrictEqual(inv.ingresses[0].backendServiceUids, ['s1']);
  assert.deepStrictEqual(inv.ingresses[0].missingBackends, ['gone']);
  assert.deepStrictEqual(inv.persistentVolumeClaims[0].mountedByPodUids, ['p1']);
});

// --- topology ---------------------------------------------------------------
test('buildTopology produces all relationship edge types + cluster root', () => {
  const inv = linkInventory(fixtureInventory());
  const { nodes, edges } = buildTopology(inv);
  assert.ok(nodes.find((n) => n.type === 'cluster'), 'has cluster root');
  const types = new Set(edges.map((e) => e.type));
  for (const t of ['owns', 'belongs_to', 'schedules', 'selects', 'routes_to', 'mounts']) {
    assert.ok(types.has(t), `has ${t} edge`);
  }
  // owner tightens pod parentId to the replicaset
  const pod = nodes.find((n) => n.type === 'pod');
  assert.strictEqual(pod.parentId, 'replicaset/default/web-x');
  // broken route to missing service
  assert.ok(edges.find((e) => e.type === 'routes_to' && e.status === 'broken'));
});

test('topology node ids are stable + unique', () => {
  const inv = linkInventory(fixtureInventory());
  const a = buildTopology(inv).nodes.map((n) => n.id).sort();
  const b = buildTopology(linkInventory(fixtureInventory())).nodes.map((n) => n.id).sort();
  assert.deepStrictEqual(a, b);
  assert.strictEqual(new Set(a).size, a.length, 'ids unique');
});

// --- validator --------------------------------------------------------------
test('validateSnapshot accepts a minimal valid envelope', () => {
  const { valid } = validateSnapshot({
    type: 'kubernetes_snapshot', schemaVersion: SCHEMA_VERSION,
    clusterId: 'c', clusterName: 'dev', timestamp: new Date().toISOString(),
  });
  assert.strictEqual(valid, true);
});

test('validateSnapshot rejects wrong version/type and bad arrays', () => {
  assert.strictEqual(validateSnapshot({ type: 'x', schemaVersion: 1, clusterId: 'c', clusterName: 'd', timestamp: 't' }).valid, false);
  assert.strictEqual(
    validateSnapshot({ type: 'kubernetes_snapshot', schemaVersion: SCHEMA_VERSION, clusterId: 'c', clusterName: 'd', timestamp: 't', pods: {} }).valid,
    false
  );
});

test('validateChunk enforces seq/total/data', () => {
  assert.strictEqual(validateChunk({ type: 'kubernetes_snapshot_chunk', snapshotId: 's', clusterId: 'c', seq: 0, total: 2, data: 'x' }).valid, true);
  assert.strictEqual(validateChunk({ type: 'kubernetes_snapshot_chunk', snapshotId: 's', clusterId: 'c', seq: -1, total: 2, data: 'x' }).valid, false);
});
