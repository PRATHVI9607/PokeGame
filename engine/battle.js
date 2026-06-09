// The battle engine core: our own turn loop, damage formula, status, weather,
// terrain, hazards, screens and gimmick integration. Emits a Showdown-like
// line protocol that the client renders.
const { toID, typeEffect, getMove } = require('./data');
const { Pokemon } = require('./pokemon');
const fx = require('./effects');
const gx = require('./gimmicks');

// seedable PRNG (mulberry32)
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WEATHER_NAMES = { sun: 'SunnyDay', rain: 'RainDance', sand: 'Sandstorm', snow: 'Snowscape' };
const TERRAIN_NAMES = { electric: 'Electric Terrain', grassy: 'Grassy Terrain', psychic: 'Psychic Terrain', misty: 'Misty Terrain' };

class Side {
  constructor(n, name, sets) {
    this.n = n;
    this.name = name;
    this.team = sets.map((set, i) => new Pokemon(set, this, i));
    this.active = null;
    this.hazards = { stealthrock: false, spikes: 0, toxicspikes: 0, stickyweb: false };
    this.sideConditions = {};   // reflect, lightscreen, auroraveil, tailwind -> turns left
    this.usedGimmicks = { tera: false, mega: false, zmove: false, dynamax: false };
    this.choice = null;
    this.needsSwitch = false;   // forced replacement pending
    this.rqid = 0;
  }
  alive() { return this.team.filter(p => !p.fainted); }
  defeated() { return this.team.every(p => p.fainted); }
}

class Battle {
  constructor(p1, p2, opts = {}) {
    this.rand = mulberry32(opts.seed ?? Math.floor(Math.random() * 2 ** 31));
    this.sides = [new Side(0, p1.name, p1.team), new Side(1, p2.name, p2.team)];
    this.turn = 0;
    this.weather = ''; this.weatherTurns = 0;
    this.terrain = ''; this.terrainTurns = 0;
    this.trickRoom = 0;
    this.logLines = [];
    this.outbox = [];
    this.ended = false;
    this.winner = null;
    this.movedSet = new Set();
    this.lastEffectiveness = 1;
    this.lastWasCrit = false;
    this.lastDamageDealt = 0;
    this.phase = 'choice'; // 'choice' | 'replace' | 'ended'
  }

  // ---------- utils ----------
  random() { return this.rand(); }
  chance(pct) { return this.rand() * 100 < pct; }
  randint(lo, hi) { return lo + Math.floor(this.rand() * (hi - lo + 1)); }
  sample(arr) { return arr[Math.floor(this.rand() * arr.length)]; }

  log(line) { this.logLines.push(line); this.outbox.push(line); }
  takeOutbox() { const o = this.outbox; this.outbox = []; return o; }

  ref(poke) { return `p${poke.side.n + 1}a: ${poke.name}`; }
  hpStr(poke) {
    if (poke.fainted || poke.hp <= 0) return '0 fnt';
    return `${poke.hpPercent()}/100${poke.status ? ' ' + poke.status : ''}`;
  }
  foeSide(side) { return this.sides[1 - side.n]; }
  foeActive(poke) { return this.sides[1 - poke.side.n].active; }
  ignoresAbility(attacker) {
    return ['moldbreaker', 'teravolt', 'turboblaze'].includes(attacker.ability);
  }
  movedThisTurn(poke) { return this.movedSet.has(poke); }

  // ---------- lifecycle ----------
  start() {
    this.log(`|player|p1|${this.sides[0].name}`);
    this.log(`|player|p2|${this.sides[1].name}`);
    this.log(`|teamsize|p1|${this.sides[0].team.length}`);
    this.log(`|teamsize|p2|${this.sides[1].team.length}`);
    this.log(`|gametype|singles`);
    this.log(`|start`);
    for (const side of this.sides) this.switchIn(side, 0, true);
    for (const side of this.sides) if (side.active) fx.onSwitchInEffects(this, side.active);
    this.nextTurn();
  }

  nextTurn() {
    if (this.checkWin()) return;
    this.turn++;
    this.movedSet.clear();
    this.phase = 'choice';
    for (const side of this.sides) { side.choice = null; side.rqid++; }
    this.log(`|turn|${this.turn}`);
  }

  checkWin() {
    for (const side of this.sides) {
      if (side.defeated()) {
        const winner = this.foeSide(side);
        this.ended = true;
        this.phase = 'ended';
        this.winner = winner.name;
        this.log(`|win|${winner.name}`);
        return true;
      }
    }
    return false;
  }

  // ---------- requests ----------
  makeRequest(sideIdx) {
    const side = this.sides[sideIdx];
    const poke = side.active;
    const req = { rqid: side.rqid, side: this.sideData(side) };
    if (this.ended) return req;
    if (this.phase === 'replace') {
      req.forceSwitch = side.needsSwitch;
      req.wait = !side.needsSwitch;
      return req;
    }
    if (!poke || poke.fainted) { req.wait = true; return req; }

    const choiceLocked = (['choiceband', 'choicespecs', 'choicescarf'].includes(poke.item) ||
      poke.ability === 'gorillatactics') && poke.lastMove && !poke.dynamaxed;
    const moves = poke.moves.map(slot => {
      const m = getMove(slot.id);
      return {
        id: slot.id, name: slot.name, pp: slot.pp, maxpp: slot.maxpp,
        type: m.type, category: m.category, basePower: m.basePower,
        accuracy: m.accuracy === true ? '—' : m.accuracy,
        disabled: slot.pp <= 0 || (choiceLocked && slot.id !== poke.lastMove),
      };
    });
    if (moves.every(m => m.disabled)) {
      // struggle
      req.active = { moves: [{ id: 'struggle', name: 'Struggle', pp: 1, maxpp: 1, type: 'Normal', category: 'Physical', basePower: 50, accuracy: '—', disabled: false }] };
    } else {
      req.active = { moves };
    }
    req.active.canTera = gx.canTera(poke, side) ? poke.teraType : false;
    req.active.canMega = gx.canMega(poke, side) ? gx.megaFormeFor(poke) : false;
    req.active.canDynamax = gx.canDynamax(poke, side);
    req.active.dynamaxed = poke.dynamaxed;
    if (gx.canZMove(poke, side)) {
      req.active.canZMove = poke.moves.map(slot => {
        const z = gx.zMoveFor(poke, slot);
        return z ? { name: z.name, basePower: z.basePower, type: z.type } : null;
      });
    } else req.active.canZMove = false;
    if (req.active.canDynamax || poke.dynamaxed) {
      req.active.maxMoves = poke.moves.map(slot => {
        const m = getMove(slot.id);
        const mm = gx.maxMoveFor(m);
        return { name: mm.name, basePower: mm.basePower, type: mm.type, category: mm.category };
      });
    }
    if (poke.volatiles.mustrecharge) req.active.mustRecharge = true;
    return req;
  }

  sideData(side) {
    return {
      name: side.name,
      n: side.n,
      pokemon: side.team.map(p => ({
        ident: `p${side.n + 1}: ${p.name}`,
        species: p.species.name,
        details: p.details(),
        condition: p.fainted ? '0 fnt' : `${p.hp}/${p.maxhp}${p.status ? ' ' + p.status : ''}`,
        active: p === side.active,
        stats: p.stats,
        boosts: p.boosts,
        moves: p.moves.map(m => ({ id: m.id, name: m.name, pp: m.pp, maxpp: m.maxpp })),
        item: p.item, ability: p.ability, teraType: p.teraType,
        terastallized: p.terastallized, mega: p.mega, dynamaxed: p.dynamaxed,
      })),
      usedGimmicks: side.usedGimmicks,
    };
  }

  // ---------- choices ----------
  /** choice: {action:'move', move:0-3, gimmick?:'tera'|'mega'|'zmove'|'dynamax'} | {action:'switch', target:0-5} */
  choose(sideIdx, choice) {
    if (this.ended) return { error: 'Battle is over' };
    const side = this.sides[sideIdx];
    const err = this.validateChoice(side, choice);
    if (err) return { error: err };

    if (this.phase === 'replace') {
      side.choice = choice;
      const waiting = this.sides.some(s => s.needsSwitch && !s.choice);
      if (!waiting) this.commitReplacements();
      return { ok: true };
    }
    side.choice = choice;
    if (this.sides.every(s => s.choice)) this.commitTurn();
    return { ok: true };
  }

