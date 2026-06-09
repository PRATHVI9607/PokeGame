// Data layer for the custom engine. The type chart, natures, Z-move and Max-move
// tables are ours; species/move/item/ability/learnset tables are read from
// @pkmn/dex (data only - no simulation logic is imported).
const { Dex } = require('@pkmn/dex');

const toID = (s) => ('' + (s || '')).toLowerCase().replace(/[^a-z0-9]/g, '');

// Attacking type -> defending type -> multiplier (entries of 1 omitted).
const TYPE_CHART = {
  Normal:   { Rock: 0.5, Ghost: 0, Steel: 0.5 },
  Fire:     { Fire: 0.5, Water: 0.5, Grass: 2, Ice: 2, Bug: 2, Rock: 0.5, Dragon: 0.5, Steel: 2 },
  Water:    { Fire: 2, Water: 0.5, Grass: 0.5, Ground: 2, Rock: 2, Dragon: 0.5 },
  Electric: { Water: 2, Electric: 0.5, Grass: 0.5, Ground: 0, Flying: 2, Dragon: 0.5 },
  Grass:    { Fire: 0.5, Water: 2, Grass: 0.5, Poison: 0.5, Ground: 2, Flying: 0.5, Bug: 0.5, Rock: 2, Dragon: 0.5, Steel: 0.5 },
  Ice:      { Fire: 0.5, Water: 0.5, Grass: 2, Ice: 0.5, Ground: 2, Flying: 2, Dragon: 2, Steel: 0.5 },
  Fighting: { Normal: 2, Ice: 2, Poison: 0.5, Flying: 0.5, Psychic: 0.5, Bug: 0.5, Rock: 2, Ghost: 0, Dark: 2, Steel: 2, Fairy: 0.5 },
  Poison:   { Grass: 2, Poison: 0.5, Ground: 0.5, Rock: 0.5, Ghost: 0.5, Steel: 0, Fairy: 2 },
  Ground:   { Fire: 2, Electric: 2, Grass: 0.5, Poison: 2, Flying: 0, Bug: 0.5, Rock: 2, Steel: 2 },
  Flying:   { Electric: 0.5, Grass: 2, Fighting: 2, Bug: 2, Rock: 0.5, Steel: 0.5 },
  Psychic:  { Fighting: 2, Poison: 2, Psychic: 0.5, Dark: 0, Steel: 0.5 },
  Bug:      { Fire: 0.5, Grass: 2, Fighting: 0.5, Poison: 0.5, Flying: 0.5, Psychic: 2, Ghost: 0.5, Dark: 2, Steel: 0.5, Fairy: 0.5 },
  Rock:     { Fire: 2, Ice: 2, Fighting: 0.5, Ground: 0.5, Flying: 2, Bug: 2, Steel: 0.5 },
  Ghost:    { Normal: 0, Psychic: 2, Ghost: 2, Dark: 0.5 },
  Dragon:   { Dragon: 2, Steel: 0.5, Fairy: 0 },
  Dark:     { Fighting: 0.5, Psychic: 2, Ghost: 2, Dark: 0.5, Fairy: 0.5 },
  Steel:    { Fire: 0.5, Water: 0.5, Electric: 0.5, Ice: 2, Rock: 2, Steel: 0.5, Fairy: 2 },
  Fairy:    { Fire: 0.5, Fighting: 2, Poison: 0.5, Dragon: 2, Dark: 2, Steel: 0.5 },
};
const TYPES = Object.keys(TYPE_CHART);

function typeEffect(moveType, defenderTypes) {
  let mult = 1;
  for (const t of defenderTypes) {
    const row = TYPE_CHART[moveType];
    if (row && row[t] !== undefined) mult *= row[t];
  }
  return mult;
}

const NATURES = {
  Adamant: { plus: 'atk', minus: 'spa' }, Bashful: {}, Bold: { plus: 'def', minus: 'atk' },
  Brave: { plus: 'atk', minus: 'spe' }, Calm: { plus: 'spd', minus: 'atk' }, Careful: { plus: 'spd', minus: 'spa' },
  Docile: {}, Gentle: { plus: 'spd', minus: 'def' }, Hardy: {}, Hasty: { plus: 'spe', minus: 'def' },
  Impish: { plus: 'def', minus: 'spa' }, Jolly: { plus: 'spe', minus: 'spa' }, Lax: { plus: 'def', minus: 'spd' },
  Lonely: { plus: 'atk', minus: 'def' }, Mild: { plus: 'spa', minus: 'def' }, Modest: { plus: 'spa', minus: 'atk' },
  Naive: { plus: 'spe', minus: 'spd' }, Naughty: { plus: 'atk', minus: 'spd' }, Quiet: { plus: 'spa', minus: 'spe' },
  Quirky: {}, Rash: { plus: 'spa', minus: 'spd' }, Relaxed: { plus: 'def', minus: 'spe' },
  Sassy: { plus: 'spd', minus: 'spe' }, Serious: {}, Timid: { plus: 'spe', minus: 'atk' },
};

