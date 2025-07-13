
const { collectKubernetesMetrics } = require('./watchlog-k8s-metrics');
const { watchPods } = require('./watchPods');  // فایل جدید

module.exports = class Application {
    constructor() {
        this.runAgent()
    }

    runAgent() {
        console.log("Watchlog cluster agent is running.")
        setInterval(() => collectKubernetesMetrics(), 60000);
        watchPods({
            tailLines: 200,
            sinceSeconds: 120,
            containerName: null,
            maxConcurrent: 3
        });
    }

}


