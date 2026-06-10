// Engine self-test: run N full random battles (singles AND doubles) with
// random choices (including gimmicks) and assert they complete cleanly.
const { Battle } = require('../engine/battle');
const { generateRandomTeam } = require('../engine/random-teams');

function buildChoice(battle, sideIdx) {
  const req = battle.makeRequest(sideIdx);
  if (req.wait) return null;
  const side = battle.sides[sideIdx];
  const actions = new Array(battle.numActives).fill(null);

  if (req.forceSwitch) {
    const used = new Set();
    for (let slot = 0; slot < battle.numActives; slot++) {
      if (!req.forceSwitch[slot]) continue;
      const options = side.team
        .map((p, i) => i)
        .filter(i => !side.team[i].fainted && !side.actives.includes(side.team[i]) && !used.has(i));
      if (options.length) {
        const t = options[Math.floor(Math.random() * options.length)];
        used.add(t);
        actions[slot] = { action: 'switch', target: t };
      }
    }
    return { actions };
  }
  if (!req.actives) return null;

  let gimmickUsed = false;
  const switchUsed = new Set();
  for (let slot = 0; slot < battle.numActives; slot++) {
    const active = req.actives[slot];
    if (!active) continue;
    // 8% voluntary switch
    const bench = side.team.map((p, i) => i)
      .filter(i => !side.team[i].fainted && !side.actives.includes(side.team[i]) && !switchUsed.has(i));
    if (bench.length && Math.random() < 0.08) {
      const t = bench[Math.floor(Math.random() * bench.length)];
      switchUsed.add(t);
      actions[slot] = { action: 'switch', target: t };
      continue;
    }
    const enabled = active.moves.map((m, i) => ({ m, i })).filter(x => !x.m.disabled);
    const moveIdx = enabled.length ? enabled[Math.floor(Math.random() * enabled.length)].i : 0;
    const a = { action: 'move', move: moveIdx };
    // random target in doubles
    if (battle.gameType === 'doubles') {
      const foes = battle.sides[1 - sideIdx].actives
        .map((p, s) => ({ p, s })).filter(x => x.p && !x.p.fainted);
      if (foes.length) {
        const f = foes[Math.floor(Math.random() * foes.length)];
        a.target = { side: 1 - sideIdx, slot: f.s };
      }
    }
    if (!gimmickUsed) {
      const gimmicks = [];
      if (active.canTera) gimmicks.push('tera');
      if (active.canMega) gimmicks.push('mega');
      if (active.canDynamax) gimmicks.push('dynamax');
      if (active.canZMove && active.canZMove[moveIdx]) gimmicks.push('zmove');
      if (gimmicks.length && Math.random() < 0.35) {
        a.gimmick = gimmicks[Math.floor(Math.random() * gimmicks.length)];
        gimmickUsed = true;
      }
    }
    actions[slot] = a;
  }
  return { actions };
}

function sideNeeds(battle, i) {
  const side = battle.sides[i];
  if (battle.ended) return false;
  if (battle.phase === 'replace') return side.needsSwitch.some(Boolean) && !side.choices;
  return !side.choices && side.aliveActives().length > 0;
}

async function runOne(n, gameType) {
  const [t1, t2] = await Promise.all([generateRandomTeam(), generateRandomTeam()]);
  const battle = new Battle({ name: 'Bot1', team: t1 }, { name: 'Bot2', team: t2 },
    { seed: n * 7919 + 13, gameType });
  battle.start();
  let safety = 0;
  while (!battle.ended && safety++ < 1500) {
    let progressed = false;
    for (const i of [0, 1]) {
      if (!sideNeeds(battle, i) || battle.ended) continue;
      const c = buildChoice(battle, i);
      if (!c) continue;
      const res = battle.choose(i, c);
      if (res.error) throw new Error(`choice rejected (${gameType}): ${res.error}`);
      progressed = true;
    }
    if (!progressed) throw new Error(`stalled at turn ${battle.turn}, phase ${battle.phase} (${gameType})`);
  }
  if (!battle.ended) return { turns: battle.turn, winner: '(timeout)', lines: battle.logLines.length };
  return { turns: battle.turn, winner: battle.winner, lines: battle.logLines.length };
}

(async () => {
  const N = parseInt(process.argv[2] || '15', 10);
  let ok = 0, total = 0;
  for (const gameType of ['singles', 'doubles']) {
    for (let i = 0; i < N; i++) {
      total++;
      try {
        const r = await runOne(i + (gameType === 'doubles' ? 1000 : 0), gameType);
        ok++;
        console.log(`${gameType} #${i + 1}: ${r.turns} turns, winner ${r.winner}, ${r.lines} lines`);
      } catch (e) {
        console.error(`${gameType} #${i + 1}: FAILED -> ${e.stack}`);
      }
    }
  }
  console.log(`\n${ok}/${total} battles completed cleanly`);
  process.exit(ok === total ? 0 : 1);
})();