  validateChoice(side, choice) {
    if (!choice || typeof choice !== 'object') return 'Bad choice';
    if (this.phase === 'replace') {
      if (!side.needsSwitch) return 'Not your turn to replace';
      if (choice.action !== 'switch') return 'Must switch';
    }
    if (choice.action === 'switch') {
      const target = side.team[choice.target];
      if (!target) return 'No such pokemon';
      if (target.fainted) return `${target.name} has fainted`;
      if (target === side.active) return `${target.name} is already active`;
      return null;
    }
    if (choice.action === 'move') {
      const poke = side.active;
      if (!poke) return 'No active pokemon';
      if (choice.move === 'struggle') return null;
      const slot = poke.moves[choice.move];
      if (!slot) return 'No such move';
      if (slot.pp <= 0 && !poke.moves.every(m => m.pp <= 0)) return 'No PP left';
      const g = choice.gimmick;
      if (g === 'tera' && !gx.canTera(poke, side)) return 'Cannot Terastallize';
      if (g === 'mega' && !gx.canMega(poke, side)) return 'Cannot Mega Evolve';
      if (g === 'dynamax' && !gx.canDynamax(poke, side)) return 'Cannot Dynamax';
      if (g === 'zmove' && !(gx.canZMove(poke, side) && gx.zMoveFor(poke, slot))) return 'Cannot use Z-Move';
      return null;
    }
    return 'Unknown action';
  }

  // ---------- turn execution ----------
  commitTurn() {
    const actions = [];
    for (const side of this.sides) {
      const c = side.choice;
      if (c.action === 'switch') {
        actions.push({ side, type: 'switch', target: c.target, speed: this.effectiveSpeed(side.active) });
      } else {
        const poke = side.active;
        let pri = 0;
        let moveId = c.move === 'struggle' || poke.moves.every(m => m.pp <= 0) ? 'struggle' : poke.moves[c.move]?.id;
        const move = getMove(moveId) || getMove('struggle');
        pri = fx.movePriorityMod(move, poke, this);
        if (this.terrain === 'psychic') { /* checked at execution vs grounded target */ }
        actions.push({ side, type: 'move', moveIndex: c.move, moveId: move.id, gimmick: c.gimmick, priority: pri, speed: this.effectiveSpeed(poke) });
      }
    }
    actions.sort((a, b) => {
      const ta = a.type === 'switch' ? 1 : 0, tb = b.type === 'switch' ? 1 : 0;
      if (ta !== tb) return tb - ta; // switches first
      if (a.type === 'move' && b.type === 'move' && a.priority !== b.priority) return b.priority - a.priority;
      let sa = a.speed, sb = b.speed;
      if (this.trickRoom > 0) { sa = -sa; sb = -sb; }
      if (sa !== sb) return sb - sa;
      return this.random() < 0.5 ? -1 : 1;
    });

    for (const action of actions) {
      if (this.ended) break;
      if (action.type === 'switch') {
        this.voluntarySwitch(action.side, action.target);
      } else {
        const poke = action.side.active;
        if (!poke || poke.fainted) continue;
        this.runMoveAction(action);
        if (this.checkWin()) return;
      }
    }
    if (this.ended) return;
    this.endOfTurn();
    if (this.ended) return;
    this.beginReplacePhaseOrNextTurn();
  }

  beginReplacePhaseOrNextTurn() {
    let anyReplace = false;
    for (const side of this.sides) {
      side.choice = null;
      side.needsSwitch = !!(side.active && side.active.fainted && side.alive().length > 0) || side.pendingSelfSwitch === true;
      side.pendingSelfSwitch = false;
      if (side.needsSwitch) anyReplace = true;
      side.rqid++;
    }
    if (anyReplace) { this.phase = 'replace'; }
    else this.nextTurn();
  }

  commitReplacements() {
    for (const side of this.sides) {
      if (side.needsSwitch && side.choice) {
        this.switchIn(side, side.choice.target);
        side.needsSwitch = false;
        side.choice = null;
      }
    }
    for (const side of this.sides) {
      if (side.active && !side.active.fainted && side.active.justSwitchedIn) {
        side.active.justSwitchedIn = false;
        fx.onSwitchInEffects(this, side.active);
      }
    }
    if (this.checkWin()) return;
    // hazard / switch-in effects may have fainted the new pokemon
    let again = false;
    for (const side of this.sides) {
      side.needsSwitch = !!(side.active && side.active.fainted && side.alive().length > 0);
      if (side.needsSwitch) { again = true; side.rqid++; }
    }
    if (again) { this.phase = 'replace'; return; }
    this.nextTurn();
  }

  voluntarySwitch(side, targetIdx) {
    const out = side.active;
    if (out && !out.fainted) {
      this.log(`|-message|${out.name}, come back!`);
    }
    this.switchIn(side, targetIdx);
    const poke = side.active;
    if (poke && !poke.fainted) { poke.justSwitchedIn = false; fx.onSwitchInEffects(this, poke); }
  }

  switchIn(side, targetIdx, initial = false) {
    const out = side.active;
    if (out) { out.active = false; out.clearVolatilesOnSwitch(); }
    const poke = side.team[targetIdx];
    poke.active = true;
    poke.justSwitchedIn = true;
    side.active = poke;
    this.log(`|switch|${this.ref(poke)}|${poke.details()}|${this.hpStr(poke)}`);
    if (side.batonBoosts) {
      poke.applyBoosts(side.batonBoosts);
      side.batonBoosts = null;
      this.log(`|-activate|${this.ref(poke)}|Baton Pass`);
    }
    if (!initial) this.applyHazards(poke);
  }

  applyHazards(poke) {
    const side = poke.side;
    const boots = poke.item === 'heavydutyboots';
    if (boots || poke.fainted) return;
    if (side.hazards.stealthrock && poke.ability !== 'magicguard') {
      const eff = typeEffect('Rock', poke.types);
      const dmg = Math.floor(poke.maxhp * 0.125 * eff);
      if (dmg > 0) {
        poke.damage(dmg);
        this.log(`|-damage|${this.ref(poke)}|${this.hpStr(poke)}|[from] Stealth Rock`);
        this.checkFaint(poke);
      }
    }
    if (poke.fainted) return;
    if (side.hazards.spikes > 0 && poke.isGrounded(this) && poke.ability !== 'magicguard') {
      const frac = [0, 1 / 8, 1 / 6, 1 / 4][side.hazards.spikes];
      poke.damage(poke.maxhp * frac);
      this.log(`|-damage|${this.ref(poke)}|${this.hpStr(poke)}|[from] Spikes`);
      this.checkFaint(poke);
    }
    if (poke.fainted) return;
    if (side.hazards.toxicspikes > 0 && poke.isGrounded(this)) {
      if (poke.hasType('Poison')) {
        side.hazards.toxicspikes = 0;
        this.log(`|-sideend|p${side.n + 1}|Toxic Spikes`);
      } else {
        this.trySetStatus(poke, side.hazards.toxicspikes >= 2 ? 'tox' : 'psn', null, 'Toxic Spikes');
      }
    }
    if (side.hazards.stickyweb && poke.isGrounded(this)) {
      this.log(`|-activate|${this.ref(poke)}|Sticky Web`);
      this.boost(poke, { spe: -1 }, null);
    }
  }

