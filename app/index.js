const axios = require('axios');
const watchlog_server = process.env.WATCHLOG_SERVER
const apiKey = process.env.WATCHLOG_APIKEY
const clusterName = process.env.WATCHLOG_CLUSTER_NAME || "default-cluster"
const agentVersion = "0.0.1"

const watchlogServerSocket = require("./socketServer");
const { collectKubernetesMetrics } = require('./watchlog-k8s-metrics');

module.exports = class Application {
    constructor() {
        this.startApp()
    }


    async startApp() {
        if (!apiKey) {
            return console.log(new Error("Watchlog ApiKey not found"))
        }
        if (!process.env.WATCHLOG_APIKEY) {
            return console.log(new Error("Watchlog ApiKey not found"))
        }
        if (await this.checkApiKey()) {
            this.runAgent()
        } else {
            setTimeout(() => {
                this.startApp()
            }, 10000)
        }
    }

    runAgent() {
        setInterval(() => collectKubernetesMetrics(watchlogServerSocket), 10000);
    }

    async checkApiKey() {
        try {
            let response = await axios.get(`${watchlog_server}/checkapikeyk8s?apiKey=${apiKey}&clusterName=${clusterName}`)
            if (response.status == 200) {
                if (response.data.status == "success") {

                    watchlogServerSocket.emit("setApiKeyK8s", { apiKey, clusterName: clusterName, agentVersion })
                    return true
                } else {
                    if (response.data.message) {
                        console.log(response.data.message)
                    }
                    return false
                }
            } else {
                return false
            }
        } catch (error) {
            console.log(error.message)
            return false
        }
    }




}

watchlogServerSocket.on('reconnect', async (attemptNumber) => {
    if (apiKey) {
        watchlogServerSocket.emit("setApiKeyK8s", { apiKey, clusterName: clusterName, agentVersion })
    }
});
