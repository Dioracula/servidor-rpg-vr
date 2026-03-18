const express = require("express");
const http = require("http");
const socketIo = require("socket.io");
const easyrtc = require("open-easyrtc");

// Configuração do Servidor Express
const app = express();
const webServer = http.createServer(app);

// Configuração do Socket.io
const socketServer = socketIo.listen(webServer, {
    "log level": 1,
    "cors": {
        "origin": "*", // Permite que o seu jogo local (127.0.0.1) conecte aqui
        "methods": ["GET", "POST"]
    }
});

// Inicia o EasyRTC (O coração do multiplayer VR)
easyrtc.setOption("logLevel", "debug");
easyrtc.events.on("easyrtcAuth", (socket, easyrtcid, msg, socketCallback, callback) => {
    easyrtc.events.defaultListeners.easyrtcAuth(socket, easyrtcid, msg, socketCallback, callback);
});

easyrtc.listen(app, socketServer, null, (err, rtcRef) => {
    console.log("Servidor EasyRTC Iniciado com Sucesso!");
});

// Define a porta do Render (ou 8080 local)
const port = process.env.PORT || 8080;
webServer.listen(port, () => {
    console.log("Servidor Multiplayer rodando na porta: " + port);
});