  // ---------- move action pipeline ----------
  runMoveAction(action) {
    const side = action.side;
    const poke = side.active;
    const foe = this.foeActive(poke);

    // gimmick activation
    if (action.gimmick === 'tera') gx.doTera(this, poke);
    if (action.gimmick === 'mega') gx.doMega(this, poke);
    if (action.gimmick === 'dynamax') gx.doDynamax(this, poke);

    // recharge turn
    if (poke.volatiles.mustrecharge) {
      delete poke.volatiles.mustrecharge;
      this.log(`|cant|${this.ref(poke)}|recharge`);
      this.movedSet.add(poke);
      return;
    }

    // status interruptions
    if (!this.canActThisTurn(poke)) { this.movedSet.add(poke); return; }

    let moveId = action.moveId;
    let slot = poke.moves[action.moveIndex];
    if (moveId === 'struggle') slot = null;
    let move = getMove(moveId);

    // Z-move / Max move conversion
    let zInfo = null, maxInfo = null;
    if (action.gimmick === 'zmove' && slot) {
      zInfo = gx.zMoveFor(poke, slot);
      side.usedGimmicks.zmove = true;
      this.log(`|-zpower|${this.ref(poke)}`);
    }
    if (poke.dynamaxed && move.category !== 'Status') maxInfo = gx.maxMoveFor(move);
    if (poke.dynamaxed && move.category === 'Status') maxInfo = gx.maxMoveFor(move);

    // PP
    if (slot) slot.pp = Math.max(0, slot.pp - 1);
    poke.lastMove = moveId;
    this.movedSet.add(poke);

    const displayName = zInfo ? zInfo.name : maxInfo ? maxInfo.name : move.name;
    const animType = zInfo ? zInfo.type : maxInfo ? maxInfo.type : this.effectiveMoveType(poke, move);
    const animCat = zInfo ? zInfo.category : maxInfo ? maxInfo.category : move.category;
    this.log(`|move|${this.ref(poke)}|${displayName}|${foe ? this.ref(foe) : ''}|${animType}|${animCat}`);

    // Protean / Libero
    if ((poke.ability === 'protean' || poke.ability === 'libero') && !poke.terastallized &&
        !poke.types.every(t => t === move.type) && !poke.volatiles.proteanUsed) {
      poke.types = [move.type];
      poke.volatiles.proteanUsed = true;
      this.log(`|-start|${this.ref(poke)}|typechange|${move.type}|[from] ability: ${poke.ability === 'protean' ? 'Protean' : 'Libero'}`);
    }

    if (maxInfo && maxInfo.isMaxGuard) { this.useProtect(poke, 'Max Guard'); return; }

    if (move.category === 'Status' && !zInfo) { this.runStatusMove(poke, foe, move); return; }

    // damaging move
    this.runDamagingMove(poke, foe, move, slot, { zInfo, maxInfo });
  }

  canActThisTurn(poke) {
    // flinch
    if (poke.volatiles.flinch) {
      delete poke.volatiles.flinch;
      this.log(`|cant|${this.ref(poke)}|flinch`);
      if (poke.ability === 'steadfast') this.boost(poke, { spe: 1 }, poke);
      return false;
    }
    // sleep
    if (poke.status === 'slp') {
      if (poke.statusCounter <= 0) {
        this.cureStatus(poke, 'woke up');
      } else {
        poke.statusCounter--;
        this.log(`|cant|${this.ref(poke)}|slp`);
        return false;
      }
    }
    // freeze
    if (poke.status === 'frz') {
      if (this.chance(20)) {
        this.cureStatus(poke, 'thawed');
      } else {
        this.log(`|cant|${this.ref(poke)}|frz`);
        return false;
      }
    }
    // confusion
    if (poke.volatiles.confusion) {
      poke.volatiles.confusion--;
      if (poke.volatiles.confusion <= 0) {
        delete poke.volatiles.confusion;
        this.log(`|-end|${this.ref(poke)}|confusion`);
      } else {
        this.log(`|-activate|${this.ref(poke)}|confusion`);
        if (this.chance(33)) {
          const atk = poke.getStat('atk'), def = poke.getStat('def');
          const L = poke.level;
          const base = Math.floor(Math.floor(Math.floor(2 * L / 5 + 2) * 40 * atk / def) / 50) + 2;
          const dmg = Math.floor(base * (0.85 + this.random() * 0.15));
          poke.damage(dmg);
          this.log(`|-damage|${this.ref(poke)}|${this.hpStr(poke)}|[from] confusion`);
          this.checkFaint(poke);
          return false;
        }
      }
    }
    // paralysis
    if (poke.status === 'par' && this.chance(25)) {
      this.log(`|cant|${this.ref(poke)}|par`);
      return false;
    }
    return true;
  }

  // ---------- status moves ----------
  runStatusMove(poke, foe, move) {
    const targetSelf = ['self', 'allySide', 'allyTeam', 'all'].includes(move.target);
    const special = this.statusMoveSpecial(poke, foe, move);
    if (special) return;

    // accuracy for targeted status moves
    if (!targetSelf && foe && move.accuracy !== true) {
      if (!this.accuracyCheck(poke, foe, move)) return;
    }
    if (!targetSelf && foe && foe.volatiles.protect && move.flags.protect) {
      this.log(`|-activate|${this.ref(foe)}|move: Protect`);
      return;
    }
    if (!targetSelf && foe && move.flags.reflectable && foe.ability === 'magicbounce') {
      this.log(`|-activate|${this.ref(foe)}|ability: Magic Bounce`);
      [poke, foe] = [foe, poke]; // bounce back
    }

    let did = false;
    if (move.boosts) {
      const target = targetSelf || move.target === 'self' ? poke : foe;
      if (target && !target.fainted) { this.boost(target, move.boosts, poke); did = true; }
    }
    if (move.self && move.self.boosts) { this.boost(poke, move.self.boosts, poke); did = true; }
    if (move.status && foe && !foe.fainted) {
      const blocked = fx.statusBlocked(foe, move.status, this, poke);
      // Toxic from a Poison-type never misses (already passed accuracy); apply
      if (blocked) this.log(`|-fail|${this.ref(foe)}`);
      else this.trySetStatus(foe, move.status, poke, `move: ${move.name}`);
      did = true;
    }
    if (move.volatileStatus && foe && !foe.fainted) {
      did = true;
      if (move.volatileStatus === 'confusion') {
        if (foe.volatiles.confusion || foe.ability === 'owntempo') this.log(`|-fail|${this.ref(foe)}`);
        else {
          foe.volatiles.confusion = this.randint(2, 5);
          this.log(`|-start|${this.ref(foe)}|confusion`);
          fx.checkStatusBerry(this, foe);
        }
      } else if (move.volatileStatus === 'leechseed') {
        if (foe.hasType('Grass') || foe.volatiles.leechseed) this.log(`|-immune|${this.ref(foe)}`);
        else { foe.volatiles.leechseed = true; this.log(`|-start|${this.ref(foe)}|move: Leech Seed`); }
      } else if (move.volatileStatus === 'taunt' || move.volatileStatus === 'yawn' || move.volatileStatus === 'encore') {
        this.log(`|-fail|${this.ref(poke)}`); // not implemented
      }
    }
    if (move.sideCondition) { this.applySideCondition(poke, foe, move); did = true; }
    if (move.weather) { this.setWeather(toID(move.weather) === 'hail' ? 'snow' : toID(move.weather).replace('sunnyday', 'sun').replace('raindance', 'rain').replace('sandstorm', 'sand').replace('snowscape', 'snow'), poke); did = true; }
    if (move.terrain) { this.setTerrain(move.terrain, poke); did = true; }
    if (move.pseudoWeather === 'trickroom') {
      this.trickRoom = this.trickRoom > 0 ? 0 : 5;
      this.log(this.trickRoom ? `|-fieldstart|move: Trick Room` : `|-fieldend|move: Trick Room`);
      did = true;
    }
    if (move.heal) {
      const healed = poke.heal(poke.maxhp * move.heal[0] / move.heal[1]);
      if (healed > 0) { this.log(`|-heal|${this.ref(poke)}|${this.hpStr(poke)}`); did = true; }
      else this.log(`|-fail|${this.ref(poke)}|heal`);
    }
    if (!did) this.log(`|-fail|${this.ref(poke)}`);
  }

