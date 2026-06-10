// The battle engine core: our own turn loop, damage formula, status, weather,
// terrain, hazards, screens and gimmick integration, for singles AND doubles.
// Emits a Showdown-like line protocol that the client renders.
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
const SLOT_LETTERS = 'ab';

class Side {
  constructor(n, name, sets, numActives) {
    this.n = n;
    this.name = name;
    this.team = sets.map((set, i) => new Pokemon(set, this, i));
    this.actives = new Array(numActives).fill(null);
    this.hazards = { stealthrock: false, spikes: 0, toxicspikes: 0, stickyweb: false };
    this.sideConditions = {};   // reflect, lightscreen, auroraveil, tailwind -> turns left
    this.usedGimmicks = { tera: false, mega: false, zmove: false, dynamax: false };
    this.choices = null;        // array aligned to actives
    this.needsSwitch = [];      // per-slot replacement flags
    this.batonBoosts = null;    // per-slot map
    this.rqid = 0;
  }
  alive() { return this.team.filter(p => !p.fainted); }
  benched() { return this.team.filter(p => !p.fainted && !this.actives.includes(p)); }
  defeated() { return this.team.every(p => p.fainted); }
  aliveActives() { return this.actives.filter(p => p && !p.fainted); }
}

class Battle {
  constructor(p1, p2, opts = {}) {
    this.rand = mulberry32(opts.seed ?? Math.floor(Math.random() * 2 ** 31));
    this.gameType = opts.gameType === 'doubles' ? 'doubles' : 'singles';
    this.numActives = this.gameType === 'doubles' ? 2 : 1;
    this.sides = [
      new Side(0, p1.name, p1.team, this.numActives),
      new Side(1, p2.name, p2.team, this.numActives),
    ];
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

  ref(poke) {
    const slot = Math.max(0, poke.side.actives.indexOf(poke));
    return `p${poke.side.n + 1}${SLOT_LETTERS[slot]}: ${poke.name}`;
  }
  hpStr(poke) {
    if (poke.fainted || poke.hp <= 0) return '0 fnt';
    return `${poke.hpPercent()}/100${poke.status ? ' ' + poke.status : ''}`;
  }
  foeSide(side) { return this.sides[1 - side.n]; }
  foesOf(poke) { return this.foeSide(poke.side).aliveActives(); }
  allyOf(poke) {
    return poke.side.actives.find(p => p && p !== poke && !p.fainted) || null;
  }
  ignoresAbility(attacker) {
    return ['moldbreaker', 'teravolt', 'turboblaze'].includes(attacker.ability);
  }
  movedThisTurn(poke) { return this.movedSet.has(poke); }

  // weather negated by Cloud Nine / Air Lock on the field
  effWeather() {
    for (const side of this.sides) {
      for (const p of side.aliveActives()) {
        if (p.ability === 'cloudnine' || p.ability === 'airlock') return '';
      }
    }
    return this.weather;
  }

  // ---------- lifecycle ----------
  start() {
    this.log(`|player|p1|${this.sides[0].name}`);
    this.log(`|player|p2|${this.sides[1].name}`);
    this.log(`|teamsize|p1|${this.sides[0].team.length}`);
    this.log(`|teamsize|p2|${this.sides[1].team.length}`);
    this.log(`|gametype|${this.gameType}`);
    this.log(`|start`);
    for (const side of this.sides) {
      for (let slot = 0; slot < this.numActives; slot++) {
        if (side.team[slot]) this.switchIn(side, slot, slot, true);
      }
    }
    for (const side of this.sides) {
      for (const p of side.aliveActives()) fx.onSwitchInEffects(this, p);
    }
    this.nextTurn();
  }

  nextTurn() {
    if (this.checkWin()) return;
    this.turn++;
    this.movedSet.clear();
    this.phase = 'choice';
    for (const side of this.sides) {
      side.choices = null;
      side.needsSwitch = [];
      side.rqid++;
    }
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
    const req = { rqid: side.rqid, gameType: this.gameType, side: this.sideData(side) };
    if (this.ended) return req;
    if (this.phase === 'replace') {
      const needs = side.needsSwitch.some(Boolean);
      req.forceSwitch = needs ? side.needsSwitch.slice() : null;
      req.wait = !needs;
      return req;
    }
    req.actives = side.actives.map((poke, slot) => this.activeRequest(side, poke, slot));
    if (req.actives.every(a => !a)) req.wait = true;
    return req;
  }

  activeRequest(side, poke, slot) {
    if (!poke || poke.fainted) return null;
    const choiceLocked = (['choiceband', 'choicespecs', 'choicescarf'].includes(poke.item) ||
      poke.ability === 'gorillatactics') && poke.lastMove && !poke.dynamaxed;
    let moves = poke.moves.map(s => {
      const m = getMove(s.id);
      return {
        id: s.id, name: s.name, pp: s.pp, maxpp: s.maxpp,
        type: m.type, category: m.category, basePower: m.basePower,
        accuracy: m.accuracy === true ? '—' : m.accuracy,
        target: m.target,
        disabled: s.pp <= 0 || (choiceLocked && s.id !== poke.lastMove),
      };
    });
    if (moves.every(m => m.disabled)) {
      moves = [{ id: 'struggle', name: 'Struggle', pp: 1, maxpp: 1, type: 'Normal', category: 'Physical', basePower: 50, accuracy: '—', target: 'normal', disabled: false }];
    }
    const active = { slot, moves };
    active.canTera = gx.canTera(poke, side) ? poke.teraType : false;
    active.canMega = gx.canMega(poke, side) ? gx.megaFormeFor(poke) : false;
    active.canDynamax = gx.canDynamax(poke, side);
    active.dynamaxed = poke.dynamaxed;
    if (gx.canZMove(poke, side)) {
      active.canZMove = poke.moves.map(s => {
        const z = gx.zMoveFor(poke, s);
        return z ? { name: z.name, basePower: z.basePower, type: z.type } : null;
      });
    } else active.canZMove = false;
    if (active.canDynamax || poke.dynamaxed) {
      active.maxMoves = poke.moves.map(s => {
        const mm = gx.maxMoveFor(getMove(s.id));
        return { name: mm.name, basePower: mm.basePower, type: mm.type, category: mm.category };
      });
    }
    if (poke.volatiles.mustrecharge) active.mustRecharge = true;
    return active;
  }

  sideData(side) {
    return {
      name: side.name,
      n: side.n,
      gameType: this.gameType,
      pokemon: side.team.map(p => ({
        ident: `p${side.n + 1}: ${p.name}`,
        species: p.species.name,
        details: p.details(),
        condition: p.fainted ? '0 fnt' : `${p.hp}/${p.maxhp}${p.status ? ' ' + p.status : ''}`,
        active: side.actives.includes(p),
        activeSlot: side.actives.indexOf(p),
        stats: p.stats,
        boosts: p.boosts,
        moves: p.moves.map(m => ({ id: m.id, name: m.name, pp: m.pp, maxpp: m.maxpp })),
        item: p.item, ability: p.ability, teraType: p.teraType, shiny: p.shiny,
        terastallized: p.terastallized, mega: p.mega, dynamaxed: p.dynamaxed,
      })),
      usedGimmicks: side.usedGimmicks,
    };
  }

  // ---------- choices ----------
  /**
   * choice: { actions: [actionOrNull per active slot] }
   * action: {action:'move', move:0-3, gimmick?, target?:{side,slot}} | {action:'switch', target:teamIdx}
   */
  choose(sideIdx, choice) {
    if (this.ended) return { error: 'Battle is over' };
    const side = this.sides[sideIdx];
    // back-compat: accept a bare action object for singles
    if (choice && choice.action && !choice.actions) choice = { actions: [choice] };
    if (!choice || !Array.isArray(choice.actions)) return { error: 'Bad choice format' };

    const err = this.validateChoice(side, choice);
    if (err) return { error: err };

    side.choices = choice.actions;
    if (this.phase === 'replace') {
      const waiting = this.sides.some(s => s.needsSwitch.some(Boolean) && !s.choices);
      if (!waiting) this.commitReplacements();
      return { ok: true };
    }
    if (this.sides.every(s => s.choices || s.aliveActives().length === 0)) this.commitTurn();
    return { ok: true };
  }

  validateChoice(side, choice) {
    const actions = choice.actions;
    const switchTargets = new Set();
    if (this.phase === 'replace') {
      for (let slot = 0; slot < this.numActives; slot++) {
        const a = actions[slot];
        if (!side.needsSwitch[slot]) {
          if (a) return 'No replacement needed in that slot';
          continue;
        }
        if (!a || a.action !== 'switch') {
          // allow pass when no bench remains
          if (side.benched().length > switchTargets.size) return 'Must choose a replacement';
          continue;
        }
        const t = side.team[a.target];
        if (!t || t.fainted || side.actives.includes(t)) return 'Invalid replacement';
        if (switchTargets.has(a.target)) return 'Cannot switch two slots to the same Pokemon';
        switchTargets.add(a.target);
      }
      return null;
    }
    for (let slot = 0; slot < this.numActives; slot++) {
      const poke = side.actives[slot];
      const a = actions[slot];
      if (!poke || poke.fainted) { if (a) return 'No active Pokemon in that slot'; continue; }
      if (!a) return 'Missing action for an active Pokemon';
      if (a.action === 'switch') {
        const t = side.team[a.target];
        if (!t) return 'No such Pokemon';
        if (t.fainted) return `${t.name} has fainted`;
        if (side.actives.includes(t)) return `${t.name} is already in battle`;
        if (switchTargets.has(a.target)) return 'Cannot switch two slots to the same Pokemon';
        switchTargets.add(a.target);
        continue;
      }
      if (a.action === 'move') {
        if (a.move === 'struggle') continue;
        const moveSlot = poke.moves[a.move];
        if (!moveSlot) return 'No such move';
        if (moveSlot.pp <= 0 && !poke.moves.every(m => m.pp <= 0)) return 'No PP left';
        const g = a.gimmick;
        if (g === 'tera' && !gx.canTera(poke, side)) return 'Cannot Terastallize';
        if (g === 'mega' && !gx.canMega(poke, side)) return 'Cannot Mega Evolve';
        if (g === 'dynamax' && !gx.canDynamax(poke, side)) return 'Cannot Dynamax';
        if (g === 'zmove' && !(gx.canZMove(poke, side) && gx.zMoveFor(poke, moveSlot))) return 'Cannot use Z-Move';
        continue;
      }
      return 'Unknown action';
    }
    // only one gimmick activation per side per turn
    const gimmicksThisTurn = actions.filter(a => a && a.gimmick).length;
    if (gimmicksThisTurn > 1) return 'Only one gimmick per turn';
    return null;
  }

  // ---------- turn execution ----------
  commitTurn() {
    const actions = [];
    for (const side of this.sides) {
      const choices = side.choices || [];
      for (let slot = 0; slot < this.numActives; slot++) {
        const poke = side.actives[slot];
        const c = choices[slot];
        if (!poke || poke.fainted || !c) continue;
        if (c.action === 'switch') {
          actions.push({ side, slot, poke, type: 'switch', target: c.target, speed: this.effectiveSpeed(poke) });
        } else {
          let moveId = c.move === 'struggle' || poke.moves.every(m => m.pp <= 0) ? 'struggle' : poke.moves[c.move]?.id;
          const move = getMove(moveId) || getMove('struggle');
          const pri = fx.movePriorityMod(move, poke, this);
          const quick = (poke.item === 'quickclaw' && this.chance(20)) ||
                        (poke.item === 'custapberry' && poke.hp <= poke.maxhp / 4);
          actions.push({
            side, slot, poke, type: 'move', moveIndex: c.move, moveId: move.id,
            gimmick: c.gimmick, targetChoice: c.target,
            priority: pri, speed: this.effectiveSpeed(poke), quick,
          });
        }
      }
    }
    actions.sort((a, b) => {
      const ta = a.type === 'switch' ? 1 : 0, tb = b.type === 'switch' ? 1 : 0;
      if (ta !== tb) return tb - ta; // switches first
      if (a.type === 'move' && b.type === 'move') {
        if (a.priority !== b.priority) return b.priority - a.priority;
        if (a.quick !== b.quick) return (b.quick ? 1 : 0) - (a.quick ? 1 : 0);
      }
      let sa = a.speed, sb = b.speed;
      if (this.trickRoom > 0) { sa = -sa; sb = -sb; }
      if (sa !== sb) return sb - sa;
      return this.random() < 0.5 ? -1 : 1;
    });

    for (const action of actions) {
      if (this.ended) break;
      if (action.type === 'switch') {
        if (action.poke.fainted || !action.side.actives.includes(action.poke)) continue;
        this.voluntarySwitch(action.side, action.side.actives.indexOf(action.poke), action.target);
      } else {
        if (action.poke.fainted || !action.side.actives.includes(action.poke)) continue;
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
      side.choices = null;
      side.needsSwitch = side.actives.map((p, slot) =>
        !!((!p || p.fainted || side.pendingSelfSwitch?.[slot]) && side.benched().length > 0));
      side.pendingSelfSwitch = null;
      // can't replace more slots than bench size
      let benchLeft = side.benched().length;
      side.needsSwitch = side.needsSwitch.map(n => {
        if (n && benchLeft > 0) { benchLeft--; return true; }
        return false;
      });
      if (side.needsSwitch.some(Boolean)) anyReplace = true;
      side.rqid++;
    }
    if (anyReplace) this.phase = 'replace';
    else this.nextTurn();
  }

  commitReplacements() {
    for (const side of this.sides) {
      if (!side.needsSwitch.some(Boolean) || !side.choices) continue;
      for (let slot = 0; slot < this.numActives; slot++) {
        const a = side.choices[slot];
        if (side.needsSwitch[slot] && a && a.action === 'switch') {
          this.switchIn(side, slot, a.target);
        }
      }
      side.needsSwitch = [];
      side.choices = null;
    }
    for (const side of this.sides) {
      for (const p of side.aliveActives()) {
        if (p.justSwitchedIn) {
          p.justSwitchedIn = false;
          fx.onSwitchInEffects(this, p);
        }
      }
    }
    if (this.checkWin()) return;
    // hazards / switch-in effects may have fainted the new pokemon
    let again = false;
    for (const side of this.sides) {
      side.needsSwitch = side.actives.map(p => !!(p && p.fainted && side.benched().length > 0));
      let benchLeft = side.benched().length;
      side.needsSwitch = side.needsSwitch.map(n => {
        if (n && benchLeft > 0) { benchLeft--; return true; }
        return false;
      });
      if (side.needsSwitch.some(Boolean)) { again = true; side.rqid++; }
    }
    if (again) { this.phase = 'replace'; return; }
    this.nextTurn();
  }

  voluntarySwitch(side, slot, targetIdx) {
    const out = side.actives[slot];
    if (out && !out.fainted) this.log(`|-message|${out.name}, come back!`);
    this.switchIn(side, slot, targetIdx);
    const poke = side.actives[slot];
    if (poke && !poke.fainted) { poke.justSwitchedIn = false; fx.onSwitchInEffects(this, poke); }
  }

  switchIn(side, slot, targetIdx, initial = false) {
    const out = side.actives[slot];
    if (out) { out.active = false; out.clearVolatilesOnSwitch(); }
    const poke = side.team[targetIdx];
    if (!poke || poke.fainted) return;
    poke.active = true;
    poke.justSwitchedIn = true;
    side.actives[slot] = poke;
    this.log(`|switch|${this.ref(poke)}|${poke.details()}|${this.hpStr(poke)}`);
    if (side.batonBoosts && side.batonBoosts[slot]) {
      poke.applyBoosts(side.batonBoosts[slot]);
      side.batonBoosts[slot] = null;
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

  // ---------- targeting ----------
  resolveTargets(attacker, move, targetChoice) {
    const foes = this.foesOf(attacker);
    const ally = this.allyOf(attacker);
    switch (move.target) {
      case 'self': case 'allySide': case 'allyTeam':
        return [attacker];
      case 'allAdjacentFoes':
        return foes;
      case 'allAdjacent':
        return ally ? [...foes, ally] : foes;
      case 'all':
        return [attacker];
      case 'adjacentAlly':
        return ally ? [ally] : [];
      case 'adjacentAllyOrSelf':
        return [ally || attacker];
      default: {
        // single target: honor the chosen target if still valid
        if (targetChoice && typeof targetChoice.side === 'number') {
          const ts = this.sides[targetChoice.side];
          const t = ts && ts.actives[targetChoice.slot];
          if (t && !t.fainted) return [t];
        }
        return foes.length ? [foes[0]] : [];
      }
    }
  }

  // ---------- move action pipeline ----------
  runMoveAction(action) {
    const side = action.side;
    const poke = action.poke;

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
    if (poke.dynamaxed) maxInfo = gx.maxMoveFor(move);

    // PP
    if (slot) slot.pp = Math.max(0, slot.pp - 1);
    poke.lastMove = moveId;
    this.movedSet.add(poke);

    const targets = this.resolveTargets(poke, move, action.targetChoice);
    const primaryTarget = targets[0] || null;

    const displayName = zInfo ? zInfo.name : maxInfo ? maxInfo.name : move.name;
    const animType = zInfo ? zInfo.type : maxInfo ? maxInfo.type : this.effectiveMoveType(poke, move);
    const animCat = zInfo ? zInfo.category : maxInfo ? maxInfo.category : move.category;
    this.log(`|move|${this.ref(poke)}|${displayName}|${primaryTarget ? this.ref(primaryTarget) : ''}|${animType}|${animCat}`);

    // Protean / Libero
    if ((poke.ability === 'protean' || poke.ability === 'libero') && !poke.terastallized &&
        !poke.types.every(t => t === move.type) && !poke.volatiles.proteanUsed) {
      poke.types = [move.type];
      poke.volatiles.proteanUsed = true;
      this.log(`|-start|${this.ref(poke)}|typechange|${move.type}|[from] ability: ${poke.ability === 'protean' ? 'Protean' : 'Libero'}`);
    }

    if (maxInfo && maxInfo.isMaxGuard) { this.useProtect(poke, 'Max Guard'); return; }

    if (move.category === 'Status' && !zInfo) {
      this.runStatusMove(poke, primaryTarget && primaryTarget !== poke ? primaryTarget : (this.foesOf(poke)[0] || null), move);
      return;
    }

    // damaging move: hit each target (spread penalty when 2+)
    const spread = targets.length > 1 ? 0.75 : 1;
    let anyHit = false;
    for (const target of targets) {
      if (poke.fainted) break;
      if (!target || target.fainted) continue;
      const hit = this.runDamagingMoveOnTarget(poke, target, move, { zInfo, maxInfo, spread });
      anyHit = anyHit || hit;
      if (this.ended) return;
    }
    if (!targets.length) this.log(`|-fail|${this.ref(poke)}|noTarget`);

    // user-side after effects that should happen once
    if (anyHit && move.self && move.self.boosts && !poke.fainted) this.boost(poke, move.self.boosts, poke);
    if (anyHit && move.self && move.self.volatileStatus === 'mustrecharge') poke.volatiles.mustrecharge = true;
    if (anyHit && move.selfSwitch && !poke.fainted && poke.side.benched().length > 0) {
      poke.side.pendingSelfSwitch = poke.side.pendingSelfSwitch || [];
      poke.side.pendingSelfSwitch[poke.side.actives.indexOf(poke)] = true;
    }
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

    if (!targetSelf && foe && move.accuracy !== true) {
      if (!this.accuracyCheck(poke, foe, move)) return;
    }
    if (!targetSelf && foe && foe.volatiles.protect && move.flags.protect) {
      this.log(`|-activate|${this.ref(foe)}|move: Protect`);
      return;
    }
    if (!targetSelf && foe && move.flags.reflectable && foe.ability === 'magicbounce') {
      this.log(`|-activate|${this.ref(foe)}|ability: Magic Bounce`);
      [poke, foe] = [foe, poke];
    }

    let did = false;
    if (move.boosts) {
      const target = targetSelf || move.target === 'self' ? poke : foe;
      if (target && !target.fainted) { this.boost(target, move.boosts, poke); did = true; }
    }
    if (move.self && move.self.boosts) { this.boost(poke, move.self.boosts, poke); did = true; }
    if (move.status && foe && !foe.fainted) {
      const blocked = fx.statusBlocked(foe, move.status, this, poke);
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
      } else if (['taunt', 'yawn', 'encore'].includes(move.volatileStatus)) {
        this.log(`|-fail|${this.ref(poke)}`); // not implemented
      }
    }
    if (move.sideCondition) { this.applySideCondition(poke, foe, move); did = true; }
    if (move.weather) {
      const w = toID(move.weather).replace('sunnyday', 'sun').replace('raindance', 'rain')
        .replace('sandstorm', 'sand').replace('snowscape', 'snow').replace('hail', 'snow');
      this.setWeather(w, poke); did = true;
    }
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
        if (poke.hp === poke.maxhp ||
            ['insomnia', 'vitalspirit', 'comatose', 'purifyingsalt'].includes(poke.ability)) {
          this.log(`|-fail|${this.ref(poke)}`); return true;
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
        if (this.effWeather() === 'sun') frac = 2 / 3;
        else if (this.effWeather()) frac = 1 / 4;
        const healed = poke.heal(poke.maxhp * frac);
        if (healed > 0) this.log(`|-heal|${this.ref(poke)}|${this.hpStr(poke)}`);
        else this.log(`|-fail|${this.ref(poke)}`);
        return true;
      }
      case 'shoreup': {
        const healed = poke.heal(poke.maxhp * (this.effWeather() === 'sand' ? 2 / 3 : 1 / 2));
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
      case 'haze': {
        for (const side of this.sides) {
          for (const p of side.aliveActives()) {
            p.boosts = { atk: 0, def: 0, spa: 0, spd: 0, spe: 0, accuracy: 0, evasion: 0 };
          }
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
        foe.hp = Math.min(foe.maxhp, Math.max(1, avg));
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
        if (move.flags.powder && (foe.hasType('Grass') || foe.ability === 'overcoat' || foe.item === 'safetygoggles')) {
          this.log(`|-immune|${this.ref(foe)}`); return true;
        }
        if (move.id === 'thunderwave' && typeEffect('Electric', foe.types) === 0) {
          this.log(`|-immune|${this.ref(foe)}`); return true;
        }
        const alwaysHits = move.id === 'toxic' && poke.hasType('Poison');
        if (!alwaysHits && move.accuracy !== true && !this.accuracyCheck(poke, foe, move)) return true;
        if (foe.volatiles.protect && move.flags.protect) { this.log(`|-activate|${this.ref(foe)}|move: Protect`); return true; }
        const status = move.id === 'yawn' ? 'slp' : move.status;
        if (move.flags.reflectable && foe.ability === 'magicbounce') {
          this.log(`|-activate|${this.ref(foe)}|ability: Magic Bounce`);
          if (!fx.statusBlocked(poke, status, this, foe)) this.trySetStatus(poke, status, foe, `move: ${move.name}`);
          return true;
        }
        if (fx.statusBlocked(foe, status, this, poke)) this.log(`|-fail|${this.ref(foe)}`);
        else this.trySetStatus(foe, status, poke, `move: ${move.name}`);
        return true;
      }
      case 'batonpass': {
        if (poke.side.benched().length < 1) { this.log(`|-fail|${this.ref(poke)}`); return true; }
        const slot = poke.side.actives.indexOf(poke);
        poke.side.pendingSelfSwitch = poke.side.pendingSelfSwitch || [];
        poke.side.pendingSelfSwitch[slot] = true;
        poke.side.batonBoosts = poke.side.batonBoosts || [];
        poke.side.batonBoosts[slot] = Object.assign({}, poke.boosts);
        this.log(`|-activate|${this.ref(poke)}|move: Baton Pass`);
        return true;
      }
      case 'teleport': case 'partingshot': case 'chillyreception': {
        if (move.id === 'partingshot' && foe && !foe.fainted) this.boost(foe, { atk: -1, spa: -1 }, poke);
        if (move.id === 'chillyreception') this.setWeather('snow', poke);
        if (poke.side.benched().length > 0) {
          const slot = poke.side.actives.indexOf(poke);
          poke.side.pendingSelfSwitch = poke.side.pendingSelfSwitch || [];
          poke.side.pendingSelfSwitch[slot] = true;
        }
        return true;
      }
      case 'followme': case 'ragepowder': {
        poke.volatiles.followme = true;
        this.log(`|-singleturn|${this.ref(poke)}|move: ${move.name}`);
        return true;
      }
      case 'helpinghand': {
        const ally = this.allyOf(poke);
        if (!ally) { this.log(`|-fail|${this.ref(poke)}`); return true; }
        ally.volatiles.helpinghand = true;
        this.log(`|-singleturn|${this.ref(ally)}|move: Helping Hand`);
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
      if (id === 'auroraveil' && this.effWeather() !== 'snow') { this.log(`|-fail|${this.ref(poke)}`); return; }
      if (side.sideConditions[id]) { this.log(`|-fail|${this.ref(poke)}`); return; }
      let turns = selfConds[id];
      if ((id === 'reflect' || id === 'lightscreen' || id === 'auroraveil') && poke.item === 'lightclay') turns = 8;
      side.sideConditions[id] = turns;
      this.log(`|-sidestart|p${side.n + 1}|move: ${move.name}`);
      return;
    }
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
  /** returns true when the move connected with this target */
  runDamagingMoveOnTarget(poke, foe, move, { zInfo, maxInfo, spread = 1 }) {
    // Follow Me / Rage Powder redirection (single-target moves only)
    if (spread === 1 && !['self'].includes(move.target)) {
      const redirector = this.foesOf(poke).find(p => p.volatiles.followme);
      if (redirector && redirector !== foe && foe.side === redirector.side) foe = redirector;
    }

    // psychic terrain blocks priority against grounded targets
    const pri = fx.movePriorityMod(move, poke, this);
    if (this.terrain === 'psychic' && pri > 0 && foe.isGrounded(this) && foe.side !== poke.side) {
      this.log(`|-activate|${this.ref(foe)}|Psychic Terrain`);
      return false;
    }

    // Sucker Punch
    if (move.id === 'suckerpunch' || move.id === 'thunderclap') {
      const foeChoice = foe.side.choices && foe.side.choices[foe.side.actives.indexOf(foe)];
      const foeMoved = this.movedThisTurn(foe);
      const foeAttacking = foeChoice && foeChoice.action === 'move' &&
        (() => {
          const fm = foe.moves[foeChoice.move];
          const fmove = fm ? getMove(fm.id) : null;
          return fmove && fmove.category !== 'Status';
        })();
      if (foeMoved || !foeAttacking) { this.log(`|-fail|${this.ref(poke)}`); return false; }
    }
    // Fake Out / First Impression
    if ((move.id === 'fakeout' || move.id === 'firstimpression') && poke.turnsOut > 0) {
      this.log(`|-fail|${this.ref(poke)}`); return false;
    }

    // protect
    if (foe.volatiles.protect && move.flags.protect && !zInfo && !maxInfo) {
      this.log(`|-activate|${this.ref(foe)}|move: Protect`);
      return false;
    }
    if (foe.volatiles.protect && (zInfo || maxInfo)) {
      this.log(`|-activate|${this.ref(foe)}|move: Protect`);
      const { damage } = this.calcDamage(poke, foe, move, { zInfo, maxInfo, forceRoll: 1, spread });
      const reduced = Math.floor(damage * 0.25);
      if (reduced > 0) {
        this.dealDamage(poke, foe, reduced, move);
        this.afterDamage(poke, foe, move, this.lastEffectiveness, reduced, { zInfo, maxInfo });
      }
      return true;
    }

    // accuracy (z/max never miss)
    if (!zInfo && !maxInfo && !this.accuracyCheck(poke, foe, move)) return false;

    // type immunity from chart (struggle ignores)
    const moveType = this.effectiveMoveType(poke, move, { zInfo, maxInfo });
    let eff = move.id === 'struggle' ? 1 : typeEffect(moveType, foe.types);
    if (moveType === 'Ground' && !foe.isGrounded(this) && !foe.hasType('Flying')) eff = 0;
    if (eff === 0 && (moveType === 'Normal' || moveType === 'Fighting') &&
        foe.hasType('Ghost') && poke.ability === 'scrappy') {
      eff = typeEffect(moveType, foe.types.filter(t => t !== 'Ghost'));
    }
    if (eff === 0) { this.log(`|-immune|${this.ref(foe)}`); return false; }

    // Wonder Guard
    if (foe.ability === 'wonderguard' && eff <= 1 && !this.ignoresAbility(poke)) {
      this.log(`|-immune|${this.ref(foe)}|[from] ability: Wonder Guard`);
      return false;
    }

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
        return false;
      }
    }

    // bulletproof / soundproof
    if (foe.ability === 'bulletproof' && move.flags.bullet) { this.log(`|-immune|${this.ref(foe)}|[from] ability: Bulletproof`); return false; }
    if (foe.ability === 'soundproof' && move.flags.sound) { this.log(`|-immune|${this.ref(foe)}|[from] ability: Soundproof`); return false; }

    // Disguise (Mimikyu): first damaging hit is absorbed
    if (foe.ability === 'disguise' && !foe.volatiles.disguiseBusted &&
        foe.species.baseSpecies === 'Mimikyu' && !this.ignoresAbility(poke)) {
      foe.volatiles.disguiseBusted = true;
      this.log(`|-activate|${this.ref(foe)}|ability: Disguise`);
      this.applyDamage(foe, foe.maxhp / 8, 'ability: Disguise');
      return true;
    }

    // number of hits
    let hits = 1;
    if (move.multihit && !maxInfo && !zInfo) {
      if (Array.isArray(move.multihit)) {
        hits = poke.ability === 'skilllink' ? move.multihit[1]
          : poke.item === 'loadeddice' ? this.sample([4, 4, 5])
          : this.sample([2, 2, 2, 3, 3, 3, 4, 5]);
      } else hits = move.multihit;
    }
    // Parental Bond: second hit at 25% power
    const parentalBond = poke.ability === 'parentalbond' && hits === 1 && !move.multihit &&
      !zInfo && !maxInfo && move.id !== 'struggle';
    if (parentalBond) hits = 2;

    let totalDamage = 0;
    let actualHits = 0;
    for (let h = 0; h < hits; h++) {
      if (foe.fainted || poke.fainted) break;
      const hitMod = parentalBond && h === 1 ? 0.25 : 1;
      const { damage, crit } = this.calcDamage(poke, foe, move, { zInfo, maxInfo, spread });
      const dealt = this.dealDamage(poke, foe, Math.max(1, Math.floor(damage * hitMod)), move);
      totalDamage += dealt;
      actualHits++;
      if (crit) this.log(`|-crit|${this.ref(foe)}`);
      if (foe.fainted) break;
    }
    if (hits > 1 && actualHits > 1) this.log(`|-hitcount|${this.ref(foe)}|${actualHits}`);
    if (this.lastEffectiveness > 1) this.log(`|-supereffective|${this.ref(foe)}`);
    else if (this.lastEffectiveness < 1 && this.lastEffectiveness > 0) this.log(`|-resisted|${this.ref(foe)}`);

    this.afterDamage(poke, foe, move, this.lastEffectiveness, totalDamage, { zInfo, maxInfo });
    return true;
  }

  effectiveMoveType(poke, move, { zInfo, maxInfo } = {}) {
    if (zInfo) return zInfo.type;
    if (maxInfo) return maxInfo.type;
    let type = move.type;
    if (move.id === 'terablast' && poke.terastallized) type = poke.teraType;
    if (type === 'Normal') {
      const ates = { pixilate: 'Fairy', aerilate: 'Flying', refrigerate: 'Ice', galvanize: 'Electric' };
      if (ates[poke.ability]) type = ates[poke.ability];
    }
    if (poke.ability === 'normalize') type = 'Normal';
    if (move.id === 'weatherball') {
      type = { sun: 'Fire', rain: 'Water', sand: 'Rock', snow: 'Ice' }[this.effWeather()] || 'Normal';
    }
    return type;
  }

  accuracyCheck(poke, foe, move) {
    let acc = move.accuracy;
    if (acc === true) return true;
    if (poke.ability === 'noguard' || foe.ability === 'noguard') return true;
    const w = this.effWeather();
    if (move.id === 'blizzard' && w === 'snow') return true;
    if ((move.id === 'thunder' || move.id === 'hurricane') && w === 'rain') return true;
    if ((move.id === 'thunder' || move.id === 'hurricane') && w === 'sun') acc = 50;
    if (poke.ability === 'compoundeyes') acc *= 1.3;
    if (poke.ability === 'victorystar') acc *= 1.1;
    if (poke.ability === 'hustle' && move.category === 'Physical') acc *= 0.8;
    if (poke.item === 'widelens') acc *= 1.1;
    if (foe.item === 'brightpowder') acc *= 0.9;
    if (foe.ability === 'sandveil' && w === 'sand') acc *= 0.8;
    if (foe.ability === 'snowcloak' && w === 'snow') acc *= 0.8;
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

  calcDamage(attacker, defender, move, { zInfo, maxInfo, forceRoll, spread = 1 } = {}) {
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
    if (attacker.volatiles.helpinghand) bp *= 1.5;
    if (move.id === 'solarbeam' || move.id === 'solarblade') {
      const w = this.effWeather();
      if (w && w !== 'sun') bp *= 0.5;
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
    if (attacker.ability === 'merciless' && ['psn', 'tox'].includes(defender.status)) critStage = 3;
    const critChance = [1 / 24, 1 / 8, 1 / 2, 1][Math.min(3, critStage)];
    let crit = move.willCrit === true || this.random() < critChance;
    if (fx.critBlocked(defender) && !this.ignoresAbility(attacker)) crit = false;
    this.lastWasCrit = crit;

    // attack stat
    let atkPoke = attacker;
    let atkKey = category === 'Physical' ? 'atk' : 'spa';
    if (move.overrideOffensiveStat) atkKey = move.overrideOffensiveStat;
    if (move.overrideOffensivePokemon === 'target') atkPoke = defender;
    const defenderUnaware = defender.ability === 'unaware' && !this.ignoresAbility(attacker);
    let atkStat = atkPoke.getStat(atkKey, {
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

    let damage = Math.floor(Math.floor(Math.floor(2 * L / 5 + 2) * bp * atkStat / Math.max(1, defStat)) / 50) + 2;

    // spread move penalty in doubles
    if (spread !== 1) damage = Math.floor(damage * spread);

    // weather
    const w = this.effWeather();
    if (w === 'sun') {
      if (moveType === 'Fire') damage = Math.floor(damage * 1.5);
      if (moveType === 'Water') damage = Math.floor(damage * 0.5);
    } else if (w === 'rain') {
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
        const wkg = defender.species.weightkg;
        if (wkg >= 200) return 120; if (wkg >= 100) return 100; if (wkg >= 50) return 80;
        if (wkg >= 25) return 60; if (wkg >= 10) return 40; return 20;
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
    // Supreme Overlord: +10% per fainted ally
    if (attacker.ability === 'supremeoverlord') {
      const fainted = attacker.side.team.filter(p => p.fainted).length;
      if (fainted > 0) bp = Math.floor(bp * (1 + 0.1 * fainted));
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

  afterDamage(attacker, defender, move, eff, totalDamage, { zInfo, maxInfo } = {}) {
    const moveType = this.effectiveMoveType(attacker, move, { zInfo, maxInfo });

    // drain
    if (move.drain && totalDamage > 0) {
      let healed = totalDamage * move.drain[0] / move.drain[1] * (attacker.item === 'bigroot' ? 1.3 : 1);
      if (defender.ability === 'liquidooze') {
        this.applyDamage(attacker, healed, 'ability: Liquid Ooze');
      } else {
        const h = attacker.heal(healed);
        if (h > 0) this.log(`|-heal|${this.ref(attacker)}|${this.hpStr(attacker)}|[from] drain`);
      }
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
    // shell bell
    if (attacker.item === 'shellbell' && totalDamage > 0 && !attacker.fainted) {
      const h = attacker.heal(totalDamage / 8);
      if (h > 0) this.log(`|-heal|${this.ref(attacker)}|${this.hpStr(attacker)}|[from] item: Shell Bell`);
    }

    // secondary effects (sheer force cancels; covert cloak blocks)
    if (!defender.fainted && attacker.ability !== 'sheerforce' && totalDamage > 0 &&
        defender.item !== 'covertcloak') {
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
      // King's Rock / Razor Fang flinch on flinchless damaging moves
      if (['kingsrock', 'razorfang'].includes(attacker.item) &&
          !(move.secondaries || move.secondary) && !this.movedThisTurn(defender) &&
          defender.ability !== 'innerfocus' && this.chance(10)) {
        defender.volatiles.flinch = true;
      }
      // Poison Touch
      if (attacker.ability === 'poisontouch' && move.flags.contact && this.chance(30)) {
        if (!fx.statusBlocked(defender, 'psn', this, attacker)) {
          this.trySetStatus(defender, 'psn', attacker, 'ability: Poison Touch');
        }
      }
    }

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

    // fire move thaws target
    if (moveType === 'Fire' && defender.status === 'frz' && !defender.fainted) this.cureStatus(defender, 'thawed');
    if (move.flags.defrost && attacker.status === 'frz') this.cureStatus(attacker, 'thawed');

    // contact effects
    if (move.flags.contact && totalDamage > 0 && !maxInfo &&
        attacker.ability !== 'longreach' &&
        !(attacker.item === 'protectivepads' || attacker.item === 'punchingglove' && move.flags.punch)) {
      fx.contactEffects(this, attacker, defender);
    }

    // defender reactive items / abilities
    if (totalDamage > 0) fx.afterDamagedItem(this, defender, Object.assign({}, move, { type: moveType }), eff);

    // Aftermath / Innards Out on KO
    if (defender.fainted && totalDamage > 0) {
      if (defender.ability === 'aftermath' && move.flags.contact && !attacker.fainted && attacker.ability !== 'magicguard') {
        this.applyDamage(attacker, attacker.maxhp / 4, 'ability: Aftermath');
      }
      if (defender.ability === 'innardsout' && !attacker.fainted && attacker.ability !== 'magicguard') {
        this.applyDamage(attacker, totalDamage, 'ability: Innards Out');
      }
    }

    // faints
    if (defender.fainted) {
      this.checkFaint(defender);
      fx.afterKOEffects(this, attacker);
    }
    this.checkFaint(attacker);
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
    if (poke.ability === 'simple') {
      for (const k of Object.keys(b)) b[k] = b[k] * 2;
    }
    const fromFoe = source && source.side !== poke.side;
    if (fromFoe) {
      const blocksAll = ['clearbody', 'whitesmoke', 'fullmetalbody'].includes(poke.ability) ||
        poke.item === 'clearamulet';
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
    // White Herb: undo drops
    if (poke.item === 'whiteherb' && Object.values(poke.boosts).some(v => v < 0)) {
      for (const k of Object.keys(poke.boosts)) if (poke.boosts[k] < 0) poke.boosts[k] = 0;
      poke.item = ''; poke.itemKnockedOff = true;
      this.log(`|-enditem|${this.ref(poke)}|White Herb`);
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
    if (source && source !== poke && poke.ability === 'synchronize' &&
        ['brn', 'par', 'psn', 'tox'].includes(status)) {
      this.trySetStatus(source, status, poke, 'ability: Synchronize');
    }
    // Guts-likes care about status; Toxic Boost / Flare Boost handled in modifyStat
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
    const allActives = () => {
      const out = [];
      for (const side of this.sides) for (const p of side.aliveActives()) out.push(p);
      return out;
    };
    // weather countdown + damage
    if (this.weather) {
      this.weatherTurns--;
      if (this.weatherTurns <= 0) {
        this.log(`|-weather|none`);
        this.weather = '';
      } else {
        this.log(`|-weather|${WEATHER_NAMES[this.weather]}|[upkeep]`);
        if (this.effWeather() === 'sand') {
          for (const p of allActives()) {
            if (!p.hasType('Rock') && !p.hasType('Ground') && !p.hasType('Steel') &&
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
        for (const p of allActives()) {
          if (p.isGrounded(this)) {
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
    // Bad Dreams
    for (const p of allActives()) {
      if (p.ability === 'baddreams') {
        for (const foe of this.foesOf(p)) {
          if (foe.status === 'slp') this.applyDamage(foe, foe.maxhp / 8, 'ability: Bad Dreams');
        }
      }
    }
    // per-pokemon residuals
    for (const side of this.sides) {
      for (const p of side.actives) {
        if (!p || p.fainted) continue;
        // status damage
        if (p.status === 'brn') {
          this.applyDamage(p, p.maxhp / (p.ability === 'heatproof' ? 32 : 16), 'brn');
        } else if (p.status === 'psn') {
          if (p.ability !== 'poisonheal') this.applyDamage(p, p.maxhp / 8, 'psn');
        } else if (p.status === 'tox') {
          p.statusCounter++;
          if (p.ability !== 'poisonheal') this.applyDamage(p, p.maxhp * p.statusCounter / 16, 'psn');
        }
        if (p.fainted) continue;
        // leech seed
        if (p.volatiles.leechseed && p.ability !== 'magicguard') {
          const foe = this.foesOf(p)[0];
          const dealt = p.damage(p.maxhp / 8);
          this.log(`|-damage|${this.ref(p)}|${this.hpStr(p)}|[from] Leech Seed`);
          if (foe && !foe.fainted && dealt > 0) {
            if (p.ability === 'liquidooze') {
              this.applyDamage(foe, dealt, 'ability: Liquid Ooze');
            } else {
              const healed = foe.heal(dealt);
              if (healed > 0) this.log(`|-heal|${this.ref(foe)}|${this.hpStr(foe)}|[silent]`);
            }
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
        // clear single-turn volatiles; reset protect chain when not protecting
        delete p.volatiles.protect;
        delete p.volatiles.followme;
        delete p.volatiles.helpinghand;
        const protectIds = ['protect', 'detect', 'banefulbunker', 'spikyshield', 'silktrap'];
        const usedProtect = p.lastMove && protectIds.includes(p.lastMove) && this.movedSet.has(p);
        if (!usedProtect) p.protectCounter = 0;
        p.turnsOut++;
      }
    }
    this.checkWin();
  }
}

module.exports = { Battle, Side };
