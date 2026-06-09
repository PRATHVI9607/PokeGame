// AI opponent: Gemini-driven decisions with a damage-maximizing heuristic
// fallback. The API key comes from the player (per battle) or GEMINI_API_KEY.
const { getMove, typeEffect } = require('../engine/data');

const GEMINI_MODEL = 'gemini-2.0-flash';
const GEMINI_URL = (key) =>
  `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${key}`;

// ---------- heuristic ----------
function estimateDamage(battle, attacker, defender, moveSlot) {
  const move = getMove(moveSlot.id);
  if (!move || move.category === 'Status' || moveSlot.pp <= 0) return 0;
  if (move.id === 'finalgambit' || move.selfdestruct) return 0; // calc would mutate / sack
  if (move.id === 'fakeout' && attacker.turnsOut > 0) return 0;
  if (move.id === 'suckerpunch') return 0; // unreliable for a bot
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
  // crude: best damage % I deal minus best damage % I take
  let give = 0;
  for (const slot of mine.moves) give = Math.max(give, estimateDamage(battle, mine, foe, slot) / Math.max(1, foe.hp));
  let take = 0;
  for (const slot of foe.moves) take = Math.max(take, estimateDamage(battle, foe, mine, slot) / Math.max(1, mine.hp));
  return give - take;
}

function heuristicChoice(battle, sideIdx) {
  const side = battle.sides[sideIdx];
  const req = battle.makeRequest(sideIdx);
  const mine = side.active;
  const foe = battle.foeActive(mine || side.team[0]);

  if (req.forceSwitch || battle.phase === 'replace') {
    const options = side.team
      .map((p, i) => ({ p, i }))
      .filter(({ p }) => !p.fainted && p !== side.active);
    if (!options.length) return null;
    let best = options[0], bestScore = -Infinity;
    for (const opt of options) {
      const s = foe ? matchupScore(battle, opt.p, foe) : 0;
      if (s > bestScore) { bestScore = s; best = opt; }
    }
    return { action: 'switch', target: best.i };
  }
  if (!req.active || !mine || !foe) return null;

  // score each usable move
  let bestIdx = 0, bestDmg = -1;
  req.active.moves.forEach((m, i) => {
    if (m.disabled) return;
    const slot = mine.moves[i] || { id: m.id, pp: m.pp };
    const dmg = estimateDamage(battle, mine, foe, slot);
    if (dmg > bestDmg) { bestDmg = dmg; bestIdx = i; }
  });

  // consider a status move ~25% of the time when no KO is in sight
  if (bestDmg < foe.hp * 0.5 && Math.random() < 0.25) {
    const statusIdx = req.active.moves.findIndex((m, i) =>
      !m.disabled && m.category === 'Status' && mine.moves[i] && mine.moves[i].pp > 0);
    if (statusIdx >= 0 && mine.turnsOut < 3) bestIdx = statusIdx;
  }

  // consider switching out of awful matchups (not locked, not about to KO)
  const locked = req.active.moves.filter(m => !m.disabled).length === 1;
  if (!locked && bestDmg < foe.hp * 0.25 && Math.random() < 0.5) {
    const options = side.team.map((p, i) => ({ p, i }))
      .filter(({ p }) => !p.fainted && p !== mine);
    if (options.length) {
      let best = null, bestScore = matchupScore(battle, mine, foe) + 0.15;
      for (const opt of options) {
        const s = matchupScore(battle, opt.p, foe);
        if (s > bestScore) { bestScore = s; best = opt; }
      }
      if (best) return { action: 'switch', target: best.i };
    }
  }

  const choice = { action: 'move', move: bestIdx };

  // gimmicks: mega asap; z-move/tera/dynamax when it secures or boosts damage
  if (req.active.canMega) choice.gimmick = 'mega';
  else if (req.active.canZMove && req.active.canZMove[bestIdx] && bestDmg < foe.hp) choice.gimmick = 'zmove';
  else if (req.active.canDynamax && (side.team.filter(p => !p.fainted).length <= 3 || battle.sides[1 - sideIdx].active?.dynamaxed)) {
    choice.gimmick = 'dynamax';
  } else if (req.active.canTera) {
    const moveType = req.active.moves[bestIdx].type;
    if (moveType === mine.teraType && bestDmg > 0 && bestDmg < foe.hp * 1.2) choice.gimmick = 'tera';
  }
  return choice;
}

// ---------- Gemini ----------
function describeState(battle, sideIdx, req) {
  const side = battle.sides[sideIdx];
  const foeSide = battle.sides[1 - sideIdx];
  const mine = side.active, foe = foeSide.active;
  const pokeLine = (p) => p ? {
    species: p.species.name, hpPercent: p.hpPercent(), status: p.status || null,
    types: p.types, boosts: p.boosts, terastallized: p.terastallized,
    dynamaxed: p.dynamaxed, mega: p.mega,
  } : null;
  return {
    turn: battle.turn,
    weather: battle.weather || null,
    terrain: battle.terrain || null,
    you: pokeLine(mine),
    opponent: pokeLine(foe),
    yourMoves: req.active ? req.active.moves.map((m, i) => ({
      index: i, name: m.name, type: m.type, category: m.category,
      basePower: m.basePower, pp: m.pp, disabled: m.disabled,
    })) : [],
    yourBench: side.team.map((p, i) => ({
      index: i, species: p.species.name, hpPercent: p.hpPercent(),
      fainted: p.fainted, active: p === side.active,
    })),
    opponentBenchCount: foeSide.team.filter(p => !p.fainted).length,
    gimmicks: req.active ? {
      canTera: req.active.canTera, canMega: req.active.canMega,
      canDynamax: req.active.canDynamax,
      canZMove: req.active.canZMove ? req.active.canZMove.map((z, i) => z ? { index: i, name: z.name } : null).filter(Boolean) : false,
    } : {},
    mustSwitch: !!req.forceSwitch,
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
        generationConfig: { temperature: 0.7, maxOutputTokens: 200 },
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
  const prompt = `You are a competitive Pokemon battle AI. Pick the best action this turn.
Battle state (JSON): ${JSON.stringify(state)}

Rules:
- If mustSwitch is true you MUST respond with a switch to a non-fainted, non-active bench index.
- Otherwise respond with a move (use a non-disabled move index) or a switch.
- You may attach ONE gimmick to a move: "tera", "mega", "dynamax", or "zmove" only if listed as available in gimmicks.
- Think about type matchups, HP, boosts and win conditions.

Respond with ONLY a single JSON object, no prose, in one of these forms:
{"action":"move","move":<index>,"gimmick":null|"tera"|"mega"|"dynamax"|"zmove"}
{"action":"switch","target":<bench index>}`;

  const text = await geminiRequest(apiKey, prompt);
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('No JSON in Gemini response');
  const parsed = JSON.parse(match[0]);
  const choice = parsed.action === 'switch'
    ? { action: 'switch', target: parsed.target }
    : { action: 'move', move: parsed.move };
  if (parsed.action === 'move' && parsed.gimmick) choice.gimmick = parsed.gimmick;
  return choice;
}

async function decide(battle, sideIdx, apiKey) {
  if (apiKey) {
    try {
      const choice = await geminiChoice(battle, sideIdx, apiKey);
      const side = battle.sides[sideIdx];
      const err = battle.validateChoice(side, choice);
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