  statusMoveSpecial(poke, foe, move) {
    switch (move.id) {
      case 'protect': case 'detect': case 'banefulbunker': case 'spikyshield': case 'silktrap':
        this.useProtect(poke, move.name); return true;
      case 'substitute': {
        if (poke.volatiles.substitute) { this.log(`|-fail|${this.ref(poke)}`); return true; }
        if (poke.hp <= poke.maxhp / 4) { this.log(`|-fail|${this.ref(poke)}|move: Substitute|[weak]`); return true; }
        poke.damage(poke.maxhp / 4);
        poke.volatiles.substitute = Math.floor(poke.maxhp / 4);
        this.log(`|-damage|${this.ref(poke)}|${this.hpStr(poke)}`);
        this.log(`|-start|${this.ref(poke)}|Substitute`);
        return true;
      }
      case 'rest': {
        if (poke.hp === poke.maxhp || fx.statusBlocked(poke, 'slp', this, poke) && !poke.status) {
          // rest overrides existing status; only blocked if insomnia-like or full hp
          if (poke.hp === poke.maxhp || ['insomnia', 'vitalspirit', 'comatose', 'purifyingsalt'].includes(poke.ability)) {
            this.log(`|-fail|${this.ref(poke)}`); return true;
          }
        }
        poke.status = 'slp'; poke.statusCounter = 2;
        poke.hp = poke.maxhp;
        this.log(`|-status|${this.ref(poke)}|slp|[from] move: Rest`);
        this.log(`|-heal|${this.ref(poke)}|${this.hpStr(poke)}|[silent]`);
        return true;
      }
      case 'roost': {
        const healed = poke.heal(poke.maxhp / 2);
        if (healed > 0) this.log(`|-heal|${this.ref(poke)}|${this.hpStr(poke)}`);
        else this.log(`|-fail|${this.ref(poke)}`);
        return true;
      }
      case 'moonlight': case 'synthesis': case 'morningsun': {
        let frac = 1 / 2;
        if (this.weather === 'sun') frac = 2 / 3;
        else if (this.weather) frac = 1 / 4;
        const healed = poke.heal(poke.maxhp * frac);
        if (healed > 0) this.log(`|-heal|${this.ref(poke)}|${this.hpStr(poke)}`);
        else this.log(`|-fail|${this.ref(poke)}`);
        return true;
      }
      case 'shoreup': {
        const healed = poke.heal(poke.maxhp * (this.weather === 'sand' ? 2 / 3 : 1 / 2));
        if (healed > 0) this.log(`|-heal|${this.ref(poke)}|${this.hpStr(poke)}`);
        else this.log(`|-fail|${this.ref(poke)}`);
        return true;
      }
      case 'strengthsap': {
        if (!foe || foe.fainted) { this.log(`|-fail|${this.ref(poke)}`); return true; }
        const atk = foe.getStat('atk');
        this.boost(foe, { atk: -1 }, poke);
        const healed = poke.heal(atk);
        if (healed > 0) this.log(`|-heal|${this.ref(poke)}|${this.hpStr(poke)}`);
        return true;
      }
      case 'defog': {
        if (foe) this.boost(foe, { evasion: -1 }, poke);
        for (const side of this.sides) {
          if (side.hazards.stealthrock || side.hazards.spikes || side.hazards.toxicspikes || side.hazards.stickyweb) {
            side.hazards = { stealthrock: false, spikes: 0, toxicspikes: 0, stickyweb: false };
            this.log(`|-sideend|p${side.n + 1}|hazards|[from] move: Defog`);
          }
        }
        const fs = this.foeSide(poke.side);
        for (const sc of ['reflect', 'lightscreen', 'auroraveil']) {
          if (fs.sideConditions[sc]) { delete fs.sideConditions[sc]; this.log(`|-sideend|p${fs.n + 1}|${sc}`); }
        }
        return true;
      }
      case 'rapidspin': return false; // damaging in modern gens; handled as damage move (data has it as Physical actually)
      case 'haze': {
        for (const side of this.sides) {
          if (side.active) side.active.boosts = { atk: 0, def: 0, spa: 0, spd: 0, spe: 0, accuracy: 0, evasion: 0 };
        }
        this.log(`|-clearallboost`);
        return true;
      }
      case 'bellydrum': {
        if (poke.hp <= poke.maxhp / 2 || poke.boosts.atk >= 6) { this.log(`|-fail|${this.ref(poke)}`); return true; }
        poke.damage(poke.maxhp / 2);
        this.log(`|-damage|${this.ref(poke)}|${this.hpStr(poke)}`);
        poke.boosts.atk = 6;
        this.log(`|-setboost|${this.ref(poke)}|atk|6|[from] move: Belly Drum`);
        return true;
      }
      case 'healbell': case 'aromatherapy': {
        for (const p of poke.side.team) {
          if (p.status && !p.fainted) { p.status = ''; p.statusCounter = 0; }
        }
        this.log(`|-activate|${this.ref(poke)}|move: ${move.name}`);
        return true;
      }
      case 'painsplit': {
        if (!foe || foe.fainted) { this.log(`|-fail|${this.ref(poke)}`); return true; }
        const avg = Math.floor((poke.hp + foe.hp) / 2);
        poke.hp = Math.min(poke.maxhp, avg);
        foe.hp = Math.min(foe.maxhp, avg);
        if (foe.hp <= 0) { foe.hp = 1; }
        this.log(`|-sethp|${this.ref(poke)}|${this.hpStr(poke)}|[from] move: Pain Split`);
        this.log(`|-sethp|${this.ref(foe)}|${this.hpStr(foe)}|[from] move: Pain Split`);
        return true;
      }
      case 'trick': case 'switcheroo': {
        if (!foe || foe.fainted || foe.ability === 'stickyhold') { this.log(`|-fail|${this.ref(poke)}`); return true; }
        const a = poke.item, b = foe.item;
        poke.item = b; foe.item = a;
        this.log(`|-activate|${this.ref(poke)}|move: ${move.name}`);
        this.log(`|-item|${this.ref(foe)}|${a || '(none)'}|[from] move: ${move.name}`);
        return true;
      }
      case 'willowisp': case 'thunderwave': case 'toxic': case 'glare': case 'spore':
      case 'sleeppowder': case 'hypnosis': case 'darkvoid': case 'stunspore': case 'poisonpowder':
      case 'sing': case 'grasswhistle': case 'lovelykiss': case 'yawn': {
        if (!foe || foe.fainted) { this.log(`|-fail|${this.ref(poke)}`); return true; }
        // powder immunity
        if (move.flags.powder && (foe.hasType('Grass') || foe.ability === 'overcoat' || foe.item === 'safetygoggles')) {
          this.log(`|-immune|${this.ref(foe)}`); return true;
        }
        // thunder wave respects type immunity
        if (move.id === 'thunderwave' && typeEffect('Electric', foe.types) === 0) {
          this.log(`|-immune|${this.ref(foe)}`); return true;
        }
        const alwaysHits = move.id === 'toxic' && poke.hasType('Poison');
        if (!alwaysHits && move.accuracy !== true && !this.accuracyCheck(poke, foe, move)) return true;
        if (foe.volatiles.protect && move.flags.protect) { this.log(`|-activate|${this.ref(foe)}|move: Protect`); return true; }
        if (move.flags.reflectable && foe.ability === 'magicbounce') {
          this.log(`|-activate|${this.ref(foe)}|ability: Magic Bounce`);
          const status = move.id === 'yawn' ? 'slp' : move.status;
          if (!fx.statusBlocked(poke, status, this, foe)) this.trySetStatus(poke, status, foe, `move: ${move.name}`);
          return true;
        }
        const status = move.id === 'yawn' ? 'slp' : move.status;
        if (fx.statusBlocked(foe, status, this, poke)) this.log(`|-fail|${this.ref(foe)}`);
        else this.trySetStatus(foe, status, poke, `move: ${move.name}`);
        return true;
      }
      case 'batonpass': {
        if (poke.side.alive().length <= 1) { this.log(`|-fail|${this.ref(poke)}`); return true; }
        poke.side.pendingSelfSwitch = true;
        poke.side.batonBoosts = Object.assign({}, poke.boosts);
        this.log(`|-activate|${this.ref(poke)}|move: Baton Pass`);
        return true;
      }
      case 'teleport': case 'partingshot': case 'chillyreception': {
        if (move.id === 'partingshot' && foe && !foe.fainted) this.boost(foe, { atk: -1, spa: -1 }, poke);
        if (move.id === 'chillyreception') this.setWeather('snow', poke);
        if (poke.side.alive().length > 1) poke.side.pendingSelfSwitch = true;
        return true;
      }
      case 'wish': case 'counter': case 'mirrorcoat': case 'metalburst': case 'destinybond':
      case 'encore': case 'disable': case 'taunt': case 'whirlwind': case 'roar':
        this.log(`|-fail|${this.ref(poke)}`); // intentionally unimplemented
        return true;
    }
    return false;
  }

  useProtect(poke, name) {
    const failChance = 1 / Math.pow(3, poke.protectCounter);
    if (poke.protectCounter > 0 && this.random() > failChance) {
      this.log(`|-fail|${this.ref(poke)}`);
      poke.protectCounter = 0;
      return;
    }
    poke.volatiles.protect = true;
    poke.protectCounter++;
    this.log(`|-singleturn|${this.ref(poke)}|move: ${name}`);
  }

