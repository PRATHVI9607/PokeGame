// Ability + item effect handlers, called from hook points in battle.js.
// Unimplemented abilities/items simply have no effect.

// ---- switch-in effects (weather setters, Intimidate, etc.) ----
function onSwitchInEffects(battle, poke) {
  const foe = battle.foeActive(poke);
  switch (poke.ability) {
    case 'intimidate':
      if (foe && !foe.fainted) {
        battle.log(`|-ability|${battle.ref(poke)}|Intimidate`);
        const blockers = ['clearbody', 'whitesmoke', 'fullmetalbody', 'hypercutter', 'innerfocus', 'oblivious', 'owntempo', 'scrappy', 'guarddog'];
        if (blockers.includes(foe.ability)) {
          battle.log(`|-fail|${battle.ref(foe)}`);
        } else {
          battle.boost(foe, { atk: -1 }, poke);
          if (['defiant'].includes(foe.ability)) battle.boost(foe, { atk: 2 }, foe);
          if (['competitive'].includes(foe.ability)) battle.boost(foe, { spa: 2 }, foe);
        }
      }
      break;
    case 'drought': battle.setWeather('sun', poke); break;
    case 'drizzle': battle.setWeather('rain', poke); break;
    case 'sandstream': battle.setWeather('sand', poke); break;
    case 'snowwarning': battle.setWeather('snow', poke); break;
    case 'electricsurge': battle.setTerrain('electric', poke); break;
    case 'grassysurge': battle.setTerrain('grassy', poke); break;
    case 'psychicsurge': battle.setTerrain('psychic', poke); break;
    case 'mistysurge': battle.setTerrain('misty', poke); break;
    case 'download':
      if (foe && !foe.fainted) {
        const def = foe.getStat('def'), spd = foe.getStat('spd');
        battle.boost(poke, def < spd ? { atk: 1 } : { spa: 1 }, poke);
      }
      break;
    case 'dauntlessshield': battle.boost(poke, { def: 1 }, poke); break;
    case 'intrepidsword': battle.boost(poke, { atk: 1 }, poke); break;
  }
  if (poke.item === 'boosterenergy' && ['protosynthesis', 'quarkdrive'].includes(poke.ability)) {
    // simplified: boost highest stat 1.3x via volatile
    poke.volatiles.paradoxBoost = bestStat(poke);
    battle.log(`|-activate|${battle.ref(poke)}|Booster Energy`);
    poke.item = '';
  }
}

function bestStat(poke) {
  let best = 'atk', bv = 0;
  for (const s of ['atk', 'def', 'spa', 'spd', 'spe']) {
    if (poke.getStat(s) > bv) { bv = poke.getStat(s); best = s; }
  }
  return best;
}

// ---- stat modification (abilities + items + weather + status) ----
function modifyStat(stat, value, poke, battle) {
  const a = poke.ability, it = poke.item;
  const w = battle.weather, t = battle.terrain;
  switch (stat) {
    case 'atk':
      if (a === 'hugepower' || a === 'purepower') value *= 2;
      if (a === 'guts' && poke.status) value *= 1.5;
      if (a === 'hustle') value *= 1.5;
      if (a === 'gorillatactics') value *= 1.5;
      if (it === 'choiceband') value *= 1.5;
      if (poke.status === 'brn' && a !== 'guts') value *= 0.5;
      if (poke.volatiles.paradoxBoost === 'atk') value *= 1.3;
      if (a === 'flowergift' && w === 'sun') value *= 1.5;
      break;
    case 'spa':
      if (it === 'choicespecs') value *= 1.5;
      if (a === 'solarpower' && w === 'sun') value *= 1.5;
      if (poke.volatiles.paradoxBoost === 'spa') value *= 1.3;
      break;
    case 'def':
      if (it === 'eviolite' && poke.species.nfe) value *= 1.5;
      if (a === 'marvelscale' && poke.status) value *= 1.5;
      if (a === 'furcoat') value *= 2;
      if (a === 'grasspelt' && t === 'grassy') value *= 1.5;
      if (poke.volatiles.paradoxBoost === 'def') value *= 1.3;
      break;
    case 'spd':
      if (it === 'eviolite' && poke.species.nfe) value *= 1.5;
      if (it === 'assaultvest') value *= 1.5;
      if (w === 'sand' && poke.hasType('Rock')) value *= 1.5;
      if (poke.volatiles.paradoxBoost === 'spd') value *= 1.3;
      break;
    case 'spe':
      if (it === 'choicescarf') value *= 1.5;
      if (a === 'chlorophyll' && w === 'sun') value *= 2;
      if (a === 'swiftswim' && w === 'rain') value *= 2;
      if (a === 'sandrush' && w === 'sand') value *= 2;
      if (a === 'slushrush' && w === 'snow') value *= 2;
      if (a === 'surgesurfer' && t === 'electric') value *= 2;
      if (a === 'quickfeet' && poke.status) value *= 1.5;
      if (a === 'unburden' && poke.itemKnockedOff) value *= 2;
      if (poke.status === 'par' && a !== 'quickfeet') value *= 0.5;
      if (poke.volatiles.paradoxBoost === 'spe') value *= 1.5;
      if (poke.side.sideConditions.tailwind) value *= 2;
      break;
  }
  // snow def boost for ice types
  if (stat === 'def' && w === 'snow' && poke.hasType('Ice')) value *= 1.5;
  return Math.floor(value);
}

