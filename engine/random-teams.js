// Our own random-battle team generator: viable species, STAB + coverage +
// utility movesets from real learnset data, sensible items/EVs, and a chance
// at Mega Stones / Z-Crystals so every gimmick shows up in random battles.
const { Dex, toID, getLearnset, NATURES } = require('./data');

let speciesPool = null;
let megaStoneBySpecies = null;
let zCrystalByType = null;

const UTILITY_MOVES = [
  'swordsdance', 'nastyplot', 'calmmind', 'dragondance', 'bulkup', 'quiverdance',
  'shellsmash', 'agility', 'irondefense', 'curse',
  'stealthrock', 'spikes', 'toxicspikes', 'stickyweb',
  'recover', 'roost', 'slackoff', 'softboiled', 'moonlight', 'synthesis', 'morningsun',
  'shoreup', 'strengthsap', 'painsplit',
  'willowisp', 'thunderwave', 'toxic', 'spore', 'sleeppowder',
  'protect', 'substitute', 'leechseed', 'defog', 'rapidspin',
  'uturn', 'voltswitch', 'partingshot',
];

const GOOD_ABILITIES = [
  'intimidate', 'levitate', 'hugepower', 'purepower', 'speedboost', 'guts', 'technician',
  'adaptability', 'sturdy', 'multiscale', 'regenerator', 'magicguard', 'unaware', 'prankster',
  'galewings', 'protean', 'libero', 'toughclaws', 'strongjaw', 'sheerforce', 'serenegrace',
  'skilllink', 'pixilate', 'aerilate', 'refrigerate', 'galvanize', 'moxie', 'beastboost',
  'contrary', 'drought', 'drizzle', 'sandstream', 'snowwarning', 'chlorophyll', 'swiftswim',
  'sandrush', 'slushrush', 'thickfat', 'flashfire', 'waterabsorb', 'voltabsorb', 'roughskin',
  'ironbarbs', 'poisonheal', 'magicbounce', 'sharpness', 'goodasgold', 'wellbakedbody',
];

function buildPools() {
  if (speciesPool) return;
  speciesPool = [];
  for (const s of Dex.species.all()) {
    if (s.num <= 0) continue;                               // no CAP/fakes
    if (s.nfe) continue;
    if (s.isMega || s.isPrimal) continue;
    if (s.battleOnly) continue;
    if (s.name.endsWith('-Gmax')) continue;
    if (['Totem', 'Alola-Totem'].some(f => s.forme && s.forme.includes('Totem'))) continue;
    const bst = Object.values(s.baseStats).reduce((a, b) => a + b, 0);
    if (bst < 450 || bst > 630) continue;
    speciesPool.push(s);
  }
  megaStoneBySpecies = {};
  zCrystalByType = {};
  for (const it of Dex.items.all()) {
    if (it.megaStone && it.megaEvolves) megaStoneBySpecies[it.megaEvolves] = it.id;
    else if (it.megaStone) {
      for (const base of Object.keys(it.megaStone)) megaStoneBySpecies[base] = it.id;
    }
    if (it.zMove === true && it.zMoveType) zCrystalByType[it.zMoveType] = it.id;
  }
}

function pick(arr, rng = Math.random) { return arr[Math.floor(rng() * arr.length)]; }

function usableAttack(move) {
  if (!move || !move.exists || move.category === 'Status') return false;
  if (move.basePower < 50) return false;
  if (typeof move.accuracy === 'number' && move.accuracy < 70) return false;
  if (move.flags.charge || move.flags.recharge) return false;
  if (move.self && move.self.volatileStatus === 'mustrecharge') return false;
  if (move.selfdestruct) return false;
  if (['lastresort', 'dreameater', 'synchronoise', 'beatup', 'fling', 'snore'].includes(move.id)) return false;
  return true;
}

