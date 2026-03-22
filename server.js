const express = require('express');
const admin = require("firebase-admin");
const serviceAccount = require("./serviceAccountKey.json");

const app = express();
const port = process.env.PORT || 3000;

app.get('/', (req, res) => { res.send('🔥 Servidor RPG VIVO: Visão Perfeita, Perseguição, Regen e Amnésia Total Ativados!'); });
app.listen(port, () => { console.log(`🌐 Servidor escutando na porta ${port}`); });

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: "https://rpg-vr-online-default-rtdb.firebaseio.com"
});

const db = admin.database();

let estadoInimigos = {};
let jogadoresAtivos = {};

// VIGIA DE JOGADORES: Detecta Morte ou Desconexão para Amnésia Total
db.ref('players').on('value', snap => { 
    let novosJogadores = snap.val() || {}; 
    
    for (let eId in estadoInimigos) {
        let e = estadoInimigos[eId];
        // Se o inimigo estava caçando alguém...
        if (e.currentTarget) {
            let p = novosJogadores[e.currentTarget];
            // ... e esse alguém morreu ou desconectou
            if (!p || p.vivo === false) {
                console.log(`💀 Jogador ${e.currentTarget} caiu. Inimigo ${eId} perdendo o alvo...`);
                e.currentTarget = null;
                // Se for um inimigo pacífico, ele esquece a vingança e volta a ser calmo
                if (e.comportamento === 'pacifico') {
                    e.ignorarAgressao = true;
                }
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
        currentTarget: estadoInimigos[id] ? estadoInimigos[id].currentTarget : null,
        retornandoBase: estadoInimigos[id] ? estadoInimigos[id].retornandoBase : false,
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
        
        // Se tomou dano, descobre quem bateu e foca nele!
        if (newData.hp < hpAntigo && data.ultimoAtacante) {
            newData.currentTarget = data.ultimoAtacante;
            newData.retornandoBase = false; 
            newData.ignorarAgressao = false; // Volta a ficar zangado
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
                else if (agora - e.mortoEm >= e.respawnTime) { e.hp = e.hpMax; e.mortoEm = null; e.pos = { ...e.spawnPos }; e.currentTarget = null; e.alvoPatrulha = null; e.retornandoBase = false; e.ignorarAgressao = false; db.ref('cenario_inimigos/' + id).update({ hp: e.hp, mortoEm: null, pos: e.pos }); }
                continue; 
            }

            let targetPlayerPos = null;

            // 1. Manter a Perseguição Ativa se o alvo atual estiver na Visão e Vivo
            if (e.currentTarget) {
                let p = jogadoresAtivos[e.currentTarget];
                if (p && p.vivo !== false && p.position) {
                    let distTarget = Math.hypot(safeNum(p.position.x, 0) - e.pos.x, safeNum(p.position.z, 0) - e.pos.z);
                    if (distTarget <= e.aggroRange) {
                        targetPlayerPos = p.position; // Continua vendo!
                    } else {
                        e.currentTarget = null; // Fugiu da visão! Alvo perdido.
                        if (e.comportamento === 'pacifico') e.ignorarAgressao = true;
                    }
                } else {
                    e.currentTarget = null; // Jogador não existe mais ou morreu
                    if (e.comportamento === 'pacifico') e.ignorarAgressao = true;
                }
            }

            // 2. Se for Hostil e não tiver alvo, procura alguém vivo na visão
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
                e.retornandoBase = false; // Parar de fugir e atacar!
                e.alvoPatrulha = null; // Interrompe patrulha

                let dx = safeNum(targetPlayerPos.x, 0) - e.pos.x; 
                let dz = safeNum(targetPlayerPos.z, 0) - e.pos.z; 
                let distAoAlvo = Math.hypot(dx, dz);
                
                if (distAoAlvo > 0.01) { e.rotY = Math.atan2(dx, dz); }

                if (distAoAlvo > e.attackRange) {
                    let dirX = (dx / distAoAlvo) * e.speed; 
                    let dirZ = (dz / distAoAlvo) * e.speed;
                    e.pos.x += dirX; e.pos.z += dirZ;
                    db.ref('cenario_inimigos/' + id).update({ pos: e.pos, rotY: e.rotY });
                } else {
                    if (agora - e.ultimoAtaque > e.cooldown) {
                        e.ultimoAtaque = agora; let updateData = { rotY: e.rotY };
                        if (e.tipo === 'atirador') updateData.shoot = { time: agora, tx: safeNum(targetPlayerPos.x, 0), ty: 1.2, tz: safeNum(targetPlayerPos.z, 0) }; 
                        else updateData.meleeAttack = { time: agora };
                        db.ref('cenario_inimigos/' + id).update(updateData);
                    }
                }
            } 
            
            // 4. Ação: Não há alvos. Curar, Voltar Base ou Patrulhar Orgânicamente
            else {
                let distDaBase = Math.hypot(e.pos.x - e.spawnPos.x, e.pos.z - e.spawnPos.z);
                let limiteColeira = e.aggroRange * 1.5;
                let machucado = e.hp < e.hpMax;

                // Cura se estiver machucado (Regen de 10% a cada seg)
                if (machucado && (agora - e.ultimoRegen > 1000)) {
                    e.ultimoRegen = agora;
                    let cura = Math.max(1, Math.floor(e.hpMax * 0.10)); 
                    e.hp = Math.min(e.hpMax, e.hp + cura);
                    db.ref('cenario_inimigos/' + id).update({ hp: e.hp });
                    // Curou 100%? Para de ignorar as pancadas.
                    if (e.hp >= e.hpMax) e.ignorarAgressao = false; 
                }

                // Ativa a obrigação de voltar para a base se estiver fora do limite ou machucado (e ignorando alvos)
                if (distDaBase > limiteColeira || (machucado && e.ignorarAgressao)) {
                    e.retornandoBase = true;
                    e.alvoPatrulha = null; 
                }
                
                if (distDaBase <= 0.5 && !machucado) {
                    e.retornandoBase = false;
                }

                if (e.retornandoBase) {
                    if (distDaBase > 0.5) {
                        let dxBase = e.spawnPos.x - e.pos.x; 
                        let dzBase = e.spawnPos.z - e.pos.z;
                        e.rotY = Math.atan2(dxBase, dzBase); 
                        
                        let speedVolta = e.speed * 1.5; 
                        let dirX = (dxBase / distDaBase) * speedVolta; 
                        let dirZ = (dzBase / distDaBase) * speedVolta;
                        
                        e.pos.x += dirX; e.pos.z += dirZ; 
                        db.ref('cenario_inimigos/' + id).update({ pos: e.pos, rotY: e.rotY });
                    }
                } 
                else if (e.movimento === 'livre') {
                    if (agora > e.tempoProxPatrulha) {
                        if (!e.alvoPatrulha) {
                            let angulo = Math.random() * Math.PI * 2; 
                            let distPasseio = 1.5 + Math.random() * 3.5; 
                            
                            let tX = e.pos.x + Math.sin(angulo) * distPasseio;
                            let tZ = e.pos.z + Math.cos(angulo) * distPasseio;
                            
                            let distPasseioDaBase = Math.hypot(tX - e.spawnPos.x, tZ - e.spawnPos.z);
                            if (distPasseioDaBase > (e.aggroRange * 0.8)) {
                                let dxBase = e.spawnPos.x - e.pos.x;
                                let dzBase = e.spawnPos.z - e.pos.z;
                                let distParaCentro = Math.hypot(dxBase, dzBase);
                                
                                if (distParaCentro > 0.1) {
                                    tX = e.pos.x + (dxBase / distParaCentro) * distPasseio;
                                    tZ = e.pos.z + (dzBase / distParaCentro) * distPasseio;
                                }
                            }
                            
                            e.alvoPatrulha = { x: tX, z: tZ };
                        } else {
                            let dxP = e.alvoPatrulha.x - e.pos.x; 
                            let dzP = e.alvoPatrulha.z - e.pos.z; 
                            let distP = Math.hypot(dxP, dzP);
                            
                            if (distP > 0.2) {
                                e.rotY = Math.atan2(dxP, dzP); 
                                let speedPatrol = e.speed * 0.5; 
                                let dirX = (dxP / distP) * speedPatrol; 
                                let dirZ = (dzP / distP) * speedPatrol;
                                
                                e.pos.x += dirX; e.pos.z += dirZ; 
                                db.ref('cenario_inimigos/' + id).update({ pos: e.pos, rotY: e.rotY });
                            } else {
                                e.alvoPatrulha = null; 
                                e.tempoProxPatrulha = agora + 2000 + Math.random() * 3000;
                            }
                        }
                    }
                }
            }
        } catch(err) { console.error(`Erro no inimigo ${id}:`, err); }
    }
}, 100);
