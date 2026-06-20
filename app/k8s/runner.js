/**
 * v2 snapshot loop. Wires the API client, snapshot assembler, and transport
 * together and runs on K8S_COLLECTION_INTERVAL. Each cycle is independently
 * guarded so a failure never tears down the interval.
 */
const { createClient } = require('./client');
const { buildSnapshot } = require('./snapshot');
const { SnapshotSender } = require('./transport');
const { socket } = require('../socketServer');

let sender = null;
let running = false;

async function runOnce() {
  if (running) {
    console.warn('[k8s] previous snapshot still in progress, skipping this tick');
    return;
  }
  running = true;
  const startedAt = Date.now();
  try {
    const client = createClient();
    const clusterName = process.env.WATCHLOG_CLUSTER_NAME || 'default-cluster';
    const apiKey = process.env.WATCHLOG_APIKEY;

    const snapshot = await buildSnapshot(client, clusterName, apiKey, process.env, new Date());
    snapshot.agentVersion = process.env.AGENT_VERSION || '2.0.0';
    snapshot.collectionDurationMs = Date.now() - startedAt;

    const result = await sender.send(snapshot);
    console.log(
      `[k8s] snapshot ${result.snapshotId} (${snapshot.partial ? 'PARTIAL' : 'ok'}) ` +
        `nodes=${snapshot.summary.nodesTotal} pods=${snapshot.summary.podsTotal} ` +
        `topoNodes=${snapshot.topology.nodes.length} edges=${snapshot.topology.edges.length} ` +
        `${snapshot.collectionDurationMs}ms ${result.ok ? 'sent' : 'queued'}`
    );
    if (snapshot.partial) {
      console.warn('[k8s] partial snapshot, errors:', JSON.stringify(snapshot.errors));
    }
  } catch (err) {
    console.error('[k8s] snapshot cycle failed:', err.message);
  } finally {
    running = false;
  }
}

function runSnapshotLoop() {
  if (process.env.K8S_SNAPSHOT_ENABLED === 'false') {
    console.log('[k8s] v2 snapshot pipeline disabled (K8S_SNAPSHOT_ENABLED=false)');
    return;
  }
  sender = new SnapshotSender(socket, {
    compression: process.env.K8S_COMPRESSION !== 'false',
    chunkBytes: parseInt(process.env.K8S_CHUNK_BYTES || `${512 * 1024}`, 10),
    queueMax: parseInt(process.env.K8S_QUEUE_MAX || '10', 10),
  });
  const interval = parseInt(process.env.K8S_COLLECTION_INTERVAL || '60000', 10);
  // First run shortly after startup, then on the interval.
  setTimeout(runOnce, 5000);
  setInterval(runOnce, interval);
  console.log(`[k8s] v2 snapshot pipeline started (interval=${interval}ms)`);
}

module.exports = { runSnapshotLoop, runOnce };
