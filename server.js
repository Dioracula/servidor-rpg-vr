const express = require('express');
const admin = require("firebase-admin");
const serviceAccount = require("./serviceAccountKey.json");

const app = express();
const port = process.env.PORT || 3000;

app.get('/', (req, res) => { res.send('🔥 Servidor RPG VIVO: IA Hostil/Pacífica Ativada!'); });
app.listen(port, () => { console.log(`🌐 Servidor escutando na porta ${port}`); });

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: "https://rpg-vr-online-default-rtdb.firebaseio.com"
});

const db = admin.database();

let estadoInimigos = {};
let jogadoresAtivos = {};

db.ref('players').on('value', (snap) => { jogadoresAtivos = snap.val() || {}; });

db.ref('cenario_inimigos').on('child_added', snap => {
    let id = snap.key; let data = snap.val(); if (!data || !data.pos) return;
    
    estadoInimigos[id] = {
        hpMax: data.hpMax || data.hp || 50,
        hp: data.hp,
        tipo: data.tipo || 'meelee',
        comportamento: data.comportamento || 'hostil', // NOVO: Hostil ou Pacífico
        spawnPos: data.spawnPos || { x: data.pos.x || 0, y: data.pos.y || 0, z: data.pos.z || 0 },
        pos: data.pos,
        rotY: data.rotY || 0,
        
        speed: data.speed !== undefined ? data.speed : 0.05,
        cooldown: data.cooldown !== undefined ? data.cooldown : 2000,
        aggroRange: data.aggroRange !== undefined ? data.aggroRange : 20, // Distância que ele te vê
        attackRange: data.attackRange !== undefined ? data.attackRange : 2.0, // Distância que ele bate
        
        ultimoAtaque: 0,
        mortoEm: data.mortoEm || null,
        ultimoAvistamento: Date.now()
    };
});

db.ref('cenario_inimigos').on('child_changed', snap => {
    let id = snap.key; let data = snap.val();
    if (estadoInimigos[id] && data) {
        estadoInimigos[id].hp = data.hp;
        if (data.mortoEm !== undefined) estadoInimigos[id].mortoEm = data.mortoEm;
        if (data.spawnPos) estadoInimigos[id].spawnPos = data.spawnPos;
        if (data.comportamento) estadoInimigos[id].comportamento = data.comportamento;
        if (data.aggroRange !== undefined) estadoInimigos[id].aggroRange = data.aggroRange;
        if (data.attackRange !== undefined) estadoInimigos[id].attackRange = data.attackRange;
        if (data.speed !== undefined) estadoInimigos[id].speed = data.speed;
        if (data.cooldown !== undefined) estadoInimigos[id].cooldown = data.cooldown;
        if (data.pos) {
            let dist = Math.hypot(data.pos.x - estadoInimigos[id].pos.x, data.pos.z - estadoInimigos[id].pos.z);
            if (dist > 3.0) estadoInimigos[id].pos = data.pos; // Se o Admin teleportar
        }
    }
});

db.ref('cenario_inimigos').on('child_removed', snap => { let id = snap.key; if (estadoInimigos[id]) delete estadoInimigos[id]; });

// IA RODANDO A 100ms PARA MOVIMENTO SUPER SUAVE
setInterval(() => {
    let agora = Date.now();

    for (let idInimigo in estadoInimigos) {
        let estado = estadoInimigos[idInimigo];
        
        if (estado.hp <= 0) {
            if (estado.mortoEm && (agora - estado.mortoEm >= 60000)) { 
                estado.hp = estado.hpMax; estado.mortoEm = null;
                estado.pos = { ...estado.spawnPos }; estado.ultimoAvistamento = agora;
                db.ref('cenario_inimigos/' + idInimigo).update({ hp: estado.hp, mortoEm: null, pos: estado.pos });
            } continue; 
        }

        // LÓGICA DE AGGRO: Se for pacífico e a vida estiver cheia, ele ignora jogadores!
        let estaMachucado = estado.hp < estado.hpMax;
        let querBriga = (estado.comportamento === 'hostil') || (estado.comportamento === 'pacifico' && estaMachucado);

        let alvosValidos = [];
        if (querBriga) {
            for (let pId in jogadoresAtivos) {
                let p = jogadoresAtivos[pId];
                if (p.vivo && p.position) {
                    let dist = Math.hypot(p.position.x - estado.pos.x, p.position.z - estado.pos.z);
                    if (dist <= estado.aggroRange) alvosValidos.push({ pos: p.position, dist: dist });
                }
            }
        }

        let viuAlguem = false;

        if (alvosValidos.length > 0) {
            viuAlguem = true; 
            estado.ultimoAvistamento = agora; // Zera o timer de desistência
            
            alvosValidos.sort((a, b) => a.dist - b.dist);
            let alvo = alvosValidos[0].pos; 
            let dist = alvosValidos[0].dist;

            let dx = alvo.x - estado.pos.x; let dz = alvo.z - estado.pos.z; 
            let anguloY = Math.atan2(dx, dz);

            // CORRE ATÉ CHEGAR NO ALCANCE DE ATAQUE (Attack Range)
            if (dist > estado.attackRange) {
                if (dist > 0.1) {
                    let dirX = (dx / dist) * estado.speed; let dirZ = (dz / dist) * estado.speed;
                    if (!isNaN(dirX) && !isNaN(dirZ)) { estado.pos.x += dirX; estado.pos.z += dirZ; }
                }
                estado.rotY = anguloY;
                db.ref('cenario_inimigos/' + idInimigo).update({ pos: estado.pos, rotY: estado.rotY });
            } 
            // CHEGOU PERTO O SUFICIENTE: BATE!
            else {
                if (agora - estado.ultimoAtaque > estado.cooldown) {
                    estado.ultimoAtaque = agora; estado.rotY = anguloY; let updateData = { rotY: estado.rotY };
                    if (estado.tipo === 'atirador') updateData.shoot = { time: agora, tx: Number(alvo.x.toFixed(3)), ty: 1.2, tz: Number(alvo.z.toFixed(3)) };
                    else if (estado.tipo === 'meelee') updateData.meleeAttack = { time: agora };
                    db.ref('cenario_inimigos/' + idInimigo).update(updateData);
                }
            }
        }

        // SISTEMA DE DESISTÊNCIA (5 Segundos sem ver ninguém)
        if (!viuAlguem && (agora - estado.ultimoAvistamento > 5000)) {
            let dx = estado.spawnPos.x - estado.pos.x; let dz = estado.spawnPos.z - estado.pos.z;
            let distToSpawn = Math.hypot(dx, dz);

            if (distToSpawn > 1.0) {
                let anguloY = Math.atan2(dx, dz);
                if (distToSpawn > 0.1) {
                    // Ele volta andando calmamente para casa
                    let dirX = (dx / distToSpawn) * estado.speed; let dirZ = (dz / distToSpawn) * estado.speed;
                    if (!isNaN(dirX) && !isNaN(dirZ)) { estado.pos.x += dirX; estado.pos.z += dirZ; }
                }
                estado.rotY = anguloY;
                db.ref('cenario_inimigos/' + idInimigo).update({ pos: estado.pos, rotY: estado.rotY });
            } else {
                // Chegou na base! Se ele era pacífico, ele se cura totalmente para voltar a ser amigável
                if (estado.comportamento === 'pacifico' && estado.hp < estado.hpMax) {
                    estado.hp = estado.hpMax;
                    db.ref('cenario_inimigos/' + idInimigo).update({ hp: estado.hp });
                }
            }
        }
    }
}, 100); // 100 milissegundos deixa a movimentação perfeita no navegador
