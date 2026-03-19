const express = require('express');
const admin = require("firebase-admin");
const serviceAccount = require("./serviceAccountKey.json");

// ==========================================
// 1. SERVIDOR WEB (Despertador Anti-Hibernação)
// ==========================================
const app = express();
const port = process.env.PORT || 3000;

app.get('/', (req, res) => {
    res.send('🔥 Servidor do RPG VR/PC está VIVO e rodando 24/7!');
});

app.listen(port, () => {
    console.log(`🌐 Servidor Web escutando na porta ${port}`);
});

// ==========================================
// 2. LÓGICA DO RPG (A Inteligência Artificial Dinâmica)
// ==========================================

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: "https://rpg-vr-online-default-rtdb.firebaseio.com"
});

const db = admin.database();

// Status base para cada tipo de IA
const baseStats = {
    'atirador': { speed: 0.04, cooldown: 3500, range: 30, stopRange: 6 },
    'meelee': { speed: 0.07, cooldown: 2000, range: 30, stopRange: 1.8 }
};

let estadoInimigos = {};
let jogadoresAtivos = {};

// Escuta a posição dos jogadores online
db.ref('players').on('value', (snap) => {
    jogadoresAtivos = snap.val() || {};
});

// EVENTO 1: NASCIMENTO DE UM INIMIGO (Lê do Painel Admin)
db.ref('cenario_inimigos').on('child_added', snap => {
    let id = snap.key;
    let data = snap.val();
    if (!data || !data.pos) return;

    let tipoIA = data.tipo || 'meelee';
    let stats = baseStats[tipoIA] || baseStats['meelee'];
    
    estadoInimigos[id] = {
        hpMax: data.hpMax || data.hp || 50,
        tipo: tipoIA,
        spawnPos: data.spawnPos || { x: data.pos.x, y: data.pos.y, z: data.pos.z },
        speed: stats.speed,
        cooldown: stats.cooldown,
        range: stats.range,
        stopRange: stats.stopRange,
        hp: data.hp,
        pos: data.pos,
        rotY: data.rotY || 0,
        ultimoAtaque: 0,
        mortoEm: data.mortoEm || null
    };
    console.log(`[Servidor] Novo inimigo ativado: ${id} (${tipoIA})`);
});

// EVENTO 2: MUDANÇAS EXTERNAS E TELEPORTE DO ADMIN
db.ref('cenario_inimigos').on('child_changed', snap => {
    let id = snap.key;
    let data = snap.val();
    
    if (estadoInimigos[id] && data) {
        // Atualiza a vida
        estadoInimigos[id].hp = data.hp;
        if (data.mortoEm !== undefined) estadoInimigos[id].mortoEm = data.mortoEm;
        
        // Verifica se foi teleportado pelo Painel do Admin
        if (data.pos) {
            let dist = Math.hypot(data.pos.x - estadoInimigos[id].pos.x, data.pos.z - estadoInimigos[id].pos.z);
            if (dist > 2.0) { 
                estadoInimigos[id].pos = data.pos;
                estadoInimigos[id].spawnPos = { x: data.pos.x, y: data.pos.y, z: data.pos.z };
                console.log(`[Servidor] ${id} foi teleportado pelo Game Master!`);
            }
        }
    }
});

// EVENTO 3: ADMIN DELETOU O INIMIGO DEFINITIVAMENTE
db.ref('cenario_inimigos').on('child_removed', snap => {
    let id = snap.key;
    if (estadoInimigos[id]) {
        delete estadoInimigos[id];
        console.log(`[Servidor] Inimigo ${id} apagado da existência pelo Admin!`);
    }
});

// LOOP PRINCIPAL DA IA
setInterval(() => {
    let agora = Date.now();

    for (let idInimigo in estadoInimigos) {
        let estado = estadoInimigos[idInimigo];
        
        // SISTEMA DE RESSURREIÇÃO
        if (estado.hp <= 0) {
            if (estado.mortoEm && (agora - estado.mortoEm >= 60000)) { 
                estado.hp = estado.hpMax;
                estado.mortoEm = null;
                estado.pos = { ...estado.spawnPos }; 
                
                db.ref('cenario_inimigos/' + idInimigo).update({ 
                    hp: estado.hp, 
                    mortoEm: null,
                    pos: estado.pos 
                });
                console.log(`[Servidor] ${idInimigo} reviveu no mapa!`);
            }
            continue; 
        }

        // RASTREAMENTO DE JOGADORES
        let alvosValidos = [];
        for (let pId in jogadoresAtivos) {
            let p = jogadoresAtivos[pId];
            if (p.vivo && p.position) {
                let dist = Math.hypot(p.position.x - estado.pos.x, p.position.z - estado.pos.z);
                alvosValidos.push({ pos: p.position, dist: dist });
            }
        }

        // MOVIMENTO E COMBATE
        if (alvosValidos.length > 0) {
            alvosValidos.sort((a, b) => a.dist - b.dist);
            let alvo = alvosValidos[0].pos; 
            let dist = alvosValidos[0].dist;

            if (dist < estado.range) {
                let dx = alvo.x - estado.pos.x;
                let dz = alvo.z - estado.pos.z;
                let anguloY = Math.atan2(dx, dz);

                if (dist > estado.stopRange) {
                    let dirX = (dx / dist) * estado.speed;
                    let dirZ = (dz / dist) * estado.speed;
                    estado.pos.x += dirX;
                    estado.pos.z += dirZ;
                    estado.rotY = anguloY;

                    db.ref('cenario_inimigos/' + idInimigo).update({ 
                        pos: estado.pos, 
                        rotY: estado.rotY 
                    });
                } 
                else {
                    if (agora - estado.ultimoAtaque > estado.cooldown) {
                        estado.ultimoAtaque = agora;
                        estado.rotY = anguloY;
                        
                        let updateData = { rotY: estado.rotY };
                        
                        if (estado.tipo === 'atirador') {
                            updateData.shoot = { 
                                time: agora, 
                                tx: Number(alvo.x.toFixed(3)), 
                                ty: 1.2, 
                                tz: Number(alvo.z.toFixed(3)) 
                            };
                        } else if (estado.tipo === 'meelee') {
                            updateData.meleeAttack = { time: agora };
                        }
                        
                        db.ref('cenario_inimigos/' + idInimigo).update(updateData);
                    }
                }
            }
        }
    }
}, 150);