  applySideCondition(poke, foe, move) {
    const id = toID(move.sideCondition);
    const selfConds = { reflect: 5, lightscreen: 5, auroraveil: 5, tailwind: 4, safeguard: 5, mist: 5 };
    if (selfConds[id] !== undefined) {
      const side = poke.side;
      if (id === 'auroraveil' && this.weather !== 'snow') { this.log(`|-fail|${this.ref(poke)}`); return; }
      if (side.sideConditions[id]) { this.log(`|-fail|${this.ref(poke)}`); return; }
      let turns = selfConds[id];
      if ((id === 'reflect' || id === 'lightscreen' || id === 'auroraveil') && poke.item === 'lightclay') turns = 8;
      side.sideConditions[id] = turns;
      this.log(`|-sidestart|p${side.n + 1}|move: ${move.name}`);
      return;
    }
    // hazards on the foe side
    const fs = this.foeSide(poke.side);
    if (id === 'stealthrock') {
      if (fs.hazards.stealthrock) { this.log(`|-fail|${this.ref(poke)}`); return; }
      fs.hazards.stealthrock = true;
      this.log(`|-sidestart|p${fs.n + 1}|move: Stealth Rock`);
    } else if (id === 'spikes') {
      if (fs.hazards.spikes >= 3) { this.log(`|-fail|${this.ref(poke)}`); return; }
      fs.hazards.spikes++;
      this.log(`|-sidestart|p${fs.n + 1}|Spikes`);
    } else if (id === 'toxicspikes') {
      if (fs.hazards.toxicspikes >= 2) { this.log(`|-fail|${this.ref(poke)}`); return; }
      fs.hazards.toxicspikes++;
      this.log(`|-sidestart|p${fs.n + 1}|move: Toxic Spikes`);
    } else if (id === 'stickyweb') {
      if (fs.hazards.stickyweb) { this.log(`|-fail|${this.ref(poke)}`); return; }
      fs.hazards.stickyweb = true;
      this.log(`|-sidestart|p${fs.n + 1}|move: Sticky Web`);
    }
  }

  // ---------- damaging moves ----------
  runDamagingMove(poke, foe, move, slot, { zInfo, maxInfo }) {
    if (!foe || foe.fainted) { this.log(`|-fail|${this.ref(poke)}|noTarget`); return; }

    // psychic terrain blocks priority against grounded targets
    const pri = fx.movePriorityMod(move, poke, this);
    if (this.terrain === 'psychic' && pri > 0 && foe.isGrounded(this)) {
      this.log(`|-activate|${this.ref(foe)}|Psychic Terrain`);
      return;
    }
    // dark types are immune to prankster-boosted status; N/A for damaging.

    // Sucker Punch
    if (move.id === 'suckerpunch' || move.id === 'thunderclap') {
      const foeChoice = foe.side.choice;
      const foeMoved = this.movedThisTurn(foe);
      const foeAttacking = foeChoice && foeChoice.action === 'move' &&
        (() => {
          const fm = foe.moves[foeChoice.move];
          const fmove = fm ? getMove(fm.id) : null;
          return fmove && fmove.category !== 'Status';
        })();
      if (foeMoved || !foeAttacking) { this.log(`|-fail|${this.ref(poke)}`); return; }
    }
    // Fake Out / First Impression
    if ((move.id === 'fakeout' || move.id === 'firstimpression') && poke.turnsOut > 0) {
      this.log(`|-fail|${this.ref(poke)}`); return;
    }

    // protect
    if (foe.volatiles.protect && move.flags.protect && !zInfo && !maxInfo) {
      this.log(`|-activate|${this.ref(foe)}|move: Protect`);
      if (move.recoil || move.hasCrashDamage) { /* skip crash */ }
      return;
    }
    if (foe.volatiles.protect && (zInfo || maxInfo)) {
      // Z/Max moves break through for 25% damage
      this.log(`|-activate|${this.ref(foe)}|move: Protect`);
      const { damage } = this.calcDamage(poke, foe, move, { zInfo, maxInfo, forceRoll: 1 });
      const reduced = Math.floor(damage * 0.25);
      if (reduced > 0) {
        this.dealDamage(poke, foe, reduced, move);
        this.afterDamage(poke, foe, move, this.lastEffectiveness, reduced, { zInfo, maxInfo });
      }
      return;
    }

    // accuracy (z/max never miss)
    if (!zInfo && !maxInfo && !this.accuracyCheck(poke, foe, move)) return;

    // type immunity from chart (struggle ignores)
    const moveType = this.effectiveMoveType(poke, move, { zInfo, maxInfo });
    let eff = move.id === 'struggle' ? 1 : typeEffect(moveType, foe.types);
    // air balloon vs ground
    if (moveType === 'Ground' && !foe.isGrounded(this) && !foe.hasType('Flying')) eff = 0;
    if (moveType === 'Ground' && foe.hasType('Flying') === false && foe.isGrounded(this) && eff === 0 && foe.item === 'ironball') eff = 1;
    // scrappy hits ghosts with normal/fighting
    if (eff === 0 && (moveType === 'Normal' || moveType === 'Fighting') &&
        foe.hasType('Ghost') && poke.ability === 'scrappy') {
      eff = typeEffect(moveType, foe.types.filter(t => t !== 'Ghost'));
    }
    if (eff === 0) { this.log(`|-immune|${this.ref(foe)}`); return; }

    // ability immunities (levitate, absorbs) unless mold breaker
    if (!this.ignoresAbility(poke)) {
      const imm = fx.typeImmunityAbility(foe, moveType);
      if (imm) {
        this.log(`|-immune|${this.ref(foe)}|[from] ability: ${imm.msg}`);
        if (imm.heal) {
          const healed = foe.heal(foe.maxhp * imm.heal);
          if (healed > 0) this.log(`|-heal|${this.ref(foe)}|${this.hpStr(foe)}`);
        }
        if (imm.boost) this.boost(foe, imm.boost, foe);
        if (imm.volatile === 'flashfire') foe.volatiles.flashfire = true;
        return;
      }
    }

    // bulletproof / soundproof
    if (foe.ability === 'bulletproof' && move.flags.bullet) { this.log(`|-immune|${this.ref(foe)}|[from] ability: Bulletproof`); return; }
    if (foe.ability === 'soundproof' && move.flags.sound) { this.log(`|-immune|${this.ref(foe)}|[from] ability: Soundproof`); return; }

    // number of hits
    let hits = 1;
    if (move.multihit && !maxInfo && !zInfo) {
      if (Array.isArray(move.multihit)) {
        hits = poke.ability === 'skilllink' ? move.multihit[1]
          : this.sample([2, 2, 2, 3, 3, 3, 4, 5]);
      } else hits = move.multihit;
    }

    let totalDamage = 0;
    let actualHits = 0;
    let koed = false;
    for (let h = 0; h < hits; h++) {
      if (foe.fainted || poke.fainted) break;
      const { damage, crit } = this.calcDamage(poke, foe, move, { zInfo, maxInfo });
      const dealt = this.dealDamage(poke, foe, damage, move);
      totalDamage += dealt;
      actualHits++;
      if (crit) this.log(`|-crit|${this.ref(foe)}`);
      if (foe.fainted) { koed = true; break; }
    }
    if (hits > 1) this.log(`|-hitcount|${this.ref(foe)}|${actualHits}`);
    if (this.lastEffectiveness > 1) this.log(`|-supereffective|${this.ref(foe)}`);
    else if (this.lastEffectiveness < 1 && this.lastEffectiveness > 0) this.log(`|-resisted|${this.ref(foe)}`);

    this.afterDamage(poke, foe, move, this.lastEffectiveness, totalDamage, { zInfo, maxInfo, koed });
  }

  effectiveMoveType(poke, move, { zInfo, maxInfo } = {}) {
    if (zInfo) return zInfo.type;
    if (maxInfo) return maxInfo.type;
    let type = move.type;
    // Tera Blast
    if (move.id === 'terablast' && poke.terastallized) type = poke.teraType;
    // -ate abilities
    if (type === 'Normal') {
      const ates = { pixilate: 'Fairy', aerilate: 'Flying', refrigerate: 'Ice', galvanize: 'Electric' };
      if (ates[poke.ability]) type = ates[poke.ability];
    }
    if (poke.ability === 'normalize') type = 'Normal';
    // weather ball
    if (move.id === 'weatherball') {
      type = { sun: 'Fire', rain: 'Water', sand: 'Rock', snow: 'Ice' }[this.weather] || 'Normal';
    }
    // judgment/multiattack/revelationdance simplification: keep base
    return type;
  }

