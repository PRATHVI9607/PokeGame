// AI opponent: Gemini-driven decisions with a damage-maximizing heuristic
// fallback. Supports singles and doubles. The API key comes from the player
// (per battle) or GEMINI_API_KEY.
const { getMove } = require('../engine/data');

const GEMINI_MODEL = 'gemini-2.0-flash';
const GEMINI_URL = (key) =>
  `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${key}`;

// ---------- heuristic ----------
function estimateDamage(battle, attacker, defender, moveSlot) {
  const move = getMove(moveSlot.id);
  if (!move || move.category === 'Status' || moveSlot.pp <= 0) return 0;
  if (move.id === 'finalgambit' || move.selfdestruct) return 0;
  if (move.id === 'fakeout' && attacker.turnsOut > 0) return 0;
  if (move.id === 'suckerpunch') return 0;
  try {
    const { damage } = battle.calcDamage(attacker, defender, move, { forceRoll: 0.925 });
    const eff = battle.lastEffectiveness;
    if (eff === 0) return 0;
    let score = damage;
    if (typeof move.accuracy === 'number') score *= move.accuracy / 100;
    return score;
  } catch {
    return 0;
  }
}

function matchupScore(battle, mine, foe) {
  let give = 0;
  for (const slot of mine.moves) give = Math.max(give, estimateDamage(battle, mine, foe, slot) / Math.max(1, foe.hp));
  let take = 0;
  for (const slot of foe.moves) take = Math.max(take, estimateDamage(battle, foe, mine, slot) / Math.max(1, mine.hp));
  return give - take;
}

function bestSwitchTarget(battle, side, exclude) {
  const foes = battle.foeSide(side).aliveActives();
  const options = side.team
    .map((p, i) => ({ p, i }))
    .filter(({ p, i }) => !p.fainted && !side.actives.includes(p) && !exclude.has(i));
  if (!options.length) return null;
  let best = options[0], bestScore = -Infinity;
  for (const opt of options) {
    const s = foes.length ? Math.max(...foes.map(f => matchupScore(battle, opt.p, f))) : 0;
    if (s > bestScore) { bestScore = s; best = opt; }
  }
  return best.i;
}

function heuristicChoice(battle, sideIdx) {
  const side = battle.sides[sideIdx];
  const req = battle.makeRequest(sideIdx);
  const actions = new Array(battle.numActives).fill(null);

  if (req.forceSwitch || battle.phase === 'replace') {
    const used = new Set();
    const needs = req.forceSwitch || side.needsSwitch;
    for (let slot = 0; slot < battle.numActives; slot++) {
      if (!needs[slot]) continue;
      const t = bestSwitchTarget(battle, side, used);
      if (t !== null) { used.add(t); actions[slot] = { action: 'switch', target: t }; }
    }
    return { actions };
  }
  if (!req.actives) return null;

  let gimmickUsed = false;
  const switchUsed = new Set();
  for (let slot = 0; slot < battle.numActives; slot++) {
    const active = req.actives[slot];
    const mine = side.actives[slot];
    if (!active || !mine || mine.fainted) continue;
    const foes = battle.foesOf(mine);
    if (!foes.length) { actions[slot] = { action: 'move', move: 0 }; continue; }

    // best move x target
    let bestIdx = 0, bestDmg = -1, bestFoe = foes[0];
    active.moves.forEach((m, i) => {
      if (m.disabled) return;
      const moveSlot = mine.moves[i] || { id: m.id, pp: m.pp };
      for (const foe of foes) {
        const dmg = estimateDamage(battle, mine, foe, moveSlot);
        if (dmg > bestDmg) { bestDmg = dmg; bestIdx = i; bestFoe = foe; }
      }
    });

    // sometimes use a status move early when no KO in sight
    if (bestDmg < bestFoe.hp * 0.5 && Math.random() < 0.25) {
      const statusIdx = active.moves.findIndex((m, i) =>
        !m.disabled && m.category === 'Status' && mine.moves[i] && mine.moves[i].pp > 0);
      if (statusIdx >= 0 && mine.turnsOut < 3) bestIdx = statusIdx;
    }

    // bail out of awful matchups (singles only, keeps doubles aggressive)
    const locked = active.moves.filter(m => !m.disabled).length === 1;
    if (battle.gameType === 'singles' && !locked && bestDmg < bestFoe.hp * 0.25 && Math.random() < 0.5) {
      const t = bestSwitchTarget(battle, side, switchUsed);
      if (t !== null) {
        const cur = Math.max(...foes.map(f => matchupScore(battle, mine, f)));
        const cand = battle.sides[sideIdx].team[t];
        const candScore = Math.max(...foes.map(f => matchupScore(battle, cand, f)));
        if (candScore > cur + 0.15) {
          switchUsed.add(t);
          actions[slot] = { action: 'switch', target: t };
          continue;
        }
      }
    }

    const a = { action: 'move', move: bestIdx };
    const foeSlot = battle.sides[1 - sideIdx].actives.indexOf(bestFoe);
    if (foeSlot >= 0) a.target = { side: 1 - sideIdx, slot: foeSlot };

    if (!gimmickUsed) {
      if (active.canMega) { a.gimmick = 'mega'; gimmickUsed = true; }
      else if (active.canZMove && active.canZMove[bestIdx] && bestDmg < bestFoe.hp) { a.gimmick = 'zmove'; gimmickUsed = true; }
      else if (active.canDynamax &&
               (side.team.filter(p => !p.fainted).length <= 3 ||
                battle.sides[1 - sideIdx].aliveActives().some(p => p.dynamaxed))) {
        a.gimmick = 'dynamax'; gimmickUsed = true;
      } else if (active.canTera) {
        const moveType = active.moves[bestIdx].type;
        if (moveType === mine.teraType && bestDmg > 0 && bestDmg < bestFoe.hp * 1.2) {
          a.gimmick = 'tera'; gimmickUsed = true;
        }
      }
    }
    actions[slot] = a;
  }
  return { actions };
}

