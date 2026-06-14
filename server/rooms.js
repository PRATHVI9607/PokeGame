// Battle room: wires the engine to sockets, runs the bot, owns turn timers.
// Supports regular 2-player battles and 4-player co-op doubles.
const { Battle } = require('../engine/battle');
const { generateRandomTeam } = require('../engine/random-teams');
const bot = require('./bot');

const TURN_TIMER_MS = 120 * 1000;

class BattleRoom {
  /**
   * Regular: players has 2 entries — { kind:'human'|'bot', socketId?, name, apiKey? }
   * Co-op:   players has 4 entries — [side0slot0, side0slot1, side1slot0, side1slot1]
   *          each { kind:'human', socketId, name, coopSlot: 0|1 }
   *          opts.coopMode = true
   */
  constructor(io, id, players, opts = {}) {
    this.io = io;
    this.id = id;
    this.players = players;
    this.opts = opts;
    this.battle = null;
    this.timer = null;
    this.timerDeadline = 0;
    this.rematchReady = new Array(Math.min(players.length, 2)).fill(false);
    this.over = false;
    this.botBusy = false;
    this.onEnd = opts.onEnd || (() => {});
    this.coopMode = !!opts.coopMode;
    // [sideIdx][slotIdx] buffered single-slot actions awaiting co-op partner
    this.coopPending = [[null, null], [null, null]];
  }

  channel() { return `room:${this.id}`; }

  // Side index (0 or 1) for a given player array index
  sideOf(playerIdx) {
    return this.coopMode ? Math.floor(playerIdx / 2) : playerIdx;
  }
  // Slot within the side (0 or 1) for a given player array index
  slotOf(playerIdx) {
    if (!this.coopMode) return 0;
    return this.players[playerIdx].coopSlot ?? (playerIdx % 2);
  }
  // Name label for winning side
  sideWinnerName(sideIdx) {
    if (this.coopMode) {
      return this.players
        .filter((_, i) => this.sideOf(i) === sideIdx)
        .map(p => p.name).join(' & ');
    }
    return this.players[sideIdx].name;
  }

  async start() {
    const side0Name = this.sideWinnerName(0);
    const side1Name = this.sideWinnerName(1);

    const teams = [];
    for (let i = 0; i < 2; i++) {
      teams[i] = this.opts.teams && this.opts.teams[i]
        ? this.opts.teams[i]
        : await generateRandomTeam();
    }
    this.battle = new Battle(
      { name: side0Name, team: teams[0] },
      { name: side1Name, team: teams[1] },
      { gameType: this.coopMode ? 'doubles' : (this.opts.gameType === 'doubles' ? 'doubles' : 'singles') },
    );
    this.over = false;
    this.rematchReady = new Array(Math.min(this.players.length, 2)).fill(false);
    this.coopPending = [[null, null], [null, null]];
    for (const p of this.players) p.lastRqidSent = -1;

    for (const [i, p] of this.players.entries()) {
      if (p.kind !== 'human') continue;
      const sock = this.io.sockets.sockets.get(p.socketId);
      if (sock) {
        sock.join(this.channel());
        sock.emit('battle:start', {
          roomId: this.id,
          yourSide: this.sideOf(i),
          coopSlot: this.coopMode ? this.slotOf(i) : undefined,
          gameType: this.battle.gameType,
          players: [
            { name: side0Name, bot: !this.coopMode && this.players[0].kind === 'bot' },
            { name: side1Name, bot: !this.coopMode && (this.players[1] || {}).kind === 'bot' },
          ],
        });
      }
    }
    this.battle.start();
    this.flush();
    if (!this.coopMode && this.players.some(p => p.kind === 'bot')) {
      const apiKey = this.players.find(p => p.kind === 'bot').apiKey || process.env.GEMINI_API_KEY;
      bot.botChat('start', apiKey).then(msg => this.chat(this.botName(), msg));
    }
  }

  botName() { return this.players.find(p => p.kind === 'bot')?.name || 'Bot'; }

  // Does side sideIdx still need a choice from the engine perspective?
  needsChoiceForSide(sideIdx) {
    const b = this.battle;
    if (!b || b.ended) return false;
    const side = b.sides[sideIdx];
    if (b.phase === 'replace') return side.needsSwitch.some(Boolean) && !side.choices;
    return !side.choices && side.aliveActives().length > 0;
  }

  // Legacy API used by runBot / onTimeout (side index = player index in regular battles)
  needsChoice(i) {
    return this.needsChoiceForSide(this.coopMode ? this.sideOf(i) : i);
  }

