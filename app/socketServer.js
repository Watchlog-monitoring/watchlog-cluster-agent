const watchlog_server = process.env.WATCHLOG_SERVER
var ioServer = require('socket.io-client');
const watchlogServerSocket = ioServer.connect(watchlog_server, { reconnection: true });


watchlogServerSocket.on('error', err => {
    console.error('Socket.IO client error:', err);
});



module.exports = watchlogServerSocket;
