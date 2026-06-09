// Server-side team validation for custom teams.
const { Dex, toID, NATURES, getLearnset } = require('../engine/data');

async function learnableMoves(speciesId) {
  const ids = new Set();
  let species = Dex.species.get(speciesId);
  if (!species || !species.exists) return ids;
  let cur = species;
  let guard = 0;
  while (cur && guard++ < 8) {
    const ls = await getLearnset(cur.id);
    if (ls) for (const id of Object.keys(ls)) ids.add(id);
    if (!ls && cur.baseSpecies && toID(cur.baseSpecies) !== cur.id) {
      const base = Dex.species.get(cur.baseSpecies);
      const bls = await getLearnset(base.id);
      if (bls) for (const id of Object.keys(bls)) ids.add(id);
    }
    cur = cur.prevo ? Dex.species.get(cur.prevo) : null;
  }
  return ids;
}

async function validateTeam(sets) {
  const errors = [];
  if (!Array.isArray(sets) || sets.length < 1 || sets.length > 6) {
    return { ok: false, errors: ['A team needs 1-6 Pokemon'] };
  }
  for (const [i, set] of sets.entries()) {
    const label = set && set.species ? set.species : `slot ${i + 1}`;
    if (!set || typeof set !== 'object') { errors.push(`Slot ${i + 1}: invalid set`); continue; }
    const species = Dex.species.get(set.species || '');
    if (!species || !species.exists || species.num <= 0) { errors.push(`${label}: unknown species`); continue; }
    if (species.isMega || species.name.endsWith('-Gmax')) { errors.push(`${label}: pick the base forme (megas happen in battle)`); continue; }
    if (!Array.isArray(set.moves) || set.moves.length < 1 || set.moves.length > 4) {
      errors.push(`${label}: needs 1-4 moves`); continue;
    }
    const legal = await learnableMoves(species.id);
    for (const mv of set.moves) {
      const move = Dex.moves.get(mv);
      if (!move || !move.exists) { errors.push(`${label}: unknown move "${mv}"`); continue; }
      if (legal.size && !legal.has(move.id)) errors.push(`${label}: can't learn ${move.name}`);
    }
    if (set.ability) {
      const ab = Dex.abilities.get(set.ability);
      if (!ab || !ab.exists) errors.push(`${label}: unknown ability "${set.ability}"`);
      else {
        const allowed = Object.values(species.abilities).map(toID);
        if (!allowed.includes(ab.id)) errors.push(`${label}: ${ab.name} is not one of its abilities`);
      }
    }
    if (set.item) {
      const it = Dex.items.get(set.item);
      if (!it || !it.exists) errors.push(`${label}: unknown item "${set.item}"`);
    }
    if (set.nature && !NATURES[set.nature]) errors.push(`${label}: unknown nature`);
    if (set.evs) {
      const vals = Object.values(set.evs).map(v => +v || 0);
      if (vals.some(v => v < 0 || v > 252)) errors.push(`${label}: EVs must be 0-252`);
      if (vals.reduce((a, b) => a + b, 0) > 510) errors.push(`${label}: EV total over 510`);
    }
    if (set.level && (set.level < 1 || set.level > 100)) errors.push(`${label}: bad level`);
  }
  // duplicate species (species clause)
  const names = sets.map(s => s && Dex.species.get(s.species || '')?.baseSpecies).filter(Boolean);
  if (new Set(names).size !== names.length) errors.push('Duplicate species are not allowed');
  return { ok: errors.length === 0, errors };
}

module.exports = { validateTeam };
