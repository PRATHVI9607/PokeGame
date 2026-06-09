// Pokemon battle-state class. Stat formulas implemented from the well-known
// HP / stat equations; everything here is our own logic.
const { toID, NATURES, getSpecies, getMove } = require('./data');

const STAT_KEYS = ['hp', 'atk', 'def', 'spa', 'spd', 'spe'];

class Pokemon {
  /**
   * set: { species, name?, level?, gender?, shiny?, ability, item, nature,
   *        evs: {hp..spe}, ivs: {hp..spe}, moves: [names], teraType? }
   */
  constructor(set, side, slot) {
    const species = getSpecies(set.species);
    if (!species) throw new Error(`Unknown species: ${set.species}`);
    this.side = side;
    this.slot = slot;
    this.set = set;
    this.species = species;
    this.baseSpecies = species;       // pre-Mega forme
    this.name = set.name || species.name;
    this.level = set.level || 100;
    this.gender = set.gender || (species.gender ?? (Math.random() < 0.5 ? 'M' : 'F'));
    this.shiny = !!set.shiny;
    this.ability = toID(set.ability || species.abilities['0']);
    this.baseAbility = this.ability;
    this.item = toID(set.item || '');
    this.nature = set.nature && NATURES[set.nature] ? set.nature : 'Serious';
    this.evs = Object.assign({ hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0 }, set.evs);
    this.ivs = Object.assign({ hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31 }, set.ivs);
    this.teraType = set.teraType || species.types[0];

    this.moves = (set.moves || []).map(m => {
      const move = getMove(m);
      if (!move) throw new Error(`Unknown move: ${m} on ${species.name}`);
      return { id: move.id, name: move.name, pp: Math.floor(move.pp * 8 / 5), maxpp: Math.floor(move.pp * 8 / 5) };
    });

    this.types = species.types.slice();
    this.originalTypes = species.types.slice();

    this.computeStats();
    this.hp = this.maxhp;
    this.status = '';            // '', 'brn', 'par', 'slp', 'psn', 'tox', 'frz'
    this.statusCounter = 0;      // sleep turns / toxic counter
    this.boosts = { atk: 0, def: 0, spa: 0, spd: 0, spe: 0, accuracy: 0, evasion: 0 };
    this.volatiles = {};         // confusion, flinch, protect, substitute, leechseed, ...
    this.fainted = false;
    this.active = false;
    this.lastMove = null;        // for choice lock / Encore-likes
    this.protectCounter = 0;
    this.timesAttacked = 0;
    this.turnsOut = 0;           // turns since switch-in (Fake Out)

    // gimmick state
    this.terastallized = false;
    this.mega = false;
    this.dynamaxed = false;
    this.dynamaxTurns = 0;
    this.itemKnockedOff = false;
  }

  computeStats() {
    const b = this.species.baseStats;
    const L = this.level;
    this.stats = {};
    for (const s of STAT_KEYS) {
      if (s === 'hp') {
        this.stats.hp = b.hp === 1 ? 1 // Shedinja
          : Math.floor((2 * b.hp + this.ivs.hp + Math.floor(this.evs.hp / 4)) * L / 100) + L + 10;
      } else {
        let v = Math.floor((2 * b[s] + this.ivs[s] + Math.floor(this.evs[s] / 4)) * L / 100) + 5;
        const nat = NATURES[this.nature];
        if (nat.plus === s) v = Math.floor(v * 1.1);
        if (nat.minus === s) v = Math.floor(v * 0.9);
        this.stats[s] = v;
      }
    }
    this.maxhp = this.stats.hp * (this.dynamaxed ? 2 : 1);
  }

  boostMult(stage) {
    return stage >= 0 ? (2 + stage) / 2 : 2 / (2 - stage);
  }

  getStat(stat, { ignoreBoost = false, ignorePositive = false, ignoreNegative = false } = {}) {
    let v = this.stats[stat];
    let stage = this.boosts[stat] || 0;
    if (ignoreBoost) stage = 0;
    if (ignorePositive && stage > 0) stage = 0;
    if (ignoreNegative && stage < 0) stage = 0;
    return Math.floor(v * this.boostMult(stage));
  }

  applyBoosts(boosts) {
    // returns {stat: actualChange}
    const applied = {};
    for (const [stat, n] of Object.entries(boosts)) {
      const before = this.boosts[stat] || 0;
      const after = Math.max(-6, Math.min(6, before + n));
      if (after !== before) applied[stat] = after - before;
      this.boosts[stat] = after;
    }
    return applied;
  }

  hasType(type) { return this.types.includes(type); }

  isGrounded(battle) {
    if (this.volatiles.smackdown) return true;
    if (this.item === 'ironball') return true;
    if (this.hasType('Flying')) return false;
    if (this.ability === 'levitate') return false;
    if (this.item === 'airballoon' && !this.itemKnockedOff) return false;
    return true;
  }

  damage(amount) {
    amount = Math.max(1, Math.floor(amount));
    const dealt = Math.min(this.hp, amount);
    this.hp -= dealt;
    if (this.hp <= 0) { this.hp = 0; this.fainted = true; }
    return dealt;
  }

  heal(amount) {
    if (this.fainted) return 0;
    amount = Math.max(1, Math.floor(amount));
    const healed = Math.min(this.maxhp - this.hp, amount);
    this.hp += healed;
    return healed;
  }

  hpPercent() { return Math.max(0, Math.ceil(this.hp / this.maxhp * 100)); }

  details() {
    let d = this.species.name;
    if (this.level !== 100) d += `, L${this.level}`;
    if (this.gender === 'M' || this.gender === 'F') d += `, ${this.gender}`;
    if (this.shiny) d += ', shiny';
    if (this.terastallized) d += `, tera:${this.teraType}`;
    return d;
  }

  clearVolatilesOnSwitch() {
    const keepTox = this.status === 'tox';
    this.boosts = { atk: 0, def: 0, spa: 0, spd: 0, spe: 0, accuracy: 0, evasion: 0 };
    this.volatiles = {};
    this.lastMove = null;
    this.protectCounter = 0;
    this.turnsOut = 0;
    if (keepTox) this.statusCounter = 0; // toxic counter resets on switch
    // Natural Cure
    if (this.ability === 'naturalcure' && this.status) { this.status = ''; this.statusCounter = 0; }
    // Regenerator
    if (this.ability === 'regenerator' && !this.fainted) this.heal(Math.floor(this.maxhp / 3));
    // Dynamax ends on switch
    if (this.dynamaxed) this.endDynamax();
    // types revert if not tera (e.g. soak-like effects don't persist anyway)
    if (!this.terastallized) this.types = this.originalTypes.slice();
  }

  endDynamax() {
    if (!this.dynamaxed) return;
    this.dynamaxed = false;
    this.dynamaxTurns = 0;
    this.hp = Math.max(1, Math.ceil(this.hp / 2));
    this.maxhp = this.stats.hp;
    if (this.hp > this.maxhp) this.hp = this.maxhp;
  }

  effectiveAbility() {
    // abilities suppressed while dynamaxed? (no - keep) ; gastro acid not implemented
    return this.ability;
  }
}

module.exports = { Pokemon, STAT_KEYS };
