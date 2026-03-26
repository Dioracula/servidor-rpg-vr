const express = require('express');
const admin = require("firebase-admin");
const serviceAccount = require("./serviceAccountKey.json");

const app = express();
const port = process.env.PORT || 3000;

app.get('/', (req, res) => { res.send('🔥 Servidor RPG VIVO: IA Multi-Ataques Ativada!'); });
app.listen(port, () => { console.log(`🌐 Servidor escutando na porta ${port}`); });

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: "https://rpg-vr-online-default-rtdb.firebaseio.com"
});

const db = admin.database();

let estadoInimigos = {};
let jogadoresAtivos = {};

db.ref('players').on('value', snap => { 
    let novosJogadores = snap.val() || {}; 
    for (let eId in estadoInimigos) {
        let e = estadoInimigos[eId];
        if (e.currentTarget) {
            let p = novosJogadores[e.currentTarget];
            if (!p || p.vivo === false) {
                console.log(`💀 Jogador ${e.currentTarget} caiu. Inimigo ${eId} perdendo o alvo...`);
                e.currentTarget = null;
                if (e.comportamento === 'pacifico') e.ignorarAgressao = true;
            }
        }
    }
    jogadoresAtivos = novosJogadores; 
});

const safeNum = (val, fallback) => { let n = Number(val); return (isFinite(n) && !isNaN(n)) ? n : fallback; };

function lerDadosInimigo(id, data) {
    // Compatibilidade com inimigos antigos
    let ataques = data.ataques || [];
    if (ataques.length === 0) {
        ataques.push({
            animacao: data.animAtaque || 'chr784_armature|chr784_ba01',
            tipo: data.tipo || 'meelee', alcance: data.attackRange || 1.8,
            dano: data.dano || 10, tempoHit: 400, duracao: 1000, osso: data.ossoAtaque || '',
            glbTiro: data.modeloTiroGlb || '', escalaTiro: data.escalaTiro || '0.5 0.5 0.5', rotTiro: data.rotacaoTiro || '0 0 0', velTiro: data.velocidadeTiro || 6.0
        });
    }

    return {
        id: id, hpMax: safeNum(data.hpMax, 50), hp: safeNum(data.hp, 50),
        comportamento: data.comportamento || 'hostil', movimento: data.movimento || 'livre',
        spawnPos: data.spawnPos ? { x: safeNum(data.spawnPos.x, 0), y: safeNum(data.spawnPos.y, 0), z: safeNum(data.spawnPos.z, 0) } : {x:0, y:0, z:0},
        pos: data.pos ? { x: safeNum(data.pos.x, 0), y: safeNum(data.pos.y, 0), z: safeNum(data.pos.z, 0) } : {x:0, y:0, z:0},
        rotY: safeNum(data.rotY, 0), speed: safeNum(data.speed, 0.08), cooldown: safeNum(data.cooldown, 2000),
        aggroRange: safeNum(data.aggroRange, 15), respawnTime: safeNum(data.respawnTime, 60000),
        ataques: ataques,
        ultimoAtaque: estadoInimigos[id] ? estadoInimigos[id].ultimoAtaque : 0,
        mortoEm: data.mortoEm !== undefined ? data.mortoEm : (estadoInimigos[id] ? estadoInimigos[id].mortoEm : null),
        tempoProxPatrulha: estadoInimigos[id] ? estadoInimigos[id].tempoProxPatrulha : 0, alvoPatrulha: estadoInimigos[id] ? estadoInimigos[id].alvoPatrulha : null,
        ultimoRegen: estadoInimigos[id] ? estadoInimigos[id].ultimoRegen : 0, currentTarget: estadoInimigos[id] ? estadoInimigos[id].currentTarget : null,
        retornandoBase: estadoInimigos[id] ? estadoInimigos[id].retornandoBase : false, ignorarAgressao: estadoInimigos[id] ? estadoInimigos[id].ignorarAgressao : false
    };
}

db.ref('cenario_inimigos').on('child_added', snap => {
    let id = snap.key; let data = snap.val(); 
    if (!data || data.hpMax === undefined || !data.modeloGlb) { return; }
    if (!data.pos) return;
    estadoInimigos[id] = lerDadosInimigo(id, data);
});