  accuracyCheck(poke, foe, move) {
    let acc = move.accuracy;
    if (acc === true) return true;
    if (poke.ability === 'noguard' || foe.ability === 'noguard') return true;
    if (move.id === 'blizzard' && this.weather === 'snow') return true;
    if ((move.id === 'thunder' || move.id === 'hurricane') && this.weather === 'rain') return true;
    if ((move.id === 'thunder' || move.id === 'hurricane') && this.weather === 'sun') acc = 50;
    if (poke.ability === 'compoundeyes') acc *= 1.3;
    if (poke.ability === 'hustle' && move.category === 'Physical') acc *= 0.8;
    if (poke.item === 'wideLens' || poke.item === 'widelens') acc *= 1.1;
    const stage = Math.max(-6, Math.min(6, (poke.boosts.accuracy || 0) - (foe.ability === 'unaware' ? 0 : (foe.boosts.evasion || 0))));
    acc *= stage >= 0 ? (3 + stage) / 3 : 3 / (3 - stage);
    if (this.random() * 100 < acc) return true;
    this.log(`|-miss|${this.ref(poke)}|${this.ref(foe)}`);
    if (poke.item === 'blunderpolicy') {
      this.boost(poke, { spe: 2 }, poke);
      poke.item = '';
    }
    return false;
  }

  calcDamage(attacker, defender, move, { zInfo, maxInfo, forceRoll } = {}) {
    const L = attacker.level;
    const moveType = this.effectiveMoveType(attacker, move, { zInfo, maxInfo });

    // fixed damage
    if (move.id === 'seismictoss' || move.id === 'nightshade') { this.lastEffectiveness = 1; return { damage: L, crit: false }; }
    if (move.id === 'superfang') { this.lastEffectiveness = 1; return { damage: Math.max(1, Math.floor(defender.hp / 2)), crit: false }; }
    if (move.id === 'dragonrage') { this.lastEffectiveness = 1; return { damage: 40, crit: false }; }
    if (move.id === 'sonicboom') { this.lastEffectiveness = 1; return { damage: 20, crit: false }; }
    if (move.id === 'finalgambit') { this.lastEffectiveness = 1; const d = attacker.hp; attacker.damage(attacker.hp); return { damage: d, crit: false }; }

    // base power
    let bp = zInfo ? zInfo.basePower : maxInfo ? maxInfo.basePower : move.basePower;
    bp = this.basePowerCallback(attacker, defender, move, bp);
    if (move.type === 'Normal' && moveType !== 'Normal' && !zInfo && !maxInfo) bp *= 1.2; // -ate bonus
    if (move.id === 'terablast' && attacker.terastallized && attacker.teraType === 'Stellar') bp = 100;

    // effectiveness first (expert belt / tinted lens need it)
    let eff = move.id === 'struggle' ? 1 : typeEffect(moveType, defender.types);
    if (moveType === 'Ground' && !defender.isGrounded(this) && !defender.hasType('Flying')) eff = 0;
    if (eff === 0 && (moveType === 'Normal' || moveType === 'Fighting') && defender.hasType('Ghost') && attacker.ability === 'scrappy') {
      eff = typeEffect(moveType, defender.types.filter(t => t !== 'Ghost'));
    }
    this.lastEffectiveness = eff;

    bp = fx.modifyBasePower(bp, Object.assign({}, move, { type: moveType }), attacker, defender, this);
    if (attacker.volatiles.flashfire && moveType === 'Fire') bp *= 1.5;
    if (move.id === 'solarbeam' || move.id === 'solarblade') {
      if (this.weather && this.weather !== 'sun') bp *= 0.5;
    }
    bp = Math.max(1, Math.floor(bp));

    // category & stats
    let category = zInfo ? zInfo.category : maxInfo ? maxInfo.category : move.category;
    if (move.id === 'terablast' && attacker.terastallized) {
      category = attacker.getStat('atk') > attacker.getStat('spa') ? 'Physical' : 'Special';
    }
    if (move.id === 'photongeyser') {
      category = attacker.getStat('atk') > attacker.getStat('spa') ? 'Physical' : 'Special';
    }

    // crit
    let critStage = (move.critRatio || 1) - 1;
    if (attacker.ability === 'superluck') critStage++;
    if (attacker.item === 'scopelens' || attacker.item === 'razorclaw') critStage++;
    const critChance = [1 / 24, 1 / 8, 1 / 2, 1][Math.min(3, critStage)];
    let crit = move.willCrit === true || this.random() < critChance;
    if (fx.critBlocked(defender) && !this.ignoresAbility(attacker)) crit = false;
    this.lastWasCrit = crit;

    // attack stat
    let atkStat, atkPoke = attacker;
    let atkKey = category === 'Physical' ? 'atk' : 'spa';
    if (move.overrideOffensiveStat) atkKey = move.overrideOffensiveStat;
    if (move.overrideOffensivePokemon === 'target') atkPoke = defender;
    const defenderUnaware = defender.ability === 'unaware' && !this.ignoresAbility(attacker);
    atkStat = atkPoke.getStat(atkKey, {
      ignoreBoost: defenderUnaware,
      ignoreNegative: crit,
    });
    atkStat = fx.modifyStat(atkKey, atkStat, atkPoke, this);

    // defense stat
    let defKey = category === 'Physical' ? 'def' : 'spd';
    if (move.overrideDefensiveStat) defKey = move.overrideDefensiveStat;
    const attackerUnaware = attacker.ability === 'unaware';
    let defStat = defender.getStat(defKey, {
      ignoreBoost: attackerUnaware,
      ignorePositive: crit,
    });
    defStat = fx.modifyStat(defKey, defStat, defender, this);
    // sand special defense boost is in modifyStat; chip away ignores? fine

    let damage = Math.floor(Math.floor(Math.floor(2 * L / 5 + 2) * bp * atkStat / Math.max(1, defStat)) / 50) + 2;

    // weather
    if (this.weather === 'sun') {
      if (moveType === 'Fire') damage = Math.floor(damage * 1.5);
      if (moveType === 'Water') damage = Math.floor(damage * 0.5);
    } else if (this.weather === 'rain') {
      if (moveType === 'Water') damage = Math.floor(damage * 1.5);
      if (moveType === 'Fire') damage = Math.floor(damage * 0.5);
    }

    if (crit) damage = Math.floor(damage * 1.5);

    // random roll
    const roll = forceRoll ?? (0.85 + this.random() * 0.15);
    damage = Math.floor(damage * roll);

    // STAB (with tera rules)
    damage = Math.floor(damage * gx.stabMultiplier(attacker, moveType));

    // effectiveness
    damage = Math.floor(damage * eff);

    // burn
    if (attacker.status === 'brn' && category === 'Physical' &&
        attacker.ability !== 'guts' && move.id !== 'facade') {
      damage = Math.floor(damage * 0.5);
    }

    // screens
    const ds = defender.side.sideConditions;
    const screened = (ds.auroraveil || (category === 'Physical' ? ds.reflect : ds.lightscreen));
    if (screened && !crit && attacker.ability !== 'infiltrator') damage = Math.floor(damage * 0.5);

    // defender ability reductions / attacker boosts
    damage = Math.floor(damage * fx.damageTakenMult(defender, attacker, Object.assign({}, move, { type: moveType, category }), eff, this));
    damage = Math.floor(damage * fx.damageDealtMult(attacker, move, eff));

    return { damage: Math.max(1, damage), eff, crit };
  }

  basePowerCallback(attacker, defender, move, bp) {
    switch (move.id) {
      case 'gyroball': {
        const ratio = this.effectiveSpeed(defender) / Math.max(1, this.effectiveSpeed(attacker));
        return Math.min(150, Math.floor(25 * ratio) + 1);
      }
      case 'electroball': {
        const r = this.effectiveSpeed(attacker) / Math.max(1, this.effectiveSpeed(defender));
        if (r >= 4) return 150; if (r >= 3) return 120; if (r >= 2) return 80; if (r >= 1) return 60; return 40;
      }
      case 'grassknot': case 'lowkick': {
        const w = defender.species.weightkg;
        if (w >= 200) return 120; if (w >= 100) return 100; if (w >= 50) return 80;
        if (w >= 25) return 60; if (w >= 10) return 40; return 20;
      }
      case 'heavyslam': case 'heatcrash': {
        const r = attacker.species.weightkg / Math.max(0.1, defender.species.weightkg);
        if (r >= 5) return 120; if (r >= 4) return 100; if (r >= 3) return 80; if (r >= 2) return 60; return 40;
      }
      case 'facade': return attacker.status ? bp * 2 : bp;
      case 'hex': case 'infernalparade': return defender.status ? bp * 2 : bp;
      case 'brine': return defender.hp <= defender.maxhp / 2 ? bp * 2 : bp;
      case 'venoshock': return (defender.status === 'psn' || defender.status === 'tox') ? bp * 2 : bp;
      case 'acrobatics': return attacker.item ? bp : bp * 2;
      case 'knockoff': return defender.item && !defender.itemKnockedOff ? Math.floor(bp * 1.5) : bp;
      case 'avalanche': case 'revenge': return this.movedThisTurn(defender) && defender.lastMove ? bp * 2 : bp;
      case 'boltbeak': case 'fishiousrend': return !this.movedThisTurn(defender) ? bp * 2 : bp;
      case 'payback': return this.movedThisTurn(defender) ? bp * 2 : bp;
      case 'pursuit': return bp;
      case 'reversal': case 'flail': {
        const r = Math.floor(attacker.hp * 48 / attacker.maxhp);
        if (r <= 1) return 200; if (r <= 4) return 150; if (r <= 9) return 100;
        if (r <= 16) return 80; if (r <= 32) return 40; return 20;
      }
      case 'waterspout': case 'eruption': case 'dragonenergy':
        return Math.max(1, Math.floor(150 * attacker.hp / attacker.maxhp));
      case 'storedpower': case 'powertrip': {
        let n = 0;
        for (const v of Object.values(attacker.boosts)) if (v > 0) n += v;
        return 20 + 20 * n;
      }
      case 'ragingfist': return bp + 50 * Math.min(6, attacker.timesAttacked);
      case 'lastrespects': {
        const fainted = attacker.side.team.filter(p => p.fainted).length;
        return 50 + 50 * Math.min(5, fainted);
      }
    }
    return bp;
  }