// ---------- Gemini ----------
function describeState(battle, sideIdx, req) {
  const side = battle.sides[sideIdx];
  const foeSide = battle.sides[1 - sideIdx];
  const pokeLine = (p) => p ? {
    species: p.species.name, hpPercent: p.hpPercent(), status: p.status || null,
    types: p.types, boosts: p.boosts, terastallized: p.terastallized,
    dynamaxed: p.dynamaxed, mega: p.mega,
  } : null;
  return {
    gameType: battle.gameType,
    turn: battle.turn,
    weather: battle.effWeather() || null,
    terrain: battle.terrain || null,
    yourActives: side.actives.map(pokeLine),
    opponentActives: foeSide.actives.map((p, slot) => p && !p.fainted ? Object.assign({ slot }, pokeLine(p)) : null),
    yourSlots: (req.actives || []).map((a, slot) => a ? {
      slot,
      moves: a.moves.map((m, i) => ({
        index: i, name: m.name, type: m.type, category: m.category,
        basePower: m.basePower, pp: m.pp, disabled: m.disabled,
      })),
      gimmicks: {
        canTera: a.canTera, canMega: a.canMega, canDynamax: a.canDynamax,
        canZMove: a.canZMove ? a.canZMove.map((z, i) => z ? { index: i, name: z.name } : null).filter(Boolean) : false,
      },
    } : null),
    yourBench: side.team.map((p, i) => ({
      index: i, species: p.species.name, hpPercent: p.hpPercent(),
      fainted: p.fainted, active: side.actives.includes(p),
    })),
    mustSwitchSlots: req.forceSwitch || null,
  };
}

async function geminiRequest(apiKey, prompt, timeoutMs = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(GEMINI_URL(apiKey), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.7, maxOutputTokens: 300 },
      }),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`Gemini HTTP ${res.status}`);
    const data = await res.json();
    return data.candidates?.[0]?.content?.parts?.[0]?.text || '';
  } finally {
    clearTimeout(timer);
  }
}

async function geminiChoice(battle, sideIdx, apiKey) {
  const req = battle.makeRequest(sideIdx);
  const state = describeState(battle, sideIdx, req);
  const slots = battle.numActives;
  const prompt = `You are a competitive Pokemon battle AI playing ${battle.gameType}. Pick the best action for EACH of your active slots this turn.
Battle state (JSON): ${JSON.stringify(state)}

Rules:
- Respond with a JSON object: {"actions": [<action for slot 0>${slots > 1 ? ', <action for slot 1>' : ''}]}.
- Each action: {"action":"move","move":<index>,"gimmick":null|"tera"|"mega"|"dynamax"|"zmove","target":{"side":${1 - sideIdx},"slot":<opponent slot>}} or {"action":"switch","target":<bench index>}.
- Use null for a slot with no active Pokemon.
- If mustSwitchSlots is set, those slots MUST switch to non-fainted, non-active bench Pokemon (no two slots to the same one).
- At most ONE gimmick across all slots per turn, and only if listed as available.
- Think about type matchups, HP, boosts, spread damage and win conditions.

Respond with ONLY the JSON object, no prose.`;

  const text = await geminiRequest(apiKey, prompt);
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('No JSON in Gemini response');
  const parsed = JSON.parse(match[0]);
  if (!Array.isArray(parsed.actions)) throw new Error('Bad Gemini actions');
  const actions = parsed.actions.slice(0, slots).map(a => {
    if (!a) return null;
    if (a.action === 'switch') return { action: 'switch', target: a.target };
    const out = { action: 'move', move: a.move };
    if (a.gimmick) out.gimmick = a.gimmick;
    if (a.target && typeof a.target.side === 'number') out.target = { side: a.target.side, slot: a.target.slot || 0 };
    return out;
  });
  while (actions.length < slots) actions.push(null);
  return { actions };
}

async function decide(battle, sideIdx, apiKey) {
  if (apiKey) {
    try {
      const choice = await geminiChoice(battle, sideIdx, apiKey);
      const err = battle.validateChoice(battle.sides[sideIdx], choice);
      if (!err) return { choice, source: 'gemini' };
    } catch { /* fall through to heuristic */ }
  }
  return { choice: heuristicChoice(battle, sideIdx), source: 'heuristic' };
}

// short trash-talk lines; Gemini if available, canned otherwise
const CANNED = {
  start: ['Let\'s have a good battle!', 'My team is ready. Are you?', 'Show me what you\'ve got!'],
  ko: ['One down!', 'That one hit hard.', 'Your team is crumbling!'],
  lost_mon: ['Ouch. Fine, next!', 'A worthy trade.', 'You\'ll pay for that one.'],
  win: ['GG! That was fun.', 'Victory is mine. Rematch anytime.'],
  loss: ['GG, you got me. Well played!', 'Impressive. I\'ll train harder.'],
};
async function botChat(event, apiKey, context = '') {
  const canned = CANNED[event] ? CANNED[event][Math.floor(Math.random() * CANNED[event].length)] : '';
  if (!apiKey) return canned;
  try {
    const text = await geminiRequest(apiKey,
      `You are a confident but friendly Pokemon trainer in a battle chat. Event: ${event}. ${context}
Reply with ONE short line (max 12 words) of in-character banter. No quotes, no emojis.`, 4000);
    const line = text.trim().split('\n')[0].slice(0, 120);
    return line || canned;
  } catch {
    return canned;
  }
}

module.exports = { decide, heuristicChoice, botChat };
