const watchlog_server = process.env.WATCHLOG_SERVER
var ioServer = require('socket.io-client');
const watchlogServerSocket = ioServer.connect(watchlog_server, { reconnection: true });
const apiKey = process.env.WATCHLOG_APIKEY;
const clusterName = process.env.WATCHLOG_CLUSTER_NAME || "default-cluster";
const agentVersion = "0.0.1";

watchlogServerSocket.on('connect', () => {
    console.log('Agent connected to watchlog');
    if (apiKey) {
        watchlogServerSocket.emit("setApiKeyK8s", {
            apiKey,
            clusterName,
            agentVersion
        });
    }
});


watchlogServerSocket.on('error', err => {
    console.error('Socket.IO client error:', err);
});



module.exports = watchlogServerSocket;
