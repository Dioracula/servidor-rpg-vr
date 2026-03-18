const express = require("express");
const http = require("http");
const socketIo = require("socket.io");
const easyrtc = require("open-easyrtc");

// Configura o servidor
const app = express();
const webServer = http.createServer(app);

// Libera o CORS (para o seu HTML conseguir conectar sem ser bloqueado)
const socketServer = socketIo(webServer, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

// Inicia o EasyRTC (O que o Networked-Aframe usa para sincronizar posições)
easyrtc.setOption("logLevel", "debug");
easyrtc.listen(app, socketServer, null, function(err, rtcRef) {
    console.log("Servidor Multiplayer Iniciado com Sucesso!");
    
    rtcRef.events.on("roomCreate", function(appObj, creatorConnectionObj, roomName, roomOptions, callback) {
        console.log("Nova sala criada: " + roomName);
        appObj.events.defaultListeners.roomCreate(appObj, creatorConnectionObj, roomName, roomOptions, callback);
    });
});

// Define a porta (O Render vai escolher a porta automaticamente)
const port = process.env.PORT || 3000;
webServer.listen(port, function () {
    console.log("Servidor escutando na porta: " + port);
});
