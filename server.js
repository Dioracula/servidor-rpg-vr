const express = require('express');
const admin = require("firebase-admin");
const serviceAccount = require("./serviceAccountKey.json");

const app = express();
const port = process.env.PORT || 3000;

app.get('/', (req, res) => { res.send('🔥 Servidor RPG VIVO: IA Absoluta Ativada!'); });
app.listen(port, () => { console.log(`🌐 Servidor escutando na porta ${port}`); });

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: "https://rpg-vr-online-default-rtdb.firebaseio.com"
});

const db = admin.database();

let estadoInimigos = {};
let jogadoresAtivos = {};

db.ref('players').on('value', snap => { jogadoresAtivos = snap.val() || {}; });

function lerDadosInimigo(id, data) {
    return {
        id: id,
        hpMax: Number(data.hpMax) || 50,
        hp: Number(data.hp),
        tipo: data.tipo || 'meelee',
        comportamento: data.comportamento || 'hostil',
        spawnPos: data.spawnPos || { x: data.pos.x, y: data.pos.y, z: data.pos.z },
        pos: data.pos,
        rotY: data.rotY || 0,
        speed: Number(data.speed) || 0.08,
        cooldown: Number(data.cooldown) || 2000,
        aggroRange: Number(data.aggroRange) || 15,
        attackRange: Number(data.attackRange) || 1.8,
        ultimoAtaque: estadoInimigos[id] ? estadoInimigos[id].ultimoAtaque : 0,
        mortoEm: data.mortoEm || null,
        ultimoAvistamento: estadoInimigos[id] ? estadoInimigos[id].ultimoAvistamento : Date.now()
    };
}

db.ref('cenario_inimigos').on('child_added', snap => {
    let id = snap.key; let data = snap.val(); if(!data || !data.pos) return;
    estadoInimigos[id] = lerDadosInimigo(id, data);
});

db.ref('cenario_inimigos').on('child_changed', snap => {
    let id = snap.key; let data = snap.val(); if(!data) return;
    if(estadoInimigos[id]) {
        let newData = lerDadosInimigo(id, data);
        estadoInimigos[id] = { ...estadoInimigos[id], ...newData };
    }
});

db.ref('cenario_inimigos').on('child_removed', snap => { delete estadoInimigos[snap.key]; });

// IA RODANDO A 100ms
setInterval(() => {
    let agora = Date.now();

    for (let id in estadoInimigos) {
        let e = estadoInimigos[id];
        
        if (e.hp <= 0) {
            if (e.mortoEm && (agora - e.mortoEm >= 60000)) { 
                e.hp = e.hpMax; e.mortoEm = null; e.pos = { ...e.spawnPos }; e.ultimoAvistamento = agora;
                db.ref('cenario_inimigos/' + id).update({ hp: e.hp, mortoEm: null, pos: e.pos });
            } continue; 
        }

        let distDaBase = Math.hypot(e.pos.x - e.spawnPos.x, e.pos.z - e.spawnPos.z);
        let limiteColeira = e.aggroRange * 1.5;
        let estourouColeira = distDaBase > limiteColeira;

        let machucado = e.hp < e.hpMax;
        let querBriga = (e.comportamento === 'hostil') || (e.comportamento === 'pacifico' && machucado);

        let alvoMaisPerto = null;
        let menorDistancia = Infinity;

        if (querBriga && !estourouColeira) {
            for (let pId in jogadoresAtivos) {
                let p = jogadoresAtivos[pId];
                if (p.vivo && p.position) {
                    let dist = Math.hypot(p.position.x - e.pos.x, p.position.z - e.pos.z);
                    if (dist <= e.aggroRange && dist < menorDistancia) {
                        menorDistancia = dist;
                        alvoMaisPerto = p.position;
                    }
                }
            }
        }

        if (alvoMaisPerto) {
            e.ultimoAvistamento = agora; 
            let dx = alvoMaisPerto.x - e.pos.x; let dz = alvoMaisPerto.z - e.pos.z; 
            e.rotY = Math.atan2(dx, dz);

            if (menorDistancia > e.attackRange) {
                let dirX = (dx / menorDistancia) * e.speed; let dirZ = (dz / menorDistancia) * e.speed;
                e.pos.x += dirX; e.pos.z += dirZ;
                db.ref('cenario_inimigos/' + id).update({ pos: e.pos, rotY: e.rotY });
            } else {
                if (agora - e.ultimoAtaque > e.cooldown) {
                    e.ultimoAtaque = agora;
                    let updateData = { rotY: e.rotY };
                    if (e.tipo === 'atirador') updateData.shoot = { time: agora, tx: alvoMaisPerto.x, ty: 1.2, tz: alvoMaisPerto.z };
                    else updateData.meleeAttack = { time: agora };
                    db.ref('cenario_inimigos/' + id).update(updateData);
                }
            }
        } else {
            // SISTEMA DE DESISTÊNCIA (Perdeu de vista ou Estourou a Coleira)
            if (estourouColeira || (agora - e.ultimoAvistamento > 5000)) {
                if (distDaBase > 0.5) {
                    let dx = e.spawnPos.x - e.pos.x; let dz = e.spawnPos.z - e.pos.z;
                    e.rotY = Math.atan2(dx, dz);
                    let speedVolta = e.speed * 1.5; // Volta mais rápido pra base
                    let dirX = (dx / distDaBase) * speedVolta; let dirZ = (dz / distDaBase) * speedVolta;
                    e.pos.x += dirX; e.pos.z += dirZ;
                    db.ref('cenario_inimigos/' + id).update({ pos: e.pos, rotY: e.rotY });
                } else {
                    // Chegou na base. Se for pacífico, cura a vida toda pra não ficar agressivo
                    if (e.comportamento === 'pacifico' && e.hp < e.hpMax) {
                        e.hp = e.hpMax;
                        db.ref('cenario_inimigos/' + id).update({ hp: e.hp });
                    }
                }
            }
        }
    }
}, 100);