  // Does this specific co-op player need to submit their slot action?
  needsCoopChoice(playerIdx) {
    const sideIdx = this.sideOf(playerIdx);
    const slotIdx = this.slotOf(playerIdx);
    const b = this.battle;
    if (!b || b.ended) return false;
    if (!this.needsChoiceForSide(sideIdx)) return false;
    if (this.coopPending[sideIdx][slotIdx] !== null) return false; // already buffered
    const side = b.sides[sideIdx];
    if (b.phase === 'replace') return !!side.needsSwitch[slotIdx];
    const poke = side.actives[slotIdx];
    return !!(poke && !poke.fainted);
  }

  flush() {
    const lines = this.battle.takeOutbox();
    if (lines.length) this.io.to(this.channel()).emit('battle:log', { roomId: this.id, lines });
    if (this.battle.ended) { this.endBattle(lines); return; }
    this.sendRequests();
    this.armTimer();
    this.runBot(lines);
  }

  sendRequests() {
    for (const [i, p] of this.players.entries()) {
      if (p.kind !== 'human') continue;
      const sideIdx = this.sideOf(i);
      const sock = this.io.sockets.sockets.get(p.socketId);
      if (!sock) continue;
      const req = this.battle.makeRequest(sideIdx);
      if (p.lastRqidSent === req.rqid) continue;
      p.lastRqidSent = req.rqid;
      req.deadline = this.timerDeadline;
      const needsAction = this.coopMode
        ? this.needsCoopChoice(i)
        : this.needsChoiceForSide(sideIdx);
      sock.emit('battle:request', {
        roomId: this.id, request: req, needsAction,
        coopSlot: this.coopMode ? this.slotOf(i) : undefined,
      });
    }
  }