// ---- base power modification ----
function modifyBasePower(bp, move, attacker, defender, battle) {
  const a = attacker.ability, it = attacker.item;
  if (a === 'technician' && bp <= 60) bp *= 1.5;
  if (a === 'toughclaws' && move.flags.contact) bp *= 1.3;
  if (a === 'strongjaw' && move.flags.bite) bp *= 1.5;
  if (a === 'ironfist' && move.flags.punch) bp *= 1.2;
  if (a === 'sharpness' && move.flags.slicing) bp *= 1.5;
  if (a === 'megalauncher' && move.flags.pulse) bp *= 1.5;
  if (a === 'reckless' && (move.recoil || move.hasCrashDamage)) bp *= 1.2;
  if (a === 'sheerforce' && move.secondary) bp *= 1.3;
  if (a === 'analytic' && battle.movedThisTurn(defender)) bp *= 1.3;
  if ((a === 'transistor' && move.type === 'Electric')) bp *= 1.3;
  if ((a === 'dragonsmaw' && move.type === 'Dragon')) bp *= 1.5;
  if ((a === 'steelworker' || a === 'steelyspirit') && move.type === 'Steel') bp *= 1.5;
  if (a === 'waterbubble' && move.type === 'Water') bp *= 2;
  if (a === 'rockypayload' && move.type === 'Rock') bp *= 1.5;
  if (a === 'punkrock' && move.flags.sound) bp *= 1.3;
  // pinch abilities
  if (attacker.hp <= attacker.maxhp / 3) {
    if (a === 'overgrow' && move.type === 'Grass') bp *= 1.5;
    if (a === 'blaze' && move.type === 'Fire') bp *= 1.5;
    if (a === 'torrent' && move.type === 'Water') bp *= 1.5;
    if (a === 'swarm' && move.type === 'Bug') bp *= 1.5;
  }
  // items
  if (it === 'lifeorb') bp *= 1.3;
  if (it === 'expertbelt' && battle.lastEffectiveness > 1) bp *= 1.2;
  if (it === 'muscleband' && move.category === 'Physical') bp *= 1.1;
  if (it === 'wiseglasses' && move.category === 'Special') bp *= 1.1;
  const typeItems = {
    charcoal: 'Fire', mysticwater: 'Water', magnet: 'Electric', miracleseed: 'Grass',
    nevermeltice: 'Ice', blackbelt: 'Fighting', poisonbarb: 'Poison', softsand: 'Ground',
    sharpbeak: 'Flying', twistedspoon: 'Psychic', silverpowder: 'Bug', hardstone: 'Rock',
    spelltag: 'Ghost', dragonfang: 'Dragon', blackglasses: 'Dark', metalcoat: 'Steel',
    silkscarf: 'Normal', fairyfeather: 'Fairy',
  };
  if (typeItems[it] === move.type) bp *= 1.2;
  // terrain
  if (battle.terrain === 'electric' && move.type === 'Electric' && attacker.isGrounded(battle)) bp *= 1.3;
  if (battle.terrain === 'grassy' && move.type === 'Grass' && attacker.isGrounded(battle)) bp *= 1.3;
  if (battle.terrain === 'psychic' && move.type === 'Psychic' && attacker.isGrounded(battle)) bp *= 1.3;
  if (battle.terrain === 'misty' && move.type === 'Dragon' && defender.isGrounded(battle)) bp *= 0.5;
  if (battle.terrain === 'grassy' && ['earthquake', 'bulldoze', 'magnitude'].includes(move.id) && defender.isGrounded(battle)) bp *= 0.5;
  return bp;
}

