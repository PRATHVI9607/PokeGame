// End-to-end test: boots the real server, connects two socket clients through
// the matchmaking queue, plays a full random battle, then runs a bot battle.
process.env.PORT = process.env.PORT || '3105';
require('../server/index');
const { io } = require('socket.io-client');

const URL = `http://localhost:${process.env.PORT}`;
const log = (...a) => console.log(...a);

function makePlayer(name) {
  const sock = io(URL, { transports: ['websocket'] });
  const p = { name, sock, side: null, roomId: null, request: null, done: false, lines: 0 };
  sock.on('connect', () => sock.emit('lobby:join', { name }));
  sock.on('battle:start', (data) => {
    p.roomId = data.roomId;
    p.side = data.yourSide;
    log(`${name}: battle started, side ${data.yourSide} vs ${data.players[1 - data.yourSide].name}`);
  });
  sock.on('battle:log', ({ lines }) => { p.lines += lines.length; });
  sock.on('battle:request', ({ request, needsAction }) => {
    p.request = request;
    if (!needsAction || p.done) return;
    // pick an action
    if (request.forceSwitch) {
      const i = request.side.pokemon.findIndex(pk => !pk.active && !pk.condition.includes('fnt'));
      if (i >= 0) sock.emit('battle:choice', { roomId: p.roomId, choice: { action: 'switch', target: i } });
      return;
    }
    if (!request.active) return;
    const moves = request.active.moves.map((m, i) => ({ m, i })).filter(x => !x.m.disabled);
    if (!moves.length) return;
    const pick = moves[Math.floor(Math.random() * moves.length)].i;
    const choice = { action: 'move', move: pick };
    if (request.active.canTera && Math.random() < 0.3) choice.gimmick = 'tera';
    else if (request.active.canMega) choice.gimmick = 'mega';
    else if (request.active.canDynamax && Math.random() < 0.3) choice.gimmick = 'dynamax';
    sock.emit('battle:choice', { roomId: p.roomId, choice });
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

(async () => {
  await new Promise(r => setTimeout(r, 800));

  // ---- PvP via queue ----
  const a = makePlayer('Ash');
  const b = makePlayer('Misty');
  let winner = null;
  a.sock.on('battle:end', ({ winner: w }) => { winner = w; a.done = true; b.done = true; });
  await waitFor(() => a.sock.connected && b.sock.connected, 5000, 'connections');
  a.sock.emit('queue:join', {});
  b.sock.emit('queue:join', {});
  await waitFor(() => a.roomId && b.roomId, 8000, 'match start');
  await waitFor(() => winner, 120000, 'pvp battle end');
  log(`PvP battle finished: winner ${winner}, ${a.lines} log lines seen by Ash`);
  a.sock.disconnect(); b.sock.disconnect();

  // ---- bot battle (heuristic, no API key) ----
  const c = makePlayer('Brock');
  let botWinner = null;
  let botChats = 0;
  c.sock.on('battle:end', ({ winner: w }) => { botWinner = w; c.done = true; });
  c.sock.on('battle:chat', ({ from, msg }) => { botChats++; log(`  [chat] ${from}: ${msg}`); });
  await waitFor(() => c.sock.connected, 5000, 'bot client connect');
  await new Promise(r => setTimeout(r, 400));
  c.sock.emit('bot:start', { mode: 'random' });
  await waitFor(() => c.roomId, 8000, 'bot battle start');
  await waitFor(() => botWinner, 180000, 'bot battle end');
  log(`Bot battle finished: winner ${botWinner}, chats: ${botChats}`);
  c.sock.disconnect();

  log('\nE2E OK');
  process.exit(0);
})().catch (e => { console.error('E2E FAILED:', e); process.exit(1); });