db.ref('cenario_inimigos').on('child_changed', snap => {
    let id = snap.key; let data = snap.val(); if(!data) return;
    if(estadoInimigos[id]) { 
        let hpAntigo = estadoInimigos[id].hp; let newData = lerDadosInimigo(id, data); 
        if (newData.hp < hpAntigo && data.ultimoAtacante) {
            newData.currentTarget = data.ultimoAtacante; newData.retornandoBase = false; newData.ignorarAgressao = false;
        }
        estadoInimigos[id] = { ...estadoInimigos[id], ...newData }; 
    }
});

db.ref('cenario_inimigos').on('child_removed', snap => { delete estadoInimigos[snap.key]; });
setInterval(() => { db.ref('servidor_ia_status').set(Date.now()); }, 2000);

setInterval(() => {
    let agora = Date.now();
    for (let id in estadoInimigos) {
        try {
            let e = estadoInimigos[id];
            if (e.hp <= 0) {
                if (!e.mortoEm) { e.mortoEm = agora; db.ref('cenario_inimigos/' + id).update({ mortoEm: agora }); } 
                else if (agora - e.mortoEm >= e.respawnTime) { e.hp = e.hpMax; e.mortoEm = null; e.pos = { ...e.spawnPos }; e.currentTarget = null; e.alvoPatrulha = null; e.retornandoBase = false; e.ignorarAgressao = false; db.ref('cenario_inimigos/' + id).update({ hp: e.hp, mortoEm: null, pos: e.pos }); }
                continue; 
            }

            let targetPlayerPos = null;
            if (e.currentTarget) {
                let p = jogadoresAtivos[e.currentTarget];
                if (p && p.vivo !== false && p.position) {
                    let distTarget = Math.hypot(safeNum(p.position.x, 0) - e.pos.x, safeNum(p.position.z, 0) - e.pos.z);
                    if (distTarget <= e.aggroRange) targetPlayerPos = p.position;
                    else { e.currentTarget = null; if (e.comportamento === 'pacifico') e.ignorarAgressao = true; }
                } else { e.currentTarget = null; if (e.comportamento === 'pacifico') e.ignorarAgressao = true; }
            }

            if (!e.currentTarget && e.comportamento === 'hostil') {
                let menorDistanciaEncontrada = e.aggroRange;
                for (let pId in jogadoresAtivos) {
                    let p = jogadoresAtivos[pId];
                    if (p.vivo !== false && p.position) {
                        let dist = Math.hypot(safeNum(p.position.x, 0) - e.pos.x, safeNum(p.position.z, 0) - e.pos.z);
                        if (dist <= menorDistanciaEncontrada) { menorDistanciaEncontrada = dist; e.currentTarget = pId; targetPlayerPos = p.position; }
                    }
                }
            }

            if (targetPlayerPos) {
                e.retornandoBase = false; e.alvoPatrulha = null; 
                let dx = safeNum(targetPlayerPos.x, 0) - e.pos.x; let dz = safeNum(targetPlayerPos.z, 0) - e.pos.z; 
                let distAoAlvo = Math.hypot(dx, dz);
                if (distAoAlvo > 0.01) { e.rotY = Math.atan2(dx, dz); }

                let maxRange = Math.max(...e.ataques.map(a => parseFloat(a.alcance) || 1.8));

                if (distAoAlvo > maxRange) {
                    let dirX = (dx / distAoAlvo) * e.speed; let dirZ = (dz / distAoAlvo) * e.speed;
                    e.pos.x += dirX; e.pos.z += dirZ;
                    db.ref('cenario_inimigos/' + id).update({ pos: e.pos, rotY: e.rotY });
                } else {
                    if (agora - e.ultimoAtaque > e.cooldown) {
                        // Encontra ataques que alcançam o alvo e sorteia um
                        let ataquesValidos = e.ataques.map((a, i) => ({...a, index: i})).filter(a => distAoAlvo <= (parseFloat(a.alcance) || 1.8));
                        
                        if (ataquesValidos.length > 0) {
                            let chosen = ataquesValidos[Math.floor(Math.random() * ataquesValidos.length)];
                            e.ultimoAtaque = agora; 
                            db.ref('cenario_inimigos/' + id).update({
                                rotY: e.rotY,
                                ataqueAtivo: { index: chosen.index, time: agora, tx: safeNum(targetPlayerPos.x, 0), ty: 1.2, tz: safeNum(targetPlayerPos.z, 0) }
                            });
                        } else {
                            // Se nenhum ataque alcança ainda, continua andando
                            let dirX = (dx / distAoAlvo) * e.speed; let dirZ = (dz / distAoAlvo) * e.speed;
                            e.pos.x += dirX; e.pos.z += dirZ;
                            db.ref('cenario_inimigos/' + id).update({ pos: e.pos, rotY: e.rotY });
                        }
                    }
                }
            } else {
                let distDaBase = Math.hypot(e.pos.x - e.spawnPos.x, e.pos.z - e.spawnPos.z);
                let limiteColeira = e.aggroRange * 1.5; let machucado = e.hp < e.hpMax;

                if (machucado && (agora - e.ultimoRegen > 1000)) {
                    e.ultimoRegen = agora; e.hp = Math.min(e.hpMax, e.hp + Math.max(1, Math.floor(e.hpMax * 0.10)));
                    db.ref('cenario_inimigos/' + id).update({ hp: e.hp });
                    if (e.hp >= e.hpMax) e.ignorarAgressao = false; 
                }

                if (distDaBase > limiteColeira || (machucado && e.ignorarAgressao)) { e.retornandoBase = true; e.alvoPatrulha = null; }
                if (distDaBase <= 0.5 && !machucado) { e.retornandoBase = false; }

                if (e.retornandoBase) {
                    if (distDaBase > 0.5) {
                        let dxBase = e.spawnPos.x - e.pos.x; let dzBase = e.spawnPos.z - e.pos.z;
                        e.rotY = Math.atan2(dxBase, dzBase); 
                        let speedVolta = e.speed * 1.5; 
                        e.pos.x += (dxBase / distDaBase) * speedVolta; e.pos.z += (dzBase / distDaBase) * speedVolta; 
                        db.ref('cenario_inimigos/' + id).update({ pos: e.pos, rotY: e.rotY });
                    }
                } else if (e.movimento === 'livre') {
                    if (agora > e.tempoProxPatrulha) {
                        if (!e.alvoPatrulha) {
                            let angulo = Math.random() * Math.PI * 2; let distPasseio = 1.5 + Math.random() * 3.5; 
                            let tX = e.pos.x + Math.sin(angulo) * distPasseio; let tZ = e.pos.z + Math.cos(angulo) * distPasseio;
                            let distPasseioDaBase = Math.hypot(tX - e.spawnPos.x, tZ - e.spawnPos.z);
                            if (distPasseioDaBase > (e.aggroRange * 0.8)) {
                                let dxBase = e.spawnPos.x - e.pos.x; let dzBase = e.spawnPos.z - e.pos.z; let distParaCentro = Math.hypot(dxBase, dzBase);
                                if (distParaCentro > 0.1) { tX = e.pos.x + (dxBase / distParaCentro) * distPasseio; tZ = e.pos.z + (dzBase / distParaCentro) * distPasseio; }
                            }
                            e.alvoPatrulha = { x: tX, z: tZ };
                        } else {
                            let dxP = e.alvoPatrulha.x - e.pos.x; let dzP = e.alvoPatrulha.z - e.pos.z; let distP = Math.hypot(dxP, dzP);
                            if (distP > 0.2) {
                                e.rotY = Math.atan2(dxP, dzP); let speedPatrol = e.speed * 0.5; 
                                e.pos.x += (dxP / distP) * speedPatrol; e.pos.z += (dzP / distP) * speedPatrol; 
                                db.ref('cenario_inimigos/' + id).update({ pos: e.pos, rotY: e.rotY });
                            } else { e.alvoPatrulha = null; e.tempoProxPatrulha = agora + 2000 + Math.random() * 3000; }
                        }
                    }
                }
            }
        } catch(err) { console.error(`Erro no inimigo ${id}:`, err); }
    }
}, 100);