  dealDamage(attacker, defender, damage, move) {
    // substitute
    if (defender.volatiles.substitute && !move.flags.sound && attacker.ability !== 'infiltrator') {
      const sub = defender.volatiles.substitute;
      const dealt = Math.min(sub, damage);
      defender.volatiles.substitute -= dealt;
      if (defender.volatiles.substitute <= 0) {
        delete defender.volatiles.substitute;
        this.log(`|-end|${this.ref(defender)}|Substitute`);
      } else {
        this.log(`|-activate|${this.ref(defender)}|move: Substitute|[damage]`);
      }
      this.lastDamageDealt = 0;
      return 0;
    }
    // sturdy / focus sash
    if (damage >= defender.hp && defender.hp === defender.maxhp) {
      if (defender.ability === 'sturdy' && !this.ignoresAbility(attacker)) {
        damage = defender.hp - 1;
        this.log(`|-activate|${this.ref(defender)}|ability: Sturdy`);
      } else if (defender.item === 'focussash') {
        damage = defender.hp - 1;
        defender.item = ''; defender.itemKnockedOff = true;
        this.log(`|-enditem|${this.ref(defender)}|Focus Sash`);
      }
    }
    const dealt = defender.damage(damage);
    this.lastDamageDealt = dealt;
    defender.timesAttacked++;
    this.log(`|-damage|${this.ref(defender)}|${this.hpStr(defender)}`);
    return dealt;
  }

  afterDamage(attacker, defender, move, eff, totalDamage, { zInfo, maxInfo, koed } = {}) {
    const moveType = this.effectiveMoveType(attacker, move, { zInfo, maxInfo });

    // drain
    if (move.drain && totalDamage > 0) {
      const healed = attacker.heal(totalDamage * move.drain[0] / move.drain[1] *
        (attacker.item === 'bigroot' ? 1.3 : 1));
      if (healed > 0) this.log(`|-heal|${this.ref(attacker)}|${this.hpStr(attacker)}|[from] drain`);
    }
    // recoil
    if (move.recoil && totalDamage > 0 && attacker.ability !== 'rockhead' && attacker.ability !== 'magicguard') {
      this.applyDamage(attacker, totalDamage * move.recoil[0] / move.recoil[1], 'Recoil');
    }
    if (move.struggleRecoil) this.applyDamage(attacker, attacker.maxhp / 4, 'Recoil');
    if (move.mindBlownRecoil && attacker.ability !== 'magicguard') this.applyDamage(attacker, attacker.maxhp / 2, 'Recoil');
    if (move.selfdestruct === 'always') {
      attacker.damage(attacker.hp || 1);
      attacker.fainted = true;
      this.checkFaint(attacker);
    }
    // life orb recoil
    if (attacker.item === 'lifeorb' && totalDamage > 0 && attacker.ability !== 'magicguard' && attacker.ability !== 'sheerforce' && !attacker.fainted) {
      this.applyDamage(attacker, attacker.maxhp / 10, 'item: Life Orb');
    }
    // throat spray etc skip

    // secondary effects (sheer force cancels)
    if (!defender.fainted && attacker.ability !== 'sheerforce' && totalDamage > 0) {
      const secondaries = move.secondaries || (move.secondary ? [move.secondary] : []);
      for (const sec of secondaries) {
        if (defender.volatiles.substitute) break;
        let chance = sec.chance ?? 100;
        if (attacker.ability === 'serenegrace') chance *= 2;
        if (!this.chance(chance)) continue;
        if (sec.status && !fx.statusBlocked(defender, sec.status, this, attacker)) {
          this.trySetStatus(defender, sec.status, attacker, `move: ${move.name}`);
        }
        if (sec.volatileStatus === 'flinch' && !this.movedThisTurn(defender) &&
            defender.ability !== 'innerfocus') {
          defender.volatiles.flinch = true;
        }
        if (sec.volatileStatus === 'confusion' && !defender.volatiles.confusion && defender.ability !== 'owntempo') {
          defender.volatiles.confusion = this.randint(2, 5);
          this.log(`|-start|${this.ref(defender)}|confusion`);
        }
        if (sec.boosts) this.boost(defender, sec.boosts, attacker);
        if (sec.self && sec.self.boosts) this.boost(attacker, sec.self.boosts, attacker);
      }
    }
    // king's rock style flinch skip

    // self effects (always, e.g. close combat / superpower drops, overheat)
    if (move.self && move.self.boosts && !attacker.fainted) this.boost(attacker, move.self.boosts, attacker);

    // Max move side effects
    if (maxInfo && totalDamage > 0) {
      if (maxInfo.selfBoost && !attacker.fainted) this.boost(attacker, maxInfo.selfBoost, attacker);
      if (maxInfo.foeBoost && !defender.fainted) this.boost(defender, maxInfo.foeBoost, attacker);
      if (maxInfo.weather) this.setWeather(maxInfo.weather, attacker);
      if (maxInfo.terrain) this.setTerrain(maxInfo.terrain, attacker);
    }

    // knock off removes item
    if (move.id === 'knockoff' && defender.item && !defender.fainted &&
        defender.ability !== 'stickyhold' && !require('./data').getItem(defender.item)?.megaStone) {
      this.log(`|-enditem|${this.ref(defender)}|${defender.item}|[from] move: Knock Off`);
      defender.item = ''; defender.itemKnockedOff = true;
    }
    // clear smog
    if (move.id === 'clearsmog' && !defender.fainted) {
      defender.boosts = { atk: 0, def: 0, spa: 0, spd: 0, spe: 0, accuracy: 0, evasion: 0 };
      this.log(`|-clearboost|${this.ref(defender)}`);
    }
    // rapid spin clears own hazards + speed
    if (move.id === 'rapidspin' && !attacker.fainted) {
      const s = attacker.side;
      if (s.hazards.stealthrock || s.hazards.spikes || s.hazards.toxicspikes || s.hazards.stickyweb) {
        s.hazards = { stealthrock: false, spikes: 0, toxicspikes: 0, stickyweb: false };
        this.log(`|-sideend|p${s.n + 1}|hazards|[from] move: Rapid Spin`);
      }
      this.boost(attacker, { spe: 1 }, attacker);
    }
    // mortal spin / icespinner etc skip terrain clear

    // fire move thaws target
    if (moveType === 'Fire' && defender.status === 'frz' && !defender.fainted) this.cureStatus(defender, 'thawed');
    // defrost user
    if (move.flags.defrost && attacker.status === 'frz') this.cureStatus(attacker, 'thawed');

    // contact effects
    if (move.flags.contact && totalDamage > 0 && !maxInfo &&
        attacker.ability !== 'longreach' && attacker.item !== 'protectivepads') {
      fx.contactEffects(this, attacker, defender);
    }

    // defender reactive items / abilities
    if (totalDamage > 0) fx.afterDamagedItem(this, defender, Object.assign({}, move, { type: moveType }), eff);

    // recharge
    if (move.self && move.self.volatileStatus === 'mustrecharge') attacker.volatiles.mustrecharge = true;

    // faints
    if (defender.fainted) {
      this.checkFaint(defender);
      fx.afterKOEffects(this, attacker);
    }
    this.checkFaint(attacker);

    // self switch (U-turn etc) - replacement happens in the replace phase
    if (move.selfSwitch && !attacker.fainted && attacker.side.alive().length > 1 && totalDamage > 0) {
      attacker.side.pendingSelfSwitch = true;
    }
  }