async function buildSet(species) {
  let learnsetData = await getLearnset(species.id);
  if (!learnsetData) {
    const base = Dex.species.get(species.baseSpecies);
    learnsetData = await getLearnset(base.id) || {};
  }
  // include pre-evolution learnsets
  let prevo = species.prevo;
  const moveIds = new Set(Object.keys(learnsetData));
  while (prevo) {
    const ps = Dex.species.get(prevo);
    const pl = await getLearnset(ps.id);
    if (pl) for (const id of Object.keys(pl)) moveIds.add(id);
    prevo = ps.prevo;
  }

  const all = [...moveIds].map(id => Dex.moves.get(id)).filter(m => m && m.exists);
  const attacks = all.filter(usableAttack);
  const stats = species.baseStats;
  const physical = stats.atk >= stats.spa;

  const byPower = (a, b) => scoreAttack(b) - scoreAttack(a);
  function scoreAttack(m) {
    let s = m.basePower;
    if ((physical && m.category === 'Physical') || (!physical && m.category === 'Special')) s += 25;
    if (typeof m.accuracy === 'number') s -= (100 - m.accuracy) * 0.5;
    if (m.recoil) s -= 10;
    if (m.basePower > 120) s -= 15; // avoid gimmicky nukes
    return s + Math.random() * 14;
  }

  const moves = [];
  const used = new Set();
  const add = (m) => { if (m && !used.has(m.id) && moves.length < 4) { moves.push(m.name); used.add(m.id); } };

  // STAB for each type
  for (const type of species.types) {
    const stab = attacks.filter(m => m.type === type).sort(byPower)[0];
    add(stab);
  }
  // coverage
  const coverage = attacks.filter(m => !species.types.includes(m.type) && !used.has(m.id)).sort(byPower);
  add(coverage[0]);
  // utility
  const utilities = all.filter(m => UTILITY_MOVES.includes(m.id) && !used.has(m.id));
  if (utilities.length && moves.length < 4) add(pick(utilities));
  // fill with more coverage
  let ci = 1;
  while (moves.length < 4 && ci < coverage.length) add(coverage[ci++]);
  while (moves.length < 4 && attacks.length) {
    const extra = attacks.filter(m => !used.has(m.id)).sort(byPower)[0];
    if (!extra) break;
    add(extra);
  }
  if (moves.length === 0) moves.push('Tackle');

  // ability
  const abilities = Object.values(species.abilities).filter(Boolean);
  const good = abilities.filter(a => GOOD_ABILITIES.includes(toID(a)));
  const ability = good.length ? pick(good) : pick(abilities);

  // item (with gimmick spice)
  let item;
  const megaStone = megaStoneBySpecies[species.name];
  if (megaStone && Math.random() < 0.5) {
    item = megaStone;
  } else if (Math.random() < 0.15) {
    const zType = pick(moves.map(n => Dex.moves.get(n)).filter(m => m.category !== 'Status').map(m => m.type));
    item = zType ? zCrystalByType[zType] : null;
  }
  if (!item) {
    const fast = stats.spe >= 95;
    const bulky = stats.hp + stats.def + stats.spd >= 250;
    const options = [];
    if (fast) options.push('lifeorb', physical ? 'choiceband' : 'choicespecs', 'focussash');
    else options.push('choicescarf', 'leftovers', 'assaultvest');
    if (bulky) options.push('leftovers', 'leftovers', 'heavydutyboots', 'rockyhelmet');
    options.push('heavydutyboots', 'leftovers');
    item = pick(options);
  }

  // EVs / nature
  const evs = { hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0 };
  const atkStat = physical ? 'atk' : 'spa';
  evs[atkStat] = 252;
  if (stats.spe >= 70) { evs.spe = 252; evs.hp = 4; }
  else { evs.hp = 252; evs[stats.def >= stats.spd ? 'def' : 'spd'] = 4; }
  let nature;
  if (evs.spe === 252) nature = physical ? 'Jolly' : 'Timid';
  else nature = physical ? 'Adamant' : 'Modest';
  const ivs = { hp: 31, atk: physical ? 31 : 0, def: 31, spa: 31, spd: 31, spe: 31 };

  // tera type: STAB or coverage
  const teraOptions = [...species.types];
  for (const n of moves) {
    const m = Dex.moves.get(n);
    if (m && m.category !== 'Status') teraOptions.push(m.type);
  }
  const teraType = pick(teraOptions);

  // level by power budget
  const bst = Object.values(stats).reduce((a, b) => a + b, 0);
  const level = bst >= 600 ? 78 : bst >= 550 ? 82 : bst >= 500 ? 86 : 90;

  return {
    species: species.name, level, ability, item, nature, evs, ivs, moves, teraType,
    gender: species.gender || (Math.random() < 0.5 ? 'M' : 'F'),
    shiny: Math.random() < 1 / 64,
  };
}

async function generateRandomTeam() {
  buildPools();
  const team = [];
  const chosen = new Set();
  let guard = 0;
  while (team.length < 6 && guard++ < 200) {
    const species = pick(speciesPool);
    if (chosen.has(species.baseSpecies)) continue;
    try {
      const set = await buildSet(species);
      if (set.moves.length < 3) continue;
      chosen.add(species.baseSpecies);
      team.push(set);
    } catch { /* skip species with bad data */ }
  }
  return team;
}

module.exports = { generateRandomTeam };
