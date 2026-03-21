const express = require('express');
const admin = require("firebase-admin");
const serviceAccount = require("./serviceAccountKey.json");

const app = express();
const port = process.env.PORT || 3000;

app.get('/', (req, res) => { res.send('🔥 Servidor RPG VIVO: Heartbeat, Patrulha e Regen Dinâmica Ativados!'); });
app.listen(port, () => { console.log(`🌐 Servidor escutando na porta ${port}`); });

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: "https://rpg-vr-online-default-rtdb.firebaseio.com"
});

const db = admin.database();

let estadoInimigos = {};
let jogadoresAtivos = {};

db.ref('players').on('value', snap => { jogadoresAtivos = snap.val() || {}; });

const safeNum = (val, fallback) => { let n = Number(val); return (isFinite(n) && !isNaN(n)) ? n : fallback; };

function lerDadosInimigo(id, data) {
    return {
        id: id,
        hpMax: safeNum(data.hpMax, 50),
        hp: safeNum(data.hp, 50),
        tipo: data.tipo || 'meelee',
        comportamento: data.comportamento || 'hostil',
        movimento: data.movimento || 'estatico',
        spawnPos: data.spawnPos ? { x: safeNum(data.spawnPos.x, 0), y: safeNum(data.spawnPos.y, 0), z: safeNum(data.spawnPos.z, 0) } : { x: safeNum(data.pos.x, 0), y: safeNum(data.pos.y, 0), z: safeNum(data.pos.z, 0) },
        pos: data.pos ? { x: safeNum(data.pos.x, 0), y: safeNum(data.pos.y, 0), z: safeNum(data.pos.z, 0) } : {x:0, y:0, z:0},
        rotY: safeNum(data.rotY, 0),
        speed: safeNum(data.speed, 0.08),
        cooldown: safeNum(data.cooldown, 2000),
        aggroRange: safeNum(data.aggroRange, 15),
        attackRange: safeNum(data.attackRange, 1.8),
        respawnTime: safeNum(data.respawnTime, 60000),
        ultimoAtaque: estadoInimigos[id] ? estadoInimigos[id].ultimoAtaque : 0,
        mortoEm: data.mortoEm !== undefined ? data.mortoEm : (estadoInimigos[id] ? estadoInimigos[id].mortoEm : null),
        ultimoAvistamento: estadoInimigos[id] ? estadoInimigos[id].ultimoAvistamento : Date.now(),
        tempoProxPatrulha: estadoInimigos[id] ? estadoInimigos[id].tempoProxPatrulha : 0,
        alvoPatrulha: estadoInimigos[id] ? estadoInimigos[id].alvoPatrulha : null,
        
        // Novas variáveis para Regeneração e Memória
        ultimoRegen: estadoInimigos[id] ? estadoInimigos[id].ultimoRegen : 0,
        ignorarAgressao: estadoInimigos[id] ? estadoInimigos[id].ignorarAgressao : false
    };
}

db.ref('cenario_inimigos').on('child_added', snap => {
    let id = snap.key; let data = snap.val(); 
    if (!data || data.hpMax === undefined || !data.modeloGlb) { db.ref('cenario_inimigos/' + id).remove(); return; }
    if (!data.pos) return;
    estadoInimigos[id] = lerDadosInimigo(id, data);
});

db.ref('cenario_inimigos').on('child_changed', snap => {
    let id = snap.key; let data = snap.val(); if(!data) return;
    if(estadoInimigos[id]) { 
        let hpAntigo = estadoInimigos[id].hp;
        let newData = lerDadosInimigo(id, data); 
        
        // Nova mecânica: Se a vida diminuiu em relação ao frame anterior, ele foi atacado
        if (newData.hp < hpAntigo) {
            newData.ignorarAgressao = false; // Lembra do jogador e revida!
            newData.ultimoAvistamento = Date.now();
        }
        
        estadoInimigos[id] = { ...estadoInimigos[id], ...newData }; 
    }
});

db.ref('cenario_inimigos').on('child_removed', snap => { delete estadoInimigos[snap.key]; });

// O BATIMENTO CARDÍACO: Avisa o jogo que o servidor da IA está acordado!
setInterval(() => {
    db.ref('servidor_ia_status').set(Date.now());
}, 2000);