// ---- type-based ability immunities / absorbs on the defender ----
function typeImmunityAbility(defender, moveType) {
  const a = defender.ability;
  if (a === 'levitate' && moveType === 'Ground') return { immune: true, msg: 'Levitate' };
  if (a === 'flashfire' && moveType === 'Fire') return { immune: true, msg: 'Flash Fire', volatile: 'flashfire' };
  if (a === 'waterabsorb' && moveType === 'Water') return { immune: true, msg: 'Water Absorb', heal: 0.25 };
  if (a === 'dryskin' && moveType === 'Water') return { immune: true, msg: 'Dry Skin', heal: 0.25 };
  if (a === 'voltabsorb' && moveType === 'Electric') return { immune: true, msg: 'Volt Absorb', heal: 0.25 };
  if (a === 'lightningrod' && moveType === 'Electric') return { immune: true, msg: 'Lightning Rod', boost: { spa: 1 } };
  if (a === 'motordrive' && moveType === 'Electric') return { immune: true, msg: 'Motor Drive', boost: { spe: 1 } };
  if (a === 'stormdrain' && moveType === 'Water') return { immune: true, msg: 'Storm Drain', boost: { spa: 1 } };
  if (a === 'sapsipper' && moveType === 'Grass') return { immune: true, msg: 'Sap Sipper', boost: { atk: 1 } };
  if (a === 'eartheater' && moveType === 'Ground') return { immune: true, msg: 'Earth Eater', heal: 0.25 };
  if (a === 'wellbakedbody' && moveType === 'Fire') return { immune: true, msg: 'Well-Baked Body', boost: { def: 2 } };
  return null;
}

// ---- final damage multiplier on the defender side ----
function damageTakenMult(defender, attacker, move, eff, battle) {
  let mult = 1;
  const a = defender.ability;
  if (battle.ignoresAbility(attacker)) return mult;
  if (a === 'multiscale' && defender.hp === defender.maxhp) mult *= 0.5;
  if (a === 'shadowshield' && defender.hp === defender.maxhp) mult *= 0.5;
  if ((a === 'filter' || a === 'solidrock' || a === 'prismarmor') && eff > 1) mult *= 0.75;
  if (a === 'thickfat' && (move.type === 'Fire' || move.type === 'Ice')) mult *= 0.5;
  if (a === 'icescales' && move.category === 'Special') mult *= 0.5;
  if (a === 'fluffy') {
    if (move.flags.contact) mult *= 0.5;
    if (move.type === 'Fire') mult *= 2;
  }
  if (a === 'heatproof' && move.type === 'Fire') mult *= 0.5;
  if (a === 'waterbubble' && move.type === 'Fire') mult *= 0.5;
  if (a === 'punkrock' && move.flags.sound) mult *= 0.5;
  return mult;
}

// attacker-side: tinted lens
function damageDealtMult(attacker, move, eff) {
  let mult = 1;
  if (attacker.ability === 'tintedlens' && eff < 1) mult *= 2;
  if (attacker.ability === 'neuroforce' && eff > 1) mult *= 1.25;
  return mult;
}

// ---- status application blockers ----
function statusBlocked(poke, status, battle, source) {
  const a = poke.ability;
  if (poke.status || poke.fainted) return true;
  if (battle.terrain === 'misty' && poke.isGrounded(battle)) return true;
  if (battle.terrain === 'electric' && status === 'slp' && poke.isGrounded(battle)) return true;
  if ((status === 'psn' || status === 'tox') &&
      (poke.hasType('Poison') || poke.hasType('Steel')) &&
      !(source && source.ability === 'corrosion')) return true;
  if (status === 'brn' && poke.hasType('Fire')) return true;
  if (status === 'par' && poke.hasType('Electric')) return true;
  if (status === 'frz' && poke.hasType('Ice')) return true;
  const blockMap = {
    brn: ['waterveil', 'waterbubble', 'thermalexchange'],
    par: ['limber'],
    slp: ['insomnia', 'vitalspirit', 'sweetveil'],
    frz: ['magmaarmor'],
    psn: ['immunity'], tox: ['immunity'],
  };
  if (blockMap[status] && blockMap[status].includes(a)) return true;
  if (a === 'comatose' || a === 'purifyingsalt' || a === 'shieldsdown') return true;
  if (a === 'leafguard' && battle.weather === 'sun') return true;
  if (a === 'flowerveil' && poke.hasType('Grass')) return true;
  return false;
}