  checkFaint(poke) {
    if (poke.fainted && !poke.faintLogged) {
      poke.faintLogged = true;
      this.log(`|faint|${this.ref(poke)}`);
    }
  }

  // ---------- shared helpers ----------
  effectiveSpeed(poke) {
    if (!poke) return 0;
    let spe = poke.getStat('spe');
    spe = fx.modifyStat('spe', spe, poke, this);
    return spe;
  }

  boost(poke, boosts, source) {
    if (!poke || poke.fainted) return;
    let b = Object.assign({}, boosts);
    if (poke.ability === 'contrary') {
      for (const k of Object.keys(b)) b[k] = -b[k];
    }
    // protection from foe-inflicted drops
    const fromFoe = source && source.side !== poke.side;
    if (fromFoe) {
      const blocksAll = ['clearbody', 'whitesmoke', 'fullmetalbody'].includes(poke.ability);
      for (const k of Object.keys(b)) {
        if (b[k] < 0 && (blocksAll ||
            (k === 'atk' && poke.ability === 'hypercutter') ||
            (k === 'def' && poke.ability === 'bigpecks') ||
            (k === 'accuracy' && poke.ability === 'keeneye') ||
            (poke.ability === 'mirrorarmor'))) {
          delete b[k];
          this.log(`|-fail|${this.ref(poke)}|unboost|[from] ability`);
        }
      }
    }
    const applied = poke.applyBoosts(b);
    for (const [stat, n] of Object.entries(applied)) {
      this.log(`|${n > 0 ? '-boost' : '-unboost'}|${this.ref(poke)}|${stat}|${Math.abs(n)}`);
    }
    // defiant / competitive
    if (fromFoe && Object.values(applied).some(v => v < 0)) {
      if (poke.ability === 'defiant') this.boost(poke, { atk: 2 }, poke);
      if (poke.ability === 'competitive') this.boost(poke, { spa: 2 }, poke);
    }
  }

  trySetStatus(poke, status, source, reason, selfInflicted = false) {
    if (!poke || poke.fainted || poke.status) return false;
    if (fx.statusBlocked(poke, status, this, source)) return false;
    poke.status = status;
    if (status === 'slp') poke.statusCounter = this.randint(1, 3);
    if (status === 'tox') poke.statusCounter = 0;
    this.log(`|-status|${this.ref(poke)}|${status}${reason ? `|[from] ${reason}` : ''}`);
    // synchronize
    if (source && source !== poke && poke.ability === 'synchronize' &&
        ['brn', 'par', 'psn', 'tox'].includes(status)) {
      this.trySetStatus(source, status, poke, 'ability: Synchronize');
    }
    fx.checkStatusBerry(this, poke);
    return true;
  }

  cureStatus(poke, reason) {
    if (!poke.status) return;
    const s = poke.status;
    poke.status = '';
    poke.statusCounter = 0;
    this.log(`|-curestatus|${this.ref(poke)}|${s}|${reason || ''}`);
  }

  applyDamage(poke, amount, reason) {
    if (poke.fainted) return 0;
    if (poke.ability === 'magicguard' && reason !== 'move') return 0;
    const dealt = poke.damage(amount);
    this.log(`|-damage|${this.ref(poke)}|${this.hpStr(poke)}|[from] ${reason}`);
    this.checkFaint(poke);
    return dealt;
  }

  setWeather(weather, source) {
    if (this.weather === weather) return;
    this.weather = weather;
    let turns = 5;
    const rocks = { sun: 'heatrock', rain: 'damprock', sand: 'smoothrock', snow: 'icyrock' };
    if (source && source.item === rocks[weather]) turns = 8;
    this.weatherTurns = turns;
    this.log(`|-weather|${WEATHER_NAMES[weather]}`);
  }

  setTerrain(terrain, source) {
    if (this.terrain === terrain) return;
    this.terrain = terrain;
    this.terrainTurns = source && source.item === 'terrainextender' ? 8 : 5;
    this.log(`|-fieldstart|move: ${TERRAIN_NAMES[terrain]}`);
  }

  // ---------- end of turn ----------
  endOfTurn() {
    // weather countdown + damage
    if (this.weather) {
      this.weatherTurns--;
      if (this.weatherTurns <= 0) {
        this.log(`|-weather|none`);
        this.weather = '';
      } else {
        this.log(`|-weather|${WEATHER_NAMES[this.weather]}|[upkeep]`);
        if (this.weather === 'sand') {
          for (const side of this.sides) {
            const p = side.active;
            if (p && !p.fainted && !p.hasType('Rock') && !p.hasType('Ground') && !p.hasType('Steel') &&
                !['sandveil', 'sandrush', 'sandforce', 'magicguard', 'overcoat'].includes(p.ability) &&
                p.item !== 'safetygoggles') {
              this.applyDamage(p, p.maxhp / 16, 'Sandstorm');
            }
          }
        }
      }
    }
    // terrain countdown
    if (this.terrain) {
      this.terrainTurns--;
      if (this.terrainTurns <= 0) {
        this.log(`|-fieldend|${TERRAIN_NAMES[this.terrain]}`);
        this.terrain = '';
      } else if (this.terrain === 'grassy') {
        for (const side of this.sides) {
          const p = side.active;
          if (p && !p.fainted && p.isGrounded(this)) {
            const healed = p.heal(p.maxhp / 16);
            if (healed > 0) this.log(`|-heal|${this.ref(p)}|${this.hpStr(p)}|[from] Grassy Terrain`);
          }
        }
      }
    }
    // trick room
    if (this.trickRoom > 0) {
      this.trickRoom--;
      if (this.trickRoom === 0) this.log(`|-fieldend|move: Trick Room`);
    }
    // side condition countdowns
    for (const side of this.sides) {
      for (const [cond, turns] of Object.entries(side.sideConditions)) {
        side.sideConditions[cond] = turns - 1;
        if (side.sideConditions[cond] <= 0) {
          delete side.sideConditions[cond];
          this.log(`|-sideend|p${side.n + 1}|${cond}`);
        }
      }
    }
    // per-pokemon residuals
    for (const side of this.sides) {
      const p = side.active;
      if (!p || p.fainted) continue;
      // status damage
      if (p.status === 'brn') this.applyDamage(p, p.maxhp / 16, 'brn');
      else if (p.status === 'psn') this.applyDamage(p, p.maxhp / 8, 'psn');
      else if (p.status === 'tox') {
        if (p.ability !== 'poisonheal') {
          p.statusCounter++;
          this.applyDamage(p, p.maxhp * p.statusCounter / 16, 'psn');
        } else p.statusCounter++;
      }
      if (p.fainted) continue;
      // leech seed
      if (p.volatiles.leechseed && p.ability !== 'magicguard') {
        const foe = this.foeActive(p);
        const dealt = p.damage(p.maxhp / 8);
        this.log(`|-damage|${this.ref(p)}|${this.hpStr(p)}|[from] Leech Seed`);
        if (foe && !foe.fainted && dealt > 0) {
          const healed = foe.heal(dealt);
          if (healed > 0) this.log(`|-heal|${this.ref(foe)}|${this.hpStr(foe)}|[silent]`);
        }
        if (p.fainted) { this.checkFaint(p); continue; }
      }
      // items/abilities
      fx.residualEffects(this, p);
      fx.checkBerry(this, p);
      if (p.fainted) continue;
      // dynamax countdown
      if (p.dynamaxed) {
        p.dynamaxTurns--;
        if (p.dynamaxTurns <= 0) {
          p.endDynamax();
          this.log(`|-enddynamax|${this.ref(p)}`);
          this.log(`|-damage|${this.ref(p)}|${this.hpStr(p)}|[silent]`);
        }
      }
      // clear protect; reset the consecutive-protect counter unless a
      // protect-like move was used this turn
      delete p.volatiles.protect;
      const protectIds = ['protect', 'detect', 'banefulbunker', 'spikyshield', 'silktrap'];
      const usedProtect = p.lastMove && protectIds.includes(p.lastMove) && this.movedSet.has(p);
      if (!usedProtect) p.protectCounter = 0;
      p.turnsOut++;
    }
    this.checkWin();
  }
}

module.exports = { Battle, Side };
