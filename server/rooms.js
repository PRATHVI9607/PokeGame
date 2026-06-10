// Battle room: wires the engine to sockets, runs the bot, owns turn timers.
const { Battle } = require('../engine/battle');
const { generateRandomTeam } = require('../engine/random-teams');
const bot = require('./bot');

const TURN_TIMER_MS = 120 * 1000;

class BattleRoom {
  /**
   * players: two of { kind:'human', socketId, name } | { kind:'bot', name, apiKey }
   */
  constructor(io, id, players, opts = {}) {
    this.io = io;
    this.id = id;
    this.players = players;
    this.opts = opts;          // { mode:'random'|'team', teams:[t1,t2] }
    this.battle = null;
    this.timer = null;
    this.timerDeadline = 0;
    this.rematchReady = [false, false];
    this.over = false;
    this.botBusy = false;
    this.onEnd = opts.onEnd || (() => {});
  }

  channel() { return `room:${this.id}`; }

  async start() {
    const teams = [];
    for (let i = 0; i < 2; i++) {
      teams[i] = this.opts.teams && this.opts.teams[i]
        ? this.opts.teams[i]
        : await generateRandomTeam();
    }
    this.battle = new Battle(
      { name: this.players[0].name, team: teams[0] },
      { name: this.players[1].name, team: teams[1] },
      { gameType: this.opts.gameType === 'doubles' ? 'doubles' : 'singles' },
    );
    this.over = false;
    this.rematchReady = [false, false];
    for (const p of this.players) p.lastRqidSent = -1;
    for (const [i, p] of this.players.entries()) {
      if (p.kind === 'human') {
        const sock = this.io.sockets.sockets.get(p.socketId);
        if (sock) {
          sock.join(this.channel());
          sock.emit('battle:start', {
            roomId: this.id,
            yourSide: i,
            gameType: this.battle ? this.battle.gameType : (this.opts.gameType || 'singles'),
            players: this.players.map(pl => ({ name: pl.name, bot: pl.kind === 'bot' })),
          });
        }
      }
    }
    this.battle.start();
    this.flush();
    if (this.players.some(p => p.kind === 'bot')) {
      const apiKey = this.players.find(p => p.kind === 'bot').apiKey || process.env.GEMINI_API_KEY;
      bot.botChat('start', apiKey).then(msg => this.chat(this.botName(), msg));
    }
  }

  botName() { return this.players.find(p => p.kind === 'bot')?.name || 'Bot'; }

  needsChoice(i) {
    const b = this.battle;
    if (!b || b.ended) return false;
    const side = b.sides[i];
    if (b.phase === 'replace') return side.needsSwitch.some(Boolean) && !side.choices;
    return !side.choices && side.aliveActives().length > 0;
  }

  flush() {
    const lines = this.battle.takeOutbox();
    if (lines.length) this.io.to(this.channel()).emit('battle:log', { roomId: this.id, lines });
    if (this.battle.ended) {
      this.endBattle(lines);
      return;
    }
    this.sendRequests();
    this.armTimer();
    this.runBot(lines);
  }

  sendRequests() {
    for (const [i, p] of this.players.entries()) {
      if (p.kind !== 'human') continue;
      const sock = this.io.sockets.sockets.get(p.socketId);
      if (!sock) continue;
      const req = this.battle.makeRequest(i);
      // only send each decision point once (rqid bumps on every phase change),
      // otherwise clients can be prompted twice for the same turn
      if (p.lastRqidSent === req.rqid) continue;
      p.lastRqidSent = req.rqid;
      req.deadline = this.timerDeadline;
      sock.emit('battle:request', { roomId: this.id, request: req, needsAction: this.needsChoice(i) });
    }
  }

  async runBot(recentLines = []) {
    const botIdx = this.players.findIndex(p => p.kind === 'bot');
    if (botIdx < 0 || this.botBusy) return;
    const apiKey = this.players[botIdx].apiKey || process.env.GEMINI_API_KEY;

    // commentary on faints
    const humanIdx = 1 - botIdx;
    for (const line of recentLines) {
      if (line.startsWith(`|faint|p${humanIdx + 1}a`)) {
        bot.botChat('ko', apiKey).then(m => this.chat(this.botName(), m));
      } else if (line.startsWith(`|faint|p${botIdx + 1}a`)) {
        if (Math.random() < 0.5) bot.botChat('lost_mon', apiKey).then(m => this.chat(this.botName(), m));
      }
    }

    if (!this.needsChoice(botIdx)) return;
    this.botBusy = true;
    try {
      // small human-feel delay
      await new Promise(r => setTimeout(r, 600 + Math.random() * 900));
      if (this.over || !this.needsChoice(botIdx)) return;
      const { choice } = await bot.decide(this.battle, botIdx, apiKey);
      if (!choice) return;
      const res = this.battle.choose(botIdx, choice);
      if (res.error) {
        const fallback = bot.heuristicChoice(this.battle, botIdx);
        if (fallback) this.battle.choose(botIdx, fallback);
      }
    } finally {
      this.botBusy = false;
    }
    this.flush();
  }

