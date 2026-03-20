const express = require('express');
const admin = require("firebase-admin");
const serviceAccount = require("./serviceAccountKey.json");

const app = express();
const port = process.env.PORT || 3000;

app.get('/', (req, res) => { res.send('🔥 Servidor RPG VIVO: IA Blindada e Respawn Customizado!'); });
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
        hpMax: data.hpMax !== undefined ? Number(data.hpMax) : 50,
        hp: data.hp !== undefined ? Number(data.hp) : 50,
        tipo: data.tipo || 'meelee',
        comportamento: data.comportamento || 'hostil',
        spawnPos: data.spawnPos || { x: Number(data.pos.x), y: Number(data.pos.y), z: Number(data.pos.z) },
        pos: data.pos ? { x: Number(data.pos.x), y: Number(data.pos.y), z: Number(data.pos.z) } : {x:0, y:0, z:0},
        rotY: Number(data.rotY) || 0,
        speed: data.speed !== undefined ? Number(data.speed) : 0.08,
        cooldown: data.cooldown !== undefined ? Number(data.cooldown) : 2000,
        aggroRange: data.aggroRange !== undefined ? Number(data.aggroRange) : 15,
        attackRange: data.attackRange !== undefined ? Number(data.attackRange) : 1.8,
        respawnTime: data.respawnTime !== undefined ? Number(data.respawnTime) : 60000, // NOVO: LÊ O TEMPO DE RESPAWN DO BANCO
        ultimoAtaque: estadoInimigos[id] ? estadoInimigos[id].ultimoAtaque : 0,
        mortoEm: data.mortoEm !== undefined ? data.mortoEm : (estadoInimigos[id] ? estadoInimigos[id].mortoEm : null),
        ultimoAvistamento: estadoInimigos[id] ? estadoInimigos[id].ultimoAvistamento : Date.now()
    };
}

db.ref('cenario_inimigos').on('child_added', snap => {
    let id = snap.key; let data = snap.val(); 
    if (!data || data.hpMax === undefined || !data.modeloGlb) {
        db.ref('cenario_inimigos/' + id).remove();
        return;
    }
    if (!data.pos) return;
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
        
        // Verifica se a posição está corrompida (Prevenção de Crash)
        if (isNaN(e.pos.x) || isNaN(e.pos.z)) {
            e.pos = { ...e.spawnPos };
        }
        
        if (e.hp <= 0) {
            // AQUI A MÁGICA ACONTECE: Usa o respawnTime escolhido por você!
            if (e.mortoEm && (agora - e.mortoEm >= e.respawnTime)) { 
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
            
            // Só anda e atualiza ângulo se a distância for segura (evita divisão por zero/Infinity)
            if (menorDistancia > 0.01) {
                e.rotY = Math.atan2(dx, dz);
            }

            if (menorDistancia > e.attackRange) {
                if (menorDistancia > 0.01) {
                    let dirX = (dx / menorDistancia) * e.speed; let dirZ = (dz / menorDistancia) * e.speed;
                    if (isFinite(dirX) && isFinite(dirZ)) {
                        e.pos.x += dirX; e.pos.z += dirZ;
                        db.ref('cenario_inimigos/' + id).update({ pos: e.pos, rotY: e.rotY });
                    }
                }
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
            if (estourouColeira || (agora - e.ultimoAvistamento > 5000)) {
                if (distDaBase > 0.5) {
                    let dx = e.spawnPos.x - e.pos.x; let dz = e.spawnPos.z - e.pos.z;
                    if (distDaBase > 0.01) {
                        e.rotY = Math.atan2(dx, dz);
                        let speedVolta = e.speed * 1.5; 
                        let dirX = (dx / distDaBase) * speedVolta; let dirZ = (dz / distDaBase) * speedVolta;
                        if (isFinite(dirX) && isFinite(dirZ)) {
                            e.pos.x += dirX; e.pos.z += dirZ;
                            db.ref('cenario_inimigos/' + id).update({ pos: e.pos, rotY: e.rotY });
                        }
                    }
                } else {
                    if (e.comportamento === 'pacifico' && e.hp < e.hpMax) {
                        e.hp = e.hpMax;
                        db.ref('cenario_inimigos/' + id).update({ hp: e.hp });
                    }
                }
            }
        }
    }
}, 100);
