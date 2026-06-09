// The four battle gimmicks. Each side may use each gimmick once per battle.
const { toID, getSpecies, getItem, Z_MOVES, zPower, MAX_MOVES, maxMovePower } = require('./data');

// ---- Terastallization ----
function canTera(poke, side) {
  return !side.usedGimmicks.tera && !poke.terastallized && !poke.dynamaxed;
}
function doTera(battle, poke) {
  poke.terastallized = true;
  poke.side.usedGimmicks.tera = true;
  poke.types = [poke.teraType];
  battle.log(`|-terastallize|${battle.ref(poke)}|${poke.teraType}`);
}
// STAB with tera rules: tera type matching an original type stacks to x2,
// tera-only gets x1.5, original-type STAB is kept at x1.5.
function stabMultiplier(poke, moveType) {
  const adapt = poke.ability === 'adaptability';
  if (poke.terastallized) {
    const teraMatch = moveType === poke.teraType;
    const origMatch = poke.originalTypes.includes(moveType);
    if (teraMatch && origMatch) return adapt ? 2.25 : 2;
    if (teraMatch || origMatch) return adapt ? 2 : 1.5;
    return 1;
  }
  if (poke.originalTypes.includes(moveType)) return adapt ? 2 : 1.5;
  return 1;
}

// ---- Mega Evolution ----
function megaFormeFor(poke) {
  if (poke.mega || poke.terastallized || poke.dynamaxed) return null;
  const item = getItem(poke.item);
  if (!item || !item.megaStone) return null;
  const megaName = item.megaStone[poke.baseSpecies.name];
  return megaName || null;
}
function canMega(poke, side) {
  return !side.usedGimmicks.mega && !!megaFormeFor(poke);
}
function doMega(battle, poke) {
  const megaName = megaFormeFor(poke);
  if (!megaName) return false;
  const megaSpecies = getSpecies(megaName);
  if (!megaSpecies) return false;
  poke.side.usedGimmicks.mega = true;
  poke.mega = true;
  poke.species = megaSpecies;
  poke.types = megaSpecies.types.slice();
  poke.originalTypes = megaSpecies.types.slice();
  poke.ability = toID(megaSpecies.abilities['0']);
  const hpFrac = poke.hp / poke.maxhp;
  const oldMax = poke.maxhp;
  poke.computeStats();
  // HP base stat never changes on mega, but recompute defensively
  if (poke.maxhp !== oldMax) poke.hp = Math.max(1, Math.round(hpFrac * poke.maxhp));
  battle.log(`|-mega|${battle.ref(poke)}|${megaName}|${poke.item}`);
  battle.log(`|detailschange|${battle.ref(poke)}|${poke.details()}`);
  return true;
}

// ---- Z-Moves ----
function zMoveFor(poke, moveSlot) {
  const item = getItem(poke.item);
  if (!item || !item.zMove) return null;
  const move = require('./data').getMove(moveSlot.id);
  if (!move || move.category === 'Status') return null;
  if (item.zMoveType && move.type === item.zMoveType) {
    return { name: Z_MOVES[move.type], type: move.type, basePower: zPower(move.basePower), category: move.category, baseMove: move.id };
  }
  return null;
}
function canZMove(poke, side) {
  if (side.usedGimmicks.zmove || poke.dynamaxed) return false;
  return poke.moves.some(m => zMoveFor(poke, m));
}

// ---- Dynamax ----
function canDynamax(poke, side) {
  return !side.usedGimmicks.dynamax && !poke.terastallized && !poke.mega &&
    !getItem(poke.item)?.zMove && !poke.dynamaxed;
}
function doDynamax(battle, poke) {
  poke.side.usedGimmicks.dynamax = true;
  poke.dynamaxed = true;
  poke.dynamaxTurns = 3;
  const frac = poke.hp / poke.maxhp;
  poke.maxhp = poke.stats.hp * 2;
  poke.hp = Math.max(1, Math.round(frac * poke.maxhp));
  battle.log(`|-dynamax|${battle.ref(poke)}`);
  battle.log(`|-damage|${battle.ref(poke)}|${battle.hpStr(poke)}|[silent]`); // sync HP bar
}
function maxMoveFor(move) {
  if (move.category === 'Status') {
    return { name: 'Max Guard', type: 'Normal', category: 'Status', basePower: 0, isMaxGuard: true };
  }
  const entry = MAX_MOVES[move.type] || MAX_MOVES.Normal;
  return {
    name: entry.name, type: move.type, category: move.category,
    basePower: maxMovePower(move.basePower),
    selfBoost: entry.selfBoost, foeBoost: entry.foeBoost,
    weather: entry.weather, terrain: entry.terrain,
  };
}

module.exports = {
  canTera, doTera, stabMultiplier,
  canMega, doMega, megaFormeFor,
  canZMove, zMoveFor,
  canDynamax, doDynamax, maxMoveFor,
};
