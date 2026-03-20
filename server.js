const express = require('express');
const admin = require("firebase-admin");
const serviceAccount = require("./serviceAccountKey.json");

const app = express();
const port = process.env.PORT || 3000;

app.get('/', (req, res) => { res.send('🔥 Servidor do RPG VR/PC está VIVO e com IA Tática Avançada!'); });
app.listen(port, () => { console.log(`🌐 Servidor Web escutando na porta ${port}`); });

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: "https://rpg-vr-online-default-rtdb.firebaseio.com"
});

const db = admin.database();

const baseStats = {
    'atirador': { speed: 0.04, cooldown: 3500, range: 30, stopRange: 6 },
    'meelee': { speed: 0.07, cooldown: 2000, range: 30, stopRange: 1.8 }
};

let estadoInimigos = {};
let jogadoresAtivos = {};

db.ref('players').on('value', (snap) => { jogadoresAtivos = snap.val() || {}; });

db.ref('cenario_inimigos').on('child_added', snap => {
    let id = snap.key; let data = snap.val(); if (!data || !data.pos) return;
    let tipoIA = data.tipo || 'meelee'; let stats = baseStats[tipoIA] || baseStats['meelee'];
    estadoInimigos[id] = {
        hpMax: data.hpMax || data.hp || 50, tipo: tipoIA,
        spawnPos: data.spawnPos || { x: data.pos.x || 0, y: data.pos.y || 0, z: data.pos.z || 0 },
        speed: data.speed !== undefined ? data.speed : stats.speed,
        cooldown: data.cooldown !== undefined ? data.cooldown : stats.cooldown,
        range: data.range !== undefined ? data.range : stats.range, 
        stopRange: stats.stopRange, hp: data.hp, pos: data.pos, rotY: data.rotY || 0, ultimoAtaque: 0, mortoEm: data.mortoEm || null, ultimoAvistamento: Date.now()
    };
});

db.ref('cenario_inimigos').on('child_changed', snap => {
    let id = snap.key; let data = snap.val();
    if (estadoInimigos[id] && data) {
        estadoInimigos[id].hp = data.hp;
        if (data.mortoEm !== undefined) estadoInimigos[id].mortoEm = data.mortoEm;
        if (data.spawnPos) estadoInimigos[id].spawnPos = data.spawnPos;
        if (data.range !== undefined) estadoInimigos[id].range = data.range;
        if (data.speed !== undefined) estadoInimigos[id].speed = data.speed;
        if (data.cooldown !== undefined) estadoInimigos[id].cooldown = data.cooldown;
        if (data.pos) {
            let dist = Math.hypot(data.pos.x - estadoInimigos[id].pos.x, data.pos.z - estadoInimigos[id].pos.z);
            if (dist > 3.0) estadoInimigos[id].pos = data.pos; 
        }
    }
});

db.ref('cenario_inimigos').on('child_removed', snap => { let id = snap.key; if (estadoInimigos[id]) delete estadoInimigos[id]; });

setInterval(() => {
    let agora = Date.now();
    for (let idInimigo in estadoInimigos) {
        let estado = estadoInimigos[idInimigo];
        
        if (estado.hp <= 0) {
            if (estado.mortoEm && (agora - estado.mortoEm >= 60000)) { 
                estado.hp = estado.hpMax; estado.mortoEm = null;
                estado.pos = { x: estado.spawnPos.x, y: estado.spawnPos.y, z: estado.spawnPos.z }; estado.ultimoAvistamento = agora;
                db.ref('cenario_inimigos/' + idInimigo).update({ hp: estado.hp, mortoEm: null, pos: estado.pos });
            } continue; 
        }

        let alvosValidos = [];
        for (let pId in jogadoresAtivos) {
            let p = jogadoresAtivos[pId];
            if (p.vivo && p.position) {
                let dist = Math.hypot(p.position.x - estado.pos.x, p.position.z - estado.pos.z);
                if (dist <= estado.range) alvosValidos.push({ pos: p.position, dist: dist });
            }
        }

        let viuAlguem = false;

        if (alvosValidos.length > 0) {
            viuAlguem = true; estado.ultimoAvistamento = agora; 
            alvosValidos.sort((a, b) => a.dist - b.dist);
            let alvo = alvosValidos[0].pos; let dist = alvosValidos[0].dist;
            let dx = alvo.x - estado.pos.x; let dz = alvo.z - estado.pos.z; let anguloY = Math.atan2(dx, dz);

            if (dist > estado.stopRange) {
                if (dist > 0.1) {
                    let dirX = (dx / dist) * estado.speed; let dirZ = (dz / dist) * estado.speed;
                    if (!isNaN(dirX) && !isNaN(dirZ)) { estado.pos.x += dirX; estado.pos.z += dirZ; }
                }
                estado.rotY = anguloY;
                db.ref('cenario_inimigos/' + idInimigo).update({ pos: estado.pos, rotY: estado.rotY });
            } 
            else {
                if (agora - estado.ultimoAtaque > estado.cooldown) {
                    estado.ultimoAtaque = agora; estado.rotY = anguloY; let updateData = { rotY: estado.rotY };
                    if (estado.tipo === 'atirador') updateData.shoot = { time: agora, tx: Number(alvo.x.toFixed(3)), ty: 1.2, tz: Number(alvo.z.toFixed(3)) };
                    else if (estado.tipo === 'meelee') updateData.meleeAttack = { time: agora };
                    db.ref('cenario_inimigos/' + idInimigo).update(updateData);
                }
            }
        }

        // REDUZIDO PARA 2 SEGUNDOS (2000ms): Se ele te perder de vista, volta pra base rápido
        if (!viuAlguem && (agora - estado.ultimoAvistamento > 2000)) {
            let dx = estado.spawnPos.x - estado.pos.x; let dz = estado.spawnPos.z - estado.pos.z;
            let distToSpawn = Math.hypot(dx, dz);

            if (distToSpawn > 1.0) {
                let anguloY = Math.atan2(dx, dz);
                if (distToSpawn > 0.1) {
                    let dirX = (dx / distToSpawn) * estado.speed; let dirZ = (dz / distToSpawn) * estado.speed;
                    if (!isNaN(dirX) && !isNaN(dirZ)) { estado.pos.x += dirX; estado.pos.z += dirZ; }
                }
                estado.rotY = anguloY;
                db.ref('cenario_inimigos/' + idInimigo).update({ pos: estado.pos, rotY: estado.rotY });
            }
        }
    }
}, 150);