// ---- end of turn ----
function residualEffects(battle, poke) {
  if (poke.fainted) return;
  const a = poke.ability, it = poke.item;
  if (a === 'speedboost' && poke.turnsOut > 0) battle.boost(poke, { spe: 1 }, poke);
  if (a === 'moody') {
    const up = battle.sample(['atk', 'def', 'spa', 'spd', 'spe']);
    let down = battle.sample(['atk', 'def', 'spa', 'spd', 'spe']);
    while (down === up) down = battle.sample(['atk', 'def', 'spa', 'spd', 'spe']);
    battle.boost(poke, { [up]: 2, [down]: -1 }, poke);
  }
  if (it === 'leftovers') {
    const healed = poke.heal(poke.maxhp / 16);
    if (healed > 0) battle.log(`|-heal|${battle.ref(poke)}|${battle.hpStr(poke)}|[from] item: Leftovers`);
  }
  if (it === 'blacksludge') {
    if (poke.hasType('Poison')) {
      const healed = poke.heal(poke.maxhp / 16);
      if (healed > 0) battle.log(`|-heal|${battle.ref(poke)}|${battle.hpStr(poke)}|[from] item: Black Sludge`);
    } else if (poke.ability !== 'magicguard') {
      battle.applyDamage(poke, poke.maxhp / 8, 'item: Black Sludge');
    }
  }
  if (it === 'flameorb' && !poke.status) battle.trySetStatus(poke, 'brn', poke, 'item: Flame Orb', true);
  if (it === 'toxicorb' && !poke.status) battle.trySetStatus(poke, 'tox', poke, 'item: Toxic Orb', true);
  if (a === 'poisonheal' && (poke.status === 'psn' || poke.status === 'tox')) {
    const healed = poke.heal(poke.maxhp / 8);
    if (healed > 0) battle.log(`|-heal|${battle.ref(poke)}|${battle.hpStr(poke)}|[from] ability: Poison Heal`);
  }
  if (a === 'hydration' && battle.weather === 'rain' && poke.status) {
    battle.cureStatus(poke, 'ability: Hydration');
  }
  if (a === 'raindish' && battle.weather === 'rain') {
    const healed = poke.heal(poke.maxhp / 16);
    if (healed > 0) battle.log(`|-heal|${battle.ref(poke)}|${battle.hpStr(poke)}|[from] ability: Rain Dish`);
  }
  if (a === 'icebody' && battle.weather === 'snow') {
    const healed = poke.heal(poke.maxhp / 16);
    if (healed > 0) battle.log(`|-heal|${battle.ref(poke)}|${battle.hpStr(poke)}|[from] ability: Ice Body`);
  }
  if (a === 'solarpower' && battle.weather === 'sun' && poke.ability !== 'magicguard') {
    battle.applyDamage(poke, poke.maxhp / 8, 'ability: Solar Power');
  }
}

// ---- contact punishment ----
function contactEffects(battle, attacker, defender) {
  if (attacker.fainted) return;
  const a = defender.ability;
  if (a === 'roughskin' || a === 'ironbarbs') {
    battle.applyDamage(attacker, attacker.maxhp / 8, `ability: ${a === 'roughskin' ? 'Rough Skin' : 'Iron Barbs'}`);
  }
  if (a === 'static' && battle.chance(30)) battle.trySetStatus(attacker, 'par', defender, 'ability: Static');
  if (a === 'flamebody' && battle.chance(30)) battle.trySetStatus(attacker, 'brn', defender, 'ability: Flame Body');
  if (a === 'poisonpoint' && battle.chance(30)) battle.trySetStatus(attacker, 'psn', defender, 'ability: Poison Point');
  if (a === 'effectspore' && battle.chance(30)) {
    battle.trySetStatus(attacker, battle.sample(['psn', 'par', 'slp']), defender, 'ability: Effect Spore');
  }
  if ((a === 'gooey' || a === 'tanglinghair') && !attacker.fainted) battle.boost(attacker, { spe: -1 }, defender);
  if (defender.item === 'rockyhelmet' && !attacker.fainted) {
    battle.applyDamage(attacker, attacker.maxhp / 6, 'item: Rocky Helmet');
  }
}

// ---- after scoring a KO ----
function afterKOEffects(battle, attacker) {
  if (attacker.fainted) return;
  const a = attacker.ability;
  if (a === 'moxie') battle.boost(attacker, { atk: 1 }, attacker);
  if (a === 'grimneigh') battle.boost(attacker, { spa: 1 }, attacker);
  if (a === 'chillingneigh') battle.boost(attacker, { atk: 1 }, attacker);
  if (a === 'beastboost') battle.boost(attacker, { [bestStat(attacker)]: 1 }, attacker);
  if (a === 'magician') { /* skip */ }
}

