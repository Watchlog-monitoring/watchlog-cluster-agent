
const { collectKubernetesMetrics } = require('./watchlog-k8s-metrics'); // legacy v1 (kept for back-compat)
const { runSnapshotLoop } = require('./k8s/runner');

module.exports = class Application {
    constructor() {
        this.runAgent();
    }

    runAgent() {
        console.log("Watchlog cluster agent is running.");

        // v2 snapshot pipeline: inventory + topology + health, emitted as
        // `kubernetes:snapshot`. Controlled by K8S_* env vars.
        runSnapshotLoop();

        // Legacy v1 metrics emit (`kubernetesMetrics`) stays on during migration
        // so the existing server-agent handler / current UI keep working.
        // Disable by setting K8S_LEGACY_METRICS=false once the v2 read path ships.
        if (process.env.K8S_LEGACY_METRICS !== 'false') {
            const interval = parseInt(process.env.K8S_COLLECTION_INTERVAL || '60000', 10);
            setInterval(() => collectKubernetesMetrics(), interval);
        }
    }
}
