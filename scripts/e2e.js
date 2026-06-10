// End-to-end test: boots the real server, exercises auth + team sync, then
// plays a full PvP singles battle via the queue and a doubles bot battle.
process.env.PORT = process.env.PORT || '3105';
process.env.DATABASE_PATH = process.env.DATABASE_PATH || require('path').join(__dirname, 'e2e-test.db');
const fs = require('fs');
try { fs.unlinkSync(process.env.DATABASE_PATH); } catch {}
try { fs.unlinkSync(process.env.DATABASE_PATH + '-wal'); } catch {}
try { fs.unlinkSync(process.env.DATABASE_PATH + '-shm'); } catch {}

require('../server/index');
const { io } = require('socket.io-client');

const URL = `http://localhost:${process.env.PORT}`;
const log = (...a) => console.log(...a);

function buildActions(p, request, numActives) {
  const actions = new Array(numActives).fill(null);
  if (request.forceSwitch) {
    const used = new Set();
    request.forceSwitch.forEach((needs, slot) => {
      if (!needs) return;
      const i = request.side.pokemon.findIndex((pk, idx) =>
        !pk.active && !pk.condition.includes('fnt') && !used.has(idx));
      if (i >= 0) { used.add(i); actions[slot] = { action: 'switch', target: i }; }
    });
    return actions;
  }
  let gimmickUsed = false;
  (request.actives || []).forEach((active, slot) => {
    if (!active) return;
    const moves = active.moves.map((m, i) => ({ m, i })).filter(x => !x.m.disabled);
    if (!moves.length) return;
    const pick = moves[Math.floor(Math.random() * moves.length)].i;
    const a = { action: 'move', move: pick };
    if (!gimmickUsed) {
      if (active.canTera && Math.random() < 0.3) { a.gimmick = 'tera'; gimmickUsed = true; }
      else if (active.canMega) { a.gimmick = 'mega'; gimmickUsed = true; }
      else if (active.canDynamax && Math.random() < 0.3) { a.gimmick = 'dynamax'; gimmickUsed = true; }
    }
    actions[slot] = a;
  });
  return actions;
}

function makePlayer(name, gameType = 'singles') {
  const sock = io(URL, { transports: ['websocket'] });
  const numActives = gameType === 'doubles' ? 2 : 1;
  const p = { name, sock, roomId: null, done: false, lines: 0 };
  sock.on('connect', () => sock.emit('lobby:join', { name }));
  sock.on('battle:start', (data) => {
    p.roomId = data.roomId;
    log(`${name}: battle started (${data.gameType}), side ${data.yourSide}`);
  });
  sock.on('battle:log', ({ lines }) => { p.lines += lines.length; });
  sock.on('battle:request', ({ request, needsAction }) => {
    if (!needsAction || p.done) return;
    const actions = buildActions(p, request, numActives);
    if (actions.some(Boolean)) {
      sock.emit('battle:choice', { roomId: p.roomId, choice: { actions } });
    }
  });
  sock.on('battle:error', ({ error }) => log(`${name}: ERROR ${error}`));
  return p;
}

async function waitFor(cond, timeoutMs, what) {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > timeoutMs) throw new Error('Timeout waiting for ' + what);
    await new Promise(r => setTimeout(r, 200));
  }
}

async function jsonReq(path, opts = {}) {
  const res = await fetch(URL + path, Object.assign({
    headers: { 'Content-Type': 'application/json' },
  }, opts));
  const data = await res.json();
  return { status: res.status, data };
}

(async () => {
  await new Promise(r => setTimeout(r, 800));

  // ---- auth + team storage ----
  let r = await jsonReq('/api/auth/register', { method: 'POST', body: JSON.stringify({ username: 'RedTrainer', password: 'pikachu123' }) });
  if (r.status !== 200 || !r.data.token) throw new Error('register failed: ' + JSON.stringify(r.data));
  const token = r.data.token;
  log('auth: registered RedTrainer');
  r = await jsonReq('/api/auth/login', { method: 'POST', body: JSON.stringify({ username: 'RedTrainer', password: 'wrongpass' }) });
  if (r.status !== 401) throw new Error('bad password was accepted!');
  log('auth: wrong password correctly rejected');
  r = await jsonReq('/api/teams', { method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: JSON.stringify({ teams: [{ id: 1, name: 'Test', sets: [] }] }) });
  if (r.status !== 200) throw new Error('team save failed');
  r = await jsonReq('/api/teams', { headers: { Authorization: 'Bearer ' + token } });
  if (!r.data.teams || r.data.teams[0].name !== 'Test') throw new Error('team load failed');
  log('auth: cloud team save/load round-trip OK');
  r = await jsonReq('/api/teams');
  if (r.status !== 401) throw new Error('unauthenticated team access allowed!');
  log('auth: unauthenticated access correctly rejected');

  // ---- PvP singles via queue ----
  const a = makePlayer('Ash');
  const b = makePlayer('Misty');
  let winner = null;
  a.sock.on('battle:end', ({ winner: w }) => { winner = w; a.done = true; b.done = true; });
  await waitFor(() => a.sock.connected && b.sock.connected, 5000, 'connections');
  a.sock.emit('queue:join', { gameType: 'singles' });
  b.sock.emit('queue:join', { gameType: 'singles' });
  await waitFor(() => a.roomId && b.roomId, 8000, 'match start');
  await waitFor(() => winner, 120000, 'pvp battle end');
  log(`PvP singles finished: winner ${winner}, ${a.lines} log lines`);
  a.sock.disconnect(); b.sock.disconnect();

  // ---- DOUBLES bot battle (heuristic) ----
  const c = makePlayer('Brock', 'doubles');
  let botWinner = null;
  c.sock.on('battle:end', ({ winner: w }) => { botWinner = w; c.done = true; });
  c.sock.on('battle:chat', ({ from, msg }) => log(`  [chat] ${from}: ${msg}`));
  await waitFor(() => c.sock.connected, 5000, 'bot client connect');
  await new Promise(r2 => setTimeout(r2, 400));
  c.sock.emit('bot:start', { mode: 'random', gameType: 'doubles' });
  await waitFor(() => c.roomId, 8000, 'doubles bot battle start');
  await waitFor(() => botWinner, 180000, 'doubles bot battle end');
  log(`Doubles bot battle finished: winner ${botWinner}`);
  c.sock.disconnect();

  log('\nE2E OK');
  process.exit(0);
})().catch(e => { console.error('E2E FAILED:', e); process.exit(1); });