// ---- item reactions after taking a hit ----
function afterDamagedItem(battle, poke, move, eff) {
  if (poke.fainted) return;
  if (poke.item === 'weaknesspolicy' && eff > 1 && move.category !== 'Status') {
    battle.log(`|-activate|${battle.ref(poke)}|item: Weakness Policy`);
    battle.boost(poke, { atk: 2, spa: 2 }, poke);
    poke.item = ''; poke.itemKnockedOff = true;
  }
  if (poke.item === 'airballoon') {
    battle.log(`|-enditem|${battle.ref(poke)}|Air Balloon`);
    poke.item = ''; poke.itemKnockedOff = true;
  }
  checkBerry(battle, poke);
  if (poke.ability === 'angerpoint' && battle.lastWasCrit) battle.boost(poke, { atk: 12 }, poke);
  if (poke.ability === 'stamina') battle.boost(poke, { def: 1 }, poke);
  if (poke.ability === 'justified' && move.type === 'Dark') battle.boost(poke, { atk: 1 }, poke);
  if (poke.ability === 'rattled' && ['Dark', 'Bug', 'Ghost'].includes(move.type)) battle.boost(poke, { spe: 1 }, poke);
  if (poke.ability === 'berserk' && poke.hp < poke.maxhp / 2 && poke.hp + battle.lastDamageDealt >= poke.maxhp / 2) {
    battle.boost(poke, { spa: 1 }, poke);
  }
}

function checkBerry(battle, poke) {
  if (poke.fainted) return;
  const it = poke.item;
  const gluttony = poke.ability === 'gluttony' ? 0.5 : 0.25;
  if (it === 'sitrusberry' && poke.hp <= poke.maxhp / 2) {
    poke.item = '';
    const healed = poke.heal(poke.maxhp / 4);
    if (healed) battle.log(`|-heal|${battle.ref(poke)}|${battle.hpStr(poke)}|[from] item: Sitrus Berry`);
  }
  if (it === 'oranberry' && poke.hp <= poke.maxhp / 2) {
    poke.item = '';
    const healed = poke.heal(10);
    if (healed) battle.log(`|-heal|${battle.ref(poke)}|${battle.hpStr(poke)}|[from] item: Oran Berry`);
  }
  if ((it === 'figyberry' || it === 'wikiberry' || it === 'magoberry' || it === 'aguavberry' || it === 'iapapaberry') &&
      poke.hp <= poke.maxhp * gluttony) {
    poke.item = '';
    const healed = poke.heal(poke.maxhp / 3);
    if (healed) battle.log(`|-heal|${battle.ref(poke)}|${battle.hpStr(poke)}|[from] item: Berry`);
  }
}

// lum/chesto style cures, called right after a status lands
function checkStatusBerry(battle, poke) {
  const cures = {
    lumberry: 'any', chestoberry: 'slp', cheriberry: 'par', rawstberry: 'brn',
    pechaberry: 'psn', aspearberry: 'frz', persimberry: 'confusion',
  };
  const cure = cures[poke.item];
  if (!cure) return;
  if (cure === 'confusion') {
    if (poke.volatiles.confusion) {
      delete poke.volatiles.confusion;
      poke.item = '';
      battle.log(`|-enditem|${battle.ref(poke)}|Persim Berry`);
      battle.log(`|-end|${battle.ref(poke)}|confusion`);
    }
    return;
  }
  if (poke.status && (cure === 'any' || cure === poke.status || (cure === 'psn' && poke.status === 'tox'))) {
    poke.item = '';
    battle.log(`|-enditem|${battle.ref(poke)}|Berry`);
    battle.cureStatus(poke, 'berry');
    if (poke.item === '' && cure === 'any' && poke.volatiles.confusion) delete poke.volatiles.confusion;
  }
}

function critBlocked(defender) {
  return ['battlearmor', 'shellarmor'].includes(defender.ability);
}

function movePriorityMod(move, poke, battle) {
  let pri = move.priority;
  if (poke.ability === 'galewings' && move.type === 'Flying' && poke.hp === poke.maxhp) pri += 1;
  if (poke.ability === 'prankster' && move.category === 'Status') pri += 1;
  if (poke.ability === 'triage' && move.flags.heal) pri += 3;
  return pri;
}

module.exports = {
  onSwitchInEffects, modifyStat, modifyBasePower, typeImmunityAbility,
  damageTakenMult, damageDealtMult, statusBlocked, residualEffects,
  contactEffects, afterKOEffects, afterDamagedItem, checkBerry, checkStatusBerry,
  critBlocked, movePriorityMod, bestStat,
};
