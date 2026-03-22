const express = require('express');
const admin = require("firebase-admin");
const serviceAccount = require("./serviceAccountKey.json");

const app = express();
const port = process.env.PORT || 3000;

app.get('/', (req, res) => { res.send('🔥 Servidor RPG VIVO: Visão Perfeita, Perseguição, Regen e Amnésia Ativados!'); });
app.listen(port, () => { console.log(`🌐 Servidor escutando na porta ${port}`); });

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: "https://rpg-vr-online-default-rtdb.firebaseio.com"
});

const db = admin.database();

let estadoInimigos = {};
let jogadoresAtivos = {};

// VIGIA DE JOGADORES: Detecta Morte ou Desconexão para Amnésia
db.ref('players').on('value', snap => { 
    let novosJogadores = snap.val() || {}; 
    
    // Se o inimigo estava caçando alguém que morreu ou sumiu, ele esquece a pessoa
    for (let eId in estadoInimigos) {
        let e = estadoInimigos[eId];
        if (e.currentTarget) {
            let p = novosJogadores[e.currentTarget];
            if (!p || p.vivo === false) {
                console.log(`💀 Jogador ${e.currentTarget} caiu. Inimigo ${eId} perdendo o alvo...`);
                e.currentTarget = null;
            }
        }
    }
    jogadoresAtivos = novosJogadores; 
});

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
        tempoProxPatrulha: estadoInimigos[id] ? estadoInimigos[id].tempoProxPatrulha : 0,
        alvoPatrulha: estadoInimigos[id] ? estadoInimigos[id].alvoPatrulha : null,
        
        ultimoRegen: estadoInimigos[id] ? estadoInimigos[id].ultimoRegen : 0,
        currentTarget: estadoInimigos[id] ? estadoInimigos[id].currentTarget : null // Quem ele está caçando
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
        
        // Se a vida diminuiu, pega o ID de quem bateu e foca nele!
        if (newData.hp < hpAntigo && data.ultimoAtacante) {
            estadoInimigos[id].currentTarget = data.ultimoAtacante;
        }
        
        estadoInimigos[id] = { ...estadoInimigos[id], ...newData }; 
    }
});

db.ref('cenario_inimigos').on('child_removed', snap => { delete estadoInimigos[snap.key]; });

setInterval(() => { db.ref('servidor_ia_status').set(Date.now()); }, 2000);

// IA RODANDO A 100ms
setInterval(() => {
    let agora = Date.now();

    for (let id in estadoInimigos) {
        try {
            let e = estadoInimigos[id];
            
            // Tratamento de Morte
            if (e.hp <= 0) {
                if (!e.mortoEm) { e.mortoEm = agora; db.ref('cenario_inimigos/' + id).update({ mortoEm: agora }); } 
                else if (agora - e.mortoEm >= e.respawnTime) { e.hp = e.hpMax; e.mortoEm = null; e.pos = { ...e.spawnPos }; e.currentTarget = null; e.alvoPatrulha = null; db.ref('cenario_inimigos/' + id).update({ hp: e.hp, mortoEm: null, pos: e.pos }); }
                continue; 
            }

            let targetPlayerPos = null;

            // 1. Manter a Perseguição Ativa se o alvo atual estiver na Visão
            if (e.currentTarget) {
                let p = jogadoresAtivos[e.currentTarget];
                if (p && p.vivo !== false && p.position) {
                    let distTarget = Math.hypot(safeNum(p.position.x, 0) - e.pos.x, safeNum(p.position.z, 0) - e.pos.z);
                    if (distTarget <= e.aggroRange) {
                        targetPlayerPos = p.position; // Continua vendo!
                    } else {
                        e.currentTarget = null; // Fugiu da visão! Alvo perdido.
                    }
                } else {
                    e.currentTarget = null; // Jogador não existe mais ou morreu
                }
            }

            // 2. Se for Hostil e não tiver alvo, procura alguém na visão
            if (!e.currentTarget && e.comportamento === 'hostil') {
                let menorDistanciaEncontrada = e.aggroRange;
                for (let pId in jogadoresAtivos) {
                    let p = jogadoresAtivos[pId];
                    if (p.vivo !== false && p.position) {
                        let dist = Math.hypot(safeNum(p.position.x, 0) - e.pos.x, safeNum(p.position.z, 0) - e.pos.z);
                        if (dist <= menorDistanciaEncontrada) {
                            menorDistanciaEncontrada = dist;
                            e.currentTarget = pId; // Marca o jogador como alvo
                            targetPlayerPos = p.position;
                        }
                    }
                }
            }

            // 3. Ação: Perseguir e Atacar
            if (targetPlayerPos) {
                let dx = safeNum(targetPlayerPos.x, 0) - e.pos.x; 
                let dz = safeNum(targetPlayerPos.z, 0) - e.pos.z; 
                let distAoAlvo = Math.hypot(dx, dz);
                
                if (distAoAlvo > 0.01) { e.rotY = Math.atan2(dx, dz); }

                if (distAoAlvo > e.attackRange) {
                    // Correr atrás sem limite de coleira
                    let dirX = (dx / distAoAlvo) * e.speed; 
                    let dirZ = (dz / distAoAlvo) * e.speed;
                    e.pos.x += dirX; e.pos.z += dirZ;
                    db.ref('cenario_inimigos/' + id).update({ pos: e.pos, rotY: e.rotY });
                } else {
                    // Atacar
                    if (agora - e.ultimoAtaque > e.cooldown) {
                        e.ultimoAtaque = agora; let updateData = { rotY: e.rotY };
                        if (e.tipo === 'atirador') updateData.shoot = { time: agora, tx: safeNum(targetPlayerPos.x, 0), ty: 1.2, tz: safeNum(targetPlayerPos.z, 0) }; 
                        else updateData.meleeAttack = { time: agora };
                        db.ref('cenario_inimigos/' + id).update(updateData);
                    }
                }
                e.alvoPatrulha = null; // Interrompe patrulha
            } 
            // 4. Ação: Voltar para base e Curar (Nenhum alvo)
            else {
                let distDaBase = Math.hypot(e.pos.x - e.spawnPos.x, e.pos.z - e.spawnPos.z);

                // Cura se estiver machucado
                if (e.hp < e.hpMax && (agora - e.ultimoRegen > 1000)) {
                    e.ultimoRegen = agora;
                    let cura = Math.max(1, Math.floor(e.hpMax * 0.10)); // Cura 10%
                    e.hp = Math.min(e.hpMax, e.hp + cura);
                    db.ref('cenario_inimigos/' + id).update({ hp: e.hp });
                }

                if (distDaBase > 0.5) {
                    // Andar de volta para o Respawn
                    let dx = e.spawnPos.x - e.pos.x; let dz = e.spawnPos.z - e.pos.z;
                    if (distDaBase > 0.01) {
                        e.rotY = Math.atan2(dx, dz); 
                        let speedVolta = e.speed * 1.5; // Volta correndo um pouco mais rápido
                        let dirX = (dx / distDaBase) * speedVolta; let dirZ = (dz / distDaBase) * speedVolta;
                        e.pos.x += dirX; e.pos.z += dirZ; 
                        db.ref('cenario_inimigos/' + id).update({ pos: e.pos, rotY: e.rotY });
                    }
                } else if (e.movimento === 'livre') {
                    // Chegou na base, voltar a patrulhar
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
        } catch(err) { console.error(`Erro no inimigo ${id}:`, err); }
    }
}, 100);
