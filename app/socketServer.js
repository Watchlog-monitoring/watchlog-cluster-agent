const watchlog_server = process.env.WATCHLOG_SERVER
var ioServer = require('socket.io-client');


const watchlogServerSocket = ioServer.connect(watchlog_server, {
    autoConnect: false,
    reconnection: true, 
    auth: {
        apiKey: process.env.WATCHLOG_APIKEY,
        clusterName: process.env.WATCHLOG_CLUSTER_NAME || "default-cluster",
        agentVersion: "0.0.1"
    }
});


watchlogServerSocket.connect();



watchlogServerSocket.on('error', err => console.error('client error:', err));
watchlogServerSocket.on('connect_error', err => console.error('connect failed:', err.message));

// ۴) helper برای emit ایمن
function emitWhenConnected(event, payload) {
    if (watchlogServerSocket.connected) {
        watchlogServerSocket.emit(event, payload);
    } else {
        watchlogServerSocket.once('connect', () => {
            watchlogServerSocket.emit(event, payload);
        });
    }
}

module.exports = {
    socket: watchlogServerSocket,
    emitWhenConnected
};