  async runBot(recentLines = []) {
    if (this.coopMode) return;
    const botIdx = this.players.findIndex(p => p.kind === 'bot');
    if (botIdx < 0 || this.botBusy) return;
    const apiKey = this.players[botIdx].apiKey || process.env.GEMINI_API_KEY;

    const humanIdx = 1 - botIdx;
    for (const line of recentLines) {
      if (line.startsWith(`|faint|p${humanIdx + 1}a`)) {
        bot.botChat('ko', apiKey).then(m => this.chat(this.botName(), m));
      } else if (line.startsWith(`|faint|p${botIdx + 1}a`)) {
        if (Math.random() < 0.5) bot.botChat('lost_mon', apiKey).then(m => this.chat(this.botName(), m));
      }
    }

    if (!this.needsChoiceForSide(botIdx)) return;
    this.botBusy = true;
    try {
      await new Promise(r => setTimeout(r, 600 + Math.random() * 900));
      if (this.over || !this.needsChoiceForSide(botIdx)) return;
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

    if (this.coopMode) return this.handleCoopChoice(i, choice);

    if (!this.needsChoiceForSide(i)) return;
    const res = this.battle.choose(i, choice);
    if (res.error) {
      const sock = this.io.sockets.sockets.get(socketId);
      if (sock) sock.emit('battle:error', { roomId: this.id, error: res.error });
      return;
    }
    this.flush();
  }

  handleCoopChoice(playerIdx, choice) {
    if (!this.needsCoopChoice(playerIdx)) return;
    const sideIdx = this.sideOf(playerIdx);
    const slotIdx = this.slotOf(playerIdx);

    // Extract this player's single-slot action from the choice
    let slotAction = null;
    if (choice && choice.actions) {
      slotAction = choice.actions[slotIdx] || choice.actions.find(Boolean);
    } else if (choice && choice.action) {
      slotAction = choice;
    }
    if (!slotAction) return;

    this.coopPending[sideIdx][slotIdx] = slotAction;

    // Check if all required active slots on this side are now filled
    const side = this.battle.sides[sideIdx];
    const phase = this.battle.phase;
    const allFilled = side.actives.every((p, s) => {
      if (phase === 'replace') return !side.needsSwitch[s] || this.coopPending[sideIdx][s] !== null;
      if (!p || p.fainted) return true;
      return this.coopPending[sideIdx][s] !== null;
    });

    if (!allFilled) return; // wait for co-op partner

    // Merge buffered slot actions into a combined choice and submit
    const actions = side.actives.map((p, s) => {
      if (phase === 'replace') return side.needsSwitch[s] ? this.coopPending[sideIdx][s] : null;
      if (!p || p.fainted) return null;
      return this.coopPending[sideIdx][s];
    });
    this.coopPending[sideIdx] = [null, null];

    const res = this.battle.choose(sideIdx, { actions });
    if (res && res.error) {
      for (const [i, p] of this.players.entries()) {
        if (p.kind === 'human' && this.sideOf(i) === sideIdx) {
          const sock = this.io.sockets.sockets.get(p.socketId);
          if (sock) sock.emit('battle:error', { roomId: this.id, error: res.error });
        }
      }
      return;
    }

    this.armTimer();
    if (!this.battle.sides.some((_, idx) => this.needsChoiceForSide(idx)) || this.battle.ended) {
      this.flush();
    }
  }

  armTimer() {
    clearTimeout(this.timer);
    this.timerDeadline = Date.now() + TURN_TIMER_MS;
    this.timer = setTimeout(() => this.onTimeout(), TURN_TIMER_MS + 500);
  }

  onTimeout() {
    if (!this.battle || this.battle.ended || this.over) return;
    let acted = false;
    if (this.coopMode) {
      for (let sideIdx = 0; sideIdx < 2; sideIdx++) {
        if (!this.needsChoiceForSide(sideIdx)) continue;
        const hChoice = bot.heuristicChoice(this.battle, sideIdx);
        if (hChoice && hChoice.actions) {
          const merged = hChoice.actions.map((a, s) => this.coopPending[sideIdx][s] || a);
          this.coopPending[sideIdx] = [null, null];
          this.battle.choose(sideIdx, { actions: merged });
          acted = true;
        }
      }
    } else {
      for (let i = 0; i < 2; i++) {
        if (this.needsChoiceForSide(i)) {
          const choice = bot.heuristicChoice(this.battle, i);
          if (choice) { this.battle.choose(i, choice); acted = true; }
        }
      }
    }
    if (acted) {
      this.io.to(this.channel()).emit('battle:chat', {
        from: 'System', msg: 'Turn timer expired: a move was chosen automatically.',
      });
      this.flush();
    }
  }

  chat(from, msg) {
    if (!msg) return;
    this.io.to(this.channel()).emit('battle:chat', {
      roomId: this.id, from, msg: String(msg).slice(0, 300),
    });
  }

  forfeit(socketId) {
    const i = this.players.findIndex(p => p.kind === 'human' && p.socketId === socketId);
    if (i < 0 || !this.battle || this.battle.ended) return;
    const forfeitSide = this.sideOf(i);
    const winnerName = this.sideWinnerName(1 - forfeitSide);
    this.battle.ended = true;
    this.battle.winner = winnerName;
    this.battle.log(`|-message|${this.players[i].name} forfeited.`);
    this.battle.log(`|win|${winnerName}`);
    this.flush();
  }

  endBattle(lines) {
    if (this.over) return;
    this.over = true;
    clearTimeout(this.timer);
    if (!this.coopMode) {
      const botIdx = this.players.findIndex(p => p.kind === 'bot');
      if (botIdx >= 0) {
        const apiKey = this.players[botIdx].apiKey || process.env.GEMINI_API_KEY;
        const botWon = this.battle.winner === this.players[botIdx].name;
        bot.botChat(botWon ? 'win' : 'loss', apiKey).then(m => this.chat(this.botName(), m));
      }
    }
    this.io.to(this.channel()).emit('battle:end', { roomId: this.id, winner: this.battle.winner });
    this.onEnd(this);
  }

  requestRematch(socketId) {
    if (this.coopMode) return; // no rematch in co-op for now
    const i = this.players.findIndex(p => p.kind === 'human' && p.socketId === socketId);
    if (i < 0 || !this.over) return;
    this.rematchReady[i] = true;
    const botIdx = this.players.findIndex(p => p.kind === 'bot');
    if (botIdx >= 0) this.rematchReady[botIdx] = true;
    this.io.to(this.channel()).emit('battle:rematch-status', { ready: this.rematchReady });
    if (this.rematchReady.every(Boolean)) {
      if (this.opts.mode === 'random') this.opts.teams = null;
      this.start();
    }
  }

  handleDisconnect(socketId) {
    const i = this.players.findIndex(p => p.kind === 'human' && p.socketId === socketId);
    if (i < 0) return;
    if (!this.over && this.battle && !this.battle.ended) {
      const winnerName = this.sideWinnerName(1 - this.sideOf(i));
      this.battle.ended = true;
      this.battle.winner = winnerName;
      this.battle.log(`|-message|${this.players[i].name} disconnected.`);
      this.battle.log(`|win|${winnerName}`);
      this.flush();
    } else {
      this.onEnd(this);
    }
  }

  destroy() { clearTimeout(this.timer); }
}

module.exports = { BattleRoom };
