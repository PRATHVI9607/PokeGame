// PokeArena server: static client, dex REST API, lobby + matchmaking + battles.
const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const { Dex, toID, NATURES, TYPES } = require('../engine/data');
const { generateRandomTeam } = require('../engine/random-teams');
const { validateTeam } = require('./teams');
const { BattleRoom } = require('./rooms');
const db = require('./db');
const auth = require('./auth');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.json({ limit: '512kb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));
auth.mount(app);

// ---------- dex REST API (data for the team builder) ----------
let pokedexCache = null;
app.get('/api/pokedex', (req, res) => {
  if (!pokedexCache) {
    pokedexCache = Dex.species.all()
      .filter(s => s.num > 0 && !s.isMega && !s.name.endsWith('-Gmax') && !s.battleOnly && !(s.forme || '').includes('Totem'))
      .map(s => ({
        id: s.id, name: s.name, num: s.num, types: s.types,
        baseStats: s.baseStats, abilities: Object.values(s.abilities).filter(Boolean),
        nfe: !!s.nfe,
      }));
  }
  res.json(pokedexCache);
});

const speciesCache = new Map();
app.get('/api/species/:id', async (req, res) => {
  const id = toID(req.params.id);
  if (speciesCache.has(id)) return res.json(speciesCache.get(id));
  const s = Dex.species.get(id);
  if (!s || !s.exists) return res.status(404).json({ error: 'Unknown species' });
  // learnset incl. pre-evolutions
  const moveIds = new Set();
  let cur = s, guard = 0;
  while (cur && guard++ < 8) {
    const ls = await Dex.learnsets.get(cur.id);
    if (ls && ls.learnset) for (const m of Object.keys(ls.learnset)) moveIds.add(m);
    if ((!ls || !ls.learnset) && toID(cur.baseSpecies) !== cur.id) {
      const bls = await Dex.learnsets.get(toID(cur.baseSpecies));
      if (bls && bls.learnset) for (const m of Object.keys(bls.learnset)) moveIds.add(m);
    }
    cur = cur.prevo ? Dex.species.get(cur.prevo) : null;
  }
  const moves = [...moveIds].map(mid => {
    const m = Dex.moves.get(mid);
    if (!m || !m.exists) return null;
    return {
      id: m.id, name: m.name, type: m.type, category: m.category,
      basePower: m.basePower, accuracy: m.accuracy === true ? '—' : m.accuracy,
      pp: m.pp, desc: m.shortDesc || m.desc || '', priority: m.priority,
    };
  }).filter(Boolean).sort((a, b) => a.name.localeCompare(b.name));
  const payload = {
    id: s.id, name: s.name, num: s.num, types: s.types, baseStats: s.baseStats,
    abilities: Object.values(s.abilities).filter(Boolean), weightkg: s.weightkg, moves,
  };
  speciesCache.set(id, payload);
  res.json(payload);
});

let itemsCache = null;
app.get('/api/items', (req, res) => {
  if (!itemsCache) {
    const COMMON = [
      'leftovers', 'lifeorb', 'choiceband', 'choicespecs', 'choicescarf', 'focussash',
      'assaultvest', 'eviolite', 'rockyhelmet', 'heavydutyboots', 'expertbelt', 'muscleband',
      'wiseglasses', 'sitrusberry', 'lumberry', 'chestoberry', 'weaknesspolicy', 'airballoon',
      'lightclay', 'flameorb', 'toxicorb', 'blacksludge', 'safetygoggles', 'protectivepads',
      'boosterenergy', 'scopelens', 'razorclaw', 'bigroot', 'blunderpolicy', 'terrainextender',
      'heatrock', 'damprock', 'smoothrock', 'icyrock', 'widelens', 'ironball',
      'charcoal', 'mysticwater', 'magnet', 'miracleseed', 'nevermeltice', 'blackbelt',
      'poisonbarb', 'softsand', 'sharpbeak', 'twistedspoon', 'silverpowder', 'hardstone',
      'spelltag', 'dragonfang', 'blackglasses', 'metalcoat', 'silkscarf', 'fairyfeather',
    ];
    const list = [];
    for (const it of Dex.items.all()) {
      const isMega = !!it.megaStone;
      const isZ = it.zMove === true && !!it.zMoveType;
      if (!isMega && !isZ && !COMMON.includes(it.id)) continue;
      list.push({
        id: it.id, name: it.name, desc: it.shortDesc || it.desc || '',
        megaStone: isMega ? it.megaStone : null, megaEvolves: it.megaEvolves || null,
        zMoveType: isZ ? it.zMoveType : null,
      });
    }
    list.sort((a, b) => a.name.localeCompare(b.name));
    itemsCache = list;
  }
  res.json(itemsCache);
});

app.get('/api/natures', (req, res) => res.json(NATURES));
app.get('/api/types', (req, res) => res.json(TYPES));
app.get('/api/randomteam', async (req, res) => {
  res.json(await generateRandomTeam());
});
app.post('/api/validateteam', async (req, res) => {
  res.json(await validateTeam(req.body && req.body.team));
});

// ---------- lobby / matchmaking ----------
const users = new Map();        // socketId -> {name, status, roomId}
const challenges = new Map();   // challengeId -> {from, to, mode, team}
const coopInvites = new Map();  // coopId -> {initiatorId, partnerId, opp1Id, opp2Id, mode, accepted:Set, declined:bool}
let queue = [];                 // [{socketId, team|null}]
const rooms = new Map();        // roomId -> BattleRoom
let nextRoomId = 1, nextChallengeId = 1, nextCoopId = 1;

function lobbyState() {
  return {
    users: [...users.entries()].map(([id, u]) => ({ id, name: u.name, status: u.status, registered: !!u.registered })),
  };
}
function broadcastLobby() { io.emit('lobby:state', lobbyState()); }

function sanitizeName(name) {
  const n = String(name || '').replace(/[^\w\- .]/g, '').trim().slice(0, 18);
  return n || `Trainer${Math.floor(Math.random() * 9000 + 1000)}`;
}
function uniqueName(base, selfId) {
  let name = base, n = 2;
  const taken = () => [...users.entries()].some(([id, u]) => id !== selfId && u.name === name);
  while (taken()) name = `${base}-${n++}`;
  return name;
}

async function createRoom(playerDefs, opts) {
  const id = nextRoomId++;
  const room = new BattleRoom(io, id, playerDefs, Object.assign({}, opts, {
    onEnd: () => {
      for (const p of playerDefs) {
        if (p.kind === 'human' && users.has(p.socketId)) {
          users.get(p.socketId).status = 'lobby';
        }
      }
      broadcastLobby();
    },
  }));
  rooms.set(id, room);
  for (const p of playerDefs) {
    if (p.kind === 'human' && users.has(p.socketId)) {
      const u = users.get(p.socketId);
      u.status = 'battle';
      u.roomId = id;
    }
  }
  broadcastLobby();
  try {
    await room.start();
  } catch (e) {
    console.error('room start failed', e);
    io.to(room.channel()).emit('battle:error', { error: 'Failed to start battle: ' + e.message });
    rooms.delete(id);
  }
  return room;
}

io.on('connection', (socket) => {
  socket.on('lobby:join', ({ name, token } = {}) => {
    // a valid account token wins over the free-form name and gets a badge
    const account = token ? db.verifyToken(token) : null;
    const base = account ? account.username : sanitizeName(name);
    const finalName = uniqueName(account ? base : sanitizeName(base), socket.id);
    users.set(socket.id, { name: finalName, status: 'lobby', roomId: null, registered: !!account });
    socket.emit('lobby:joined', { name: finalName, id: socket.id, registered: !!account });
    broadcastLobby();
  });

  socket.on('lobby:challenge', async ({ to, mode, team, gameType } = {}) => {
    const from = users.get(socket.id);
    const target = users.get(to);
    if (!from || !target || to === socket.id) return;
    if (mode === 'team') {
      const v = await validateTeam(team);
      if (!v.ok) return socket.emit('lobby:error', { error: v.errors.join('; ') });
    }
    const gt = gameType === 'doubles' ? 'doubles' : 'singles';
    const id = nextChallengeId++;
    challenges.set(id, { from: socket.id, to, mode: mode === 'team' ? 'team' : 'random', team, gameType: gt });
    io.to(to).emit('lobby:challenged', { id, fromName: from.name, mode: mode === 'team' ? 'team' : 'random', gameType: gt });
    socket.emit('lobby:challenge-sent', { id, toName: target.name });
  });

  socket.on('lobby:accept', async ({ id, team } = {}) => {
    const ch = challenges.get(id);
    if (!ch || ch.to !== socket.id) return;
    challenges.delete(id);
    const challenger = users.get(ch.from);
    const acceptor = users.get(socket.id);
    if (!challenger || !acceptor) return;
    let teams = null;
    if (ch.mode === 'team') {
      const v = await validateTeam(team);
      if (!v.ok) return socket.emit('lobby:error', { error: 'Your team: ' + v.errors.join('; ') });
      teams = [ch.team, team];
    }
    await createRoom([
      { kind: 'human', socketId: ch.from, name: challenger.name },
      { kind: 'human', socketId: socket.id, name: acceptor.name },
    ], { mode: ch.mode, teams, gameType: ch.gameType });
  });

  socket.on('lobby:decline', ({ id } = {}) => {
    const ch = challenges.get(id);
    if (!ch || ch.to !== socket.id) return;
    challenges.delete(id);
    const decliner = users.get(socket.id);
    io.to(ch.from).emit('lobby:declined', { byName: decliner ? decliner.name : 'Opponent' });
  });

  socket.on('queue:join', async ({ team, gameType } = {}) => {
    const u = users.get(socket.id);
    if (!u || u.status !== 'lobby') return;
    if (queue.some(q => q.socketId === socket.id)) return;
    let validTeam = null;
    if (team) {
      const v = await validateTeam(team);
      if (v.ok) validTeam = team;
    }
    const gt = gameType === 'doubles' ? 'doubles' : 'singles';
    queue.push({ socketId: socket.id, team: validTeam, gameType: gt });
    u.status = 'queue';
    socket.emit('queue:waiting');
    broadcastLobby();
    // pair two queued players wanting the same format
    const matchIdx = queue.findIndex(q => q.socketId !== socket.id && q.gameType === gt);
    if (matchIdx >= 0) {
      const other = queue.splice(matchIdx, 1)[0];
      queue = queue.filter(q => q.socketId !== socket.id);
      const ua = users.get(other.socketId), ub = users.get(socket.id);
      if (!ua || !ub) { if (ua) queue.unshift(other); return; }
      await createRoom([
        { kind: 'human', socketId: other.socketId, name: ua.name },
        { kind: 'human', socketId: socket.id, name: ub.name },
      ], { mode: 'random', teams: (other.team || validTeam) ? [other.team, validTeam] : null, gameType: gt });
    }
  });

  socket.on('queue:leave', () => {
    queue = queue.filter(q => q.socketId !== socket.id);
    const u = users.get(socket.id);
    if (u && u.status === 'queue') u.status = 'lobby';
    broadcastLobby();
  });

  socket.on('bot:start', async ({ mode, team, apiKey, gameType } = {}) => {
    const u = users.get(socket.id);
    if (!u || u.status === 'battle') return;
    let teams = null;
    if (mode === 'team' && team) {
      const v = await validateTeam(team);
      if (!v.ok) return socket.emit('lobby:error', { error: v.errors.join('; ') });
      teams = [team, null];
    }
    const key = typeof apiKey === 'string' && apiKey.trim() ? apiKey.trim() : null;
    await createRoom([
      { kind: 'human', socketId: socket.id, name: u.name },
      { kind: 'bot', name: key ? 'Gemini Ace' : 'Trainer AI', apiKey: key },
    ], { mode: mode === 'team' ? 'team' : 'random', teams, gameType: gameType === 'doubles' ? 'doubles' : 'singles' });
  });

  socket.on('battle:choice', ({ roomId, choice } = {}) => {
    const room = rooms.get(roomId);
    if (room) room.handleChoice(socket.id, choice);
  });
  socket.on('battle:forfeit', ({ roomId } = {}) => {
    const room = rooms.get(roomId);
    if (room) room.forfeit(socket.id);
  });
  socket.on('battle:rematch', ({ roomId } = {}) => {
    const room = rooms.get(roomId);
    if (room) room.requestRematch(socket.id);
  });
  socket.on('battle:chat', ({ roomId, msg } = {}) => {
    const room = rooms.get(roomId);
    const u = users.get(socket.id);
    if (room && u && typeof msg === 'string' && msg.trim()) room.chat(u.name, msg.trim());
  });
  socket.on('battle:leave', ({ roomId } = {}) => {
    const room = rooms.get(roomId);
    if (room) {
      room.forfeit(socket.id);
      socket.leave(room.channel());
      const u = users.get(socket.id);
      if (u) { u.status = 'lobby'; u.roomId = null; }
      broadcastLobby();
    }
  });

  // ---------- co-op doubles -----------------------------------------------
  socket.on('lobby:challenge-coop', ({ partnerId, opp1Id, opp2Id, mode } = {}) => {
    const from = users.get(socket.id);
    if (!from || from.status !== 'lobby') return;
    const partner = users.get(partnerId);
    const opp1 = users.get(opp1Id);
    const opp2 = users.get(opp2Id);
    if (!partner || !opp1 || !opp2) return socket.emit('lobby:error', { error: 'One or more trainers went offline.' });
    if ([partnerId, opp1Id, opp2Id].some(id => !id || id === socket.id))
      return socket.emit('lobby:error', { error: 'Invalid selection.' });
    const unique = new Set([partnerId, opp1Id, opp2Id]);
    if (unique.size < 3) return socket.emit('lobby:error', { error: 'Please pick 3 different trainers.' });
    if ([partner, opp1, opp2].some(u => u.status !== 'lobby'))
      return socket.emit('lobby:error', { error: 'One or more trainers is busy.' });

    const id = nextCoopId++;
    coopInvites.set(id, {
      initiatorId: socket.id, partnerId, opp1Id, opp2Id,
      mode: mode === 'team' ? 'team' : 'random',
      accepted: new Set([socket.id]),
      declined: false,
    });
    const invitePayload = (role) => ({ id, fromName: from.name, role, gameType: 'doubles' });
    io.to(partnerId).emit('lobby:coop-challenged', invitePayload('partner'));
    io.to(opp1Id).emit('lobby:coop-challenged', invitePayload('opponent'));
    io.to(opp2Id).emit('lobby:coop-challenged', invitePayload('opponent'));
    socket.emit('lobby:coop-invite-sent', { id, partnerName: partner.name, opp1Name: opp1.name, opp2Name: opp2.name });
  });

  socket.on('lobby:coop-accept', async ({ id } = {}) => {
    const inv = coopInvites.get(id);
    if (!inv || inv.declined) return;
    const allIds = [inv.initiatorId, inv.partnerId, inv.opp1Id, inv.opp2Id];
    if (!allIds.includes(socket.id)) return;
    inv.accepted.add(socket.id);
    if (inv.accepted.size < 4) return;

    // All 4 accepted — start the room
    coopInvites.delete(id);
    const uList = allIds.map(sid => ({ user: users.get(sid), sid }));
    if (uList.some(({ user }) => !user)) return;

    await createRoom([
      { kind: 'human', socketId: uList[0].sid, name: uList[0].user.name, coopSlot: 0 },
      { kind: 'human', socketId: uList[1].sid, name: uList[1].user.name, coopSlot: 1 },
      { kind: 'human', socketId: uList[2].sid, name: uList[2].user.name, coopSlot: 0 },
      { kind: 'human', socketId: uList[3].sid, name: uList[3].user.name, coopSlot: 1 },
    ], { mode: inv.mode, gameType: 'doubles', coopMode: true });
  });

  socket.on('lobby:coop-decline', ({ id } = {}) => {
    const inv = coopInvites.get(id);
    if (!inv) return;
    inv.declined = true;
    coopInvites.delete(id);
    const decliner = users.get(socket.id);
    const byName = decliner?.name || 'Someone';
    const allIds = [inv.initiatorId, inv.partnerId, inv.opp1Id, inv.opp2Id];
    for (const sid of allIds) {
      if (sid !== socket.id) io.to(sid).emit('lobby:coop-cancelled', { byName });
    }
  });
  // -------------------------------------------------------------------------

  socket.on('disconnect', () => {
    queue = queue.filter(q => q.socketId !== socket.id);
    const u = users.get(socket.id);
    if (u && u.roomId && rooms.has(u.roomId)) {
      rooms.get(u.roomId).handleDisconnect(socket.id);
    }
    // expire challenges involving this socket
    for (const [id, ch] of challenges) {
      if (ch.from === socket.id || ch.to === socket.id) challenges.delete(id);
    }
    // expire co-op invites involving this socket
    for (const [id, inv] of coopInvites) {
      const allIds = [inv.initiatorId, inv.partnerId, inv.opp1Id, inv.opp2Id];
      if (allIds.includes(socket.id)) {
        inv.declined = true;
        coopInvites.delete(id);
        for (const sid of allIds) {
          if (sid !== socket.id) io.to(sid).emit('lobby:coop-cancelled', { byName: 'a disconnected trainer' });
        }
      }
    }
    users.delete(socket.id);
    broadcastLobby();
  });
});

// periodic room cleanup (finished > 10 min ago with no sockets)
setInterval(() => {
  for (const [id, room] of rooms) {
    if (room.over) {
      const sockets = io.sockets.adapter.rooms.get(room.channel());
      if (!sockets || sockets.size === 0) {
        room.destroy();
        rooms.delete(id);
      }
    }
  }
}, 10 * 60 * 1000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`PokeArena listening on http://localhost:${PORT}`));