// IA RODANDO A 100ms
setInterval(() => {
    let agora = Date.now();

    for (let id in estadoInimigos) {
        try {
            let e = estadoInimigos[id];
            
            if (e.hp <= 0) {
                if (!e.mortoEm) { e.mortoEm = agora; db.ref('cenario_inimigos/' + id).update({ mortoEm: agora }); } 
                else if (agora - e.mortoEm >= e.respawnTime) { e.hp = e.hpMax; e.mortoEm = null; e.pos = { ...e.spawnPos }; e.ultimoAvistamento = 0; e.alvoPatrulha = null; e.ignorarAgressao = false; db.ref('cenario_inimigos/' + id).update({ hp: e.hp, mortoEm: null, pos: e.pos }); }
                continue; 
            }

            let distDaBase = Math.hypot(e.pos.x - e.spawnPos.x, e.pos.z - e.spawnPos.z);
            let limiteColeira = e.aggroRange * 1.5;
            let estourouColeira = distDaBase > limiteColeira;
            let machucado = e.hp < e.hpMax;

            // Mecânica de esquecer o jogador: se perdeu de vista ou estourou coleira
            if (estourouColeira || agora - e.ultimoAvistamento > 3000) {
                if (e.comportamento === 'pacifico') {
                    e.ignorarAgressao = true;
                }
            }
            
            if (!machucado) { e.ignorarAgressao = false; } // Vida cheia, reseta a memória

            let querBriga = (e.comportamento === 'hostil') || (e.comportamento === 'pacifico' && machucado && !e.ignorarAgressao);

            let alvoMaisPerto = null; let menorDistancia = Infinity;

            if (querBriga && !estourouColeira) {
                for (let pId in jogadoresAtivos) {
                    let p = jogadoresAtivos[pId];
                    if (p.vivo && p.position) {
                        let dist = Math.hypot(safeNum(p.position.x, 0) - e.pos.x, safeNum(p.position.z, 0) - e.pos.z);
                        if (dist <= e.aggroRange && dist < menorDistancia) { menorDistancia = dist; alvoMaisPerto = p.position; }
                    }
                }
            }

            if (alvoMaisPerto) {
                e.ultimoAvistamento = agora; e.alvoPatrulha = null; 
                let dx = safeNum(alvoMaisPerto.x, 0) - e.pos.x; let dz = safeNum(alvoMaisPerto.z, 0) - e.pos.z; 
                if (menorDistancia > 0.01) { e.rotY = Math.atan2(dx, dz); }

                if (menorDistancia > e.attackRange) {
                    if (menorDistancia > 0.01) {
                        let dirX = (dx / menorDistancia) * e.speed; let dirZ = (dz / menorDistancia) * e.speed;
                        e.pos.x += dirX; e.pos.z += dirZ;
                        db.ref('cenario_inimigos/' + id).update({ pos: e.pos, rotY: e.rotY });
                    }
                } else {
                    if (agora - e.ultimoAtaque > e.cooldown) {
                        e.ultimoAtaque = agora; let updateData = { rotY: e.rotY };
                        if (e.tipo === 'atirador') updateData.shoot = { time: agora, tx: safeNum(alvoMaisPerto.x, 0), ty: 1.2, tz: safeNum(alvoMaisPerto.z, 0) }; else updateData.meleeAttack = { time: agora };
                        db.ref('cenario_inimigos/' + id).update(updateData);
                    }
                }
            } else {
                let perdendoAggro = (agora - e.ultimoAvistamento < 2000); 

                // Se estourou coleira, ou se afastou, ou tá machucado e não tá vendo ninguém...
                let precisaVoltar = estourouColeira || (!perdendoAggro && distDaBase > 6.0) || (machucado && !perdendoAggro);

                if (precisaVoltar) {
                    if (distDaBase > 0.5) {
                        let dx = e.spawnPos.x - e.pos.x; let dz = e.spawnPos.z - e.pos.z;
                        if (distDaBase > 0.01) {
                            e.rotY = Math.atan2(dx, dz); let speedVolta = e.speed * 1.5; let dirX = (dx / distDaBase) * speedVolta; let dirZ = (dz / distDaBase) * speedVolta;
                            e.pos.x += dirX; e.pos.z += dirZ; db.ref('cenario_inimigos/' + id).update({ pos: e.pos, rotY: e.rotY });
                        }
                    } else {
                        e.alvoPatPatrulha = null;
                    }

                    // Regeneração Gradual de HP (A cada 1 segundo)
                    if (machucado && (agora - e.ultimoRegen > 1000)) {
                        e.ultimoRegen = agora;
                        let cura = Math.max(1, Math.floor(e.hpMax * 0.10)); // Cura 10% do HP Max por segundo
                        e.hp = Math.min(e.hpMax, e.hp + cura);
                        db.ref('cenario_inimigos/' + id).update({ hp: e.hp });
                    }

                } else if (!perdendoAggro && e.movimento === 'livre') {
                    if (agora > e.tempoProxPatrulha) {
                        if (!e.alvoPatrulha) {
                            let angulo = Math.random() * Math.PI * 2; let raio = Math.random() * 4.0;
                            e.alvoPatrulha = { x: e.spawnPos.x + Math.cos(angulo)*raio, z: e.spawnPos.z + Math.sin(angulo)*raio };
                        } else {
                            let dxP = e.alvoPatrulha.x - e.pos.x; let dzP = e.alvoPatrulha.z - e.pos.z; let distP = Math.hypot(dxP, dzP);
                            if (distP > 0.2) {
                                e.rotY = Math.atan2(dxP, dzP); let speedPatrol = e.speed * 0.6; 
                                let dirX = (dxP / distP) * speedPatrol; let dirZ = (dzP / distP) * speedPatrol;
                                e.pos.x += dirX; e.pos.z += dirZ; db.ref('cenario_inimigos/' + id).update({ pos: e.pos, rotY: e.rotY });
                            } else {
                                e.alvoPatrulha = null; e.tempoProxPatrulha = agora + 2000 + Math.random() * 4000;
                            }
                        }
                    }
                }
            }
        } catch(err) { console.error(`Erro isolado no inimigo ${id}. Pulando frame. Erro:`, err); }
    }
}, 100);