// Z-move name per type and the official base-power conversion table.
const Z_MOVES = {
  Normal: 'Breakneck Blitz', Fighting: 'All-Out Pummeling', Flying: 'Supersonic Skystrike',
  Poison: 'Acid Downpour', Ground: 'Tectonic Rage', Rock: 'Continental Crush',
  Bug: 'Savage Spin-Out', Ghost: 'Never-Ending Nightmare', Steel: 'Corkscrew Crash',
  Fire: 'Inferno Overdrive', Water: 'Hydro Vortex', Grass: 'Bloom Doom',
  Electric: 'Gigavolt Havoc', Psychic: 'Shattered Psyche', Ice: 'Subzero Slammer',
  Dragon: 'Devastating Drake', Dark: 'Black Hole Eclipse', Fairy: 'Twinkle Tackle',
};
function zPower(bp) {
  if (bp >= 140) return 200;
  if (bp >= 130) return 195;
  if (bp >= 120) return 190;
  if (bp >= 110) return 185;
  if (bp >= 100) return 180;
  if (bp >= 90) return 175;
  if (bp >= 80) return 160;
  if (bp >= 70) return 140;
  if (bp >= 60) return 120;
  return 100;
}

// Max move per type: name + effect applied on hit.
const MAX_MOVES = {
  Normal:   { name: 'Max Strike',     foeBoost: { spe: -1 } },
  Fire:     { name: 'Max Flare',      weather: 'sun' },
  Water:    { name: 'Max Geyser',     weather: 'rain' },
  Grass:    { name: 'Max Overgrowth', terrain: 'grassy' },
  Electric: { name: 'Max Lightning',  terrain: 'electric' },
  Psychic:  { name: 'Max Mindstorm',  terrain: 'psychic' },
  Fairy:    { name: 'Max Starfall',   terrain: 'misty' },
  Rock:     { name: 'Max Rockfall',   weather: 'sand' },
  Ice:      { name: 'Max Hailstorm',  weather: 'snow' },
  Flying:   { name: 'Max Airstream',  selfBoost: { spe: 1 } },
  Fighting: { name: 'Max Knuckle',    selfBoost: { atk: 1 } },
  Poison:   { name: 'Max Ooze',       selfBoost: { spa: 1 } },
  Steel:    { name: 'Max Steelspike', selfBoost: { def: 1 } },
  Ground:   { name: 'Max Quake',      selfBoost: { spd: 1 } },
  Dragon:   { name: 'Max Wyrmwind',   foeBoost: { atk: -1 } },
  Ghost:    { name: 'Max Phantasm',   foeBoost: { def: -1 } },
  Dark:     { name: 'Max Darkness',   foeBoost: { spd: -1 } },
  Bug:      { name: 'Max Flutterby',  foeBoost: { spa: -1 } },
};
function maxMovePower(bp) {
  if (bp >= 140) return 140;
  if (bp >= 110) return 130;
  if (bp >= 100) return 120;
  if (bp >= 90)  return 110;
  if (bp >= 70)  return 100;
  if (bp >= 50)  return 90;
  return 80;
}

const getSpecies = (name) => {
  const s = Dex.species.get(name);
  return s && s.exists ? s : null;
};
const getMove = (name) => {
  const m = Dex.moves.get(name);
  return m && m.exists ? m : null;
};
const getItem = (name) => {
  const i = Dex.items.get(name);
  return i && i.exists ? i : null;
};
const getAbility = (name) => {
  const a = Dex.abilities.get(name);
  return a && a.exists ? a : null;
};
const getLearnset = async (name) => {
  const l = await Dex.learnsets.get(name);
  return l && l.learnset ? l.learnset : null;
};

module.exports = {
  Dex, toID, TYPES, TYPE_CHART, typeEffect, NATURES,
  Z_MOVES, zPower, MAX_MOVES, maxMovePower,
  getSpecies, getMove, getItem, getAbility, getLearnset,
};