  handleChoice(socketId, choice) {
    const i = this.players.findIndex(p => p.kind === 'human' && p.socketId === socketId);
    if (i < 0 || !this.battle || this.battle.ended) return;
    if (!this.needsChoice(i)) return;
    const res = this.battle.choose(i, choice);
    if (res.error) {
      const sock = this.io.sockets.sockets.get(socketId);
      if (sock) sock.emit('battle:error', { roomId: this.id, error: res.error });
      return;
    }
    this.flush();
  }

  armTimer() {
    clearTimeout(this.timer);
    this.timerDeadline = Date.now() + TURN_TIMER_MS;
    this.timer = setTimeout(() => this.onTimeout(), TURN_TIMER_MS + 500);
  }

  onTimeout() {
    if (!this.battle || this.battle.ended || this.over) return;
    let acted = false;
    for (let i = 0; i < 2; i++) {
      if (this.needsChoice(i)) {
        const choice = bot.heuristicChoice(this.battle, i);
        if (choice) { this.battle.choose(i, choice); acted = true; }
      }
    }
    if (acted) {
      this.io.to(this.channel()).emit('battle:chat', { from: 'System', msg: 'Turn timer expired: a move was chosen automatically.' });
      this.flush();
    }
  }

  chat(from, msg) {
    if (!msg) return;
    this.io.to(this.channel()).emit('battle:chat', { roomId: this.id, from, msg: String(msg).slice(0, 300) });
  }

  forfeit(socketId) {
    const i = this.players.findIndex(p => p.kind === 'human' && p.socketId === socketId);
    if (i < 0 || !this.battle || this.battle.ended) return;
    const winner = this.players[1 - i].name;
    this.battle.ended = true;
    this.battle.winner = winner;
    this.battle.log(`|-message|${this.players[i].name} forfeited.`);
    this.battle.log(`|win|${winner}`);
    this.flush();
  }

  endBattle(lines) {
    if (this.over) return;
    this.over = true;
    clearTimeout(this.timer);
    const botIdx = this.players.findIndex(p => p.kind === 'bot');
    if (botIdx >= 0) {
      const apiKey = this.players[botIdx].apiKey || process.env.GEMINI_API_KEY;
      const botWon = this.battle.winner === this.players[botIdx].name;
      bot.botChat(botWon ? 'win' : 'loss', apiKey).then(m => this.chat(this.botName(), m));
    }
    this.io.to(this.channel()).emit('battle:end', { roomId: this.id, winner: this.battle.winner });
    this.onEnd(this);
  }

  requestRematch(socketId) {
    const i = this.players.findIndex(p => p.kind === 'human' && p.socketId === socketId);
    if (i < 0 || !this.over) return;
    this.rematchReady[i] = true;
    const botIdx = this.players.findIndex(p => p.kind === 'bot');
    if (botIdx >= 0) this.rematchReady[botIdx] = true;
    this.io.to(this.channel()).emit('battle:rematch-status', { ready: this.rematchReady });
    if (this.rematchReady.every(Boolean)) {
      // fresh random teams in random mode; same teams in team mode
      if (this.opts.mode === 'random') this.opts.teams = null;
      this.start();
    }
  }

  handleDisconnect(socketId) {
    const i = this.players.findIndex(p => p.kind === 'human' && p.socketId === socketId);
    if (i < 0) return;
    if (!this.over && this.battle && !this.battle.ended) {
      const winner = this.players[1 - i].name;
      this.battle.ended = true;
      this.battle.winner = winner;
      this.battle.log(`|-message|${this.players[i].name} disconnected.`);
      this.battle.log(`|win|${winner}`);
      this.flush();
    } else {
      this.onEnd(this);
    }
  }

  destroy() {
    clearTimeout(this.timer);
  }
}

module.exports = { BattleRoom };
