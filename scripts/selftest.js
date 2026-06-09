// Engine self-test: run N full random battles with random choices (including
// gimmicks) and assert they complete without exceptions.
const { Battle } = require('../engine/battle');
const { generateRandomTeam } = require('../engine/random-teams');

function randomChoice(battle, sideIdx) {
  const req = battle.makeRequest(sideIdx);
  if (req.wait) return null;
  const side = battle.sides[sideIdx];
  if (req.forceSwitch) {
    const options = side.team.map((p, i) => i).filter(i => !side.team[i].fainted && side.team[i] !== side.active);
    return { action: 'switch', target: options[Math.floor(Math.random() * options.length)] };
  }
  if (!req.active) return null;
  // 10% switch
  const switchable = side.team.map((p, i) => i).filter(i => !side.team[i].fainted && side.team[i] !== side.active);
  if (switchable.length && Math.random() < 0.1) {
    return { action: 'switch', target: switchable[Math.floor(Math.random() * switchable.length)] };
  }
  const enabled = req.active.moves.map((m, i) => ({ m, i })).filter(x => !x.m.disabled);
  if (!enabled.length) return { action: 'move', move: 0 };
  const moveIdx = enabled[Math.floor(Math.random() * enabled.length)].i;
  const c = { action: 'move', move: moveIdx };
  // try gimmicks aggressively to exercise them
  const gimmicks = [];
  if (req.active.canTera) gimmicks.push('tera');
  if (req.active.canMega) gimmicks.push('mega');
  if (req.active.canDynamax) gimmicks.push('dynamax');
  if (req.active.canZMove && req.active.canZMove[moveIdx]) gimmicks.push('zmove');
  if (gimmicks.length && Math.random() < 0.35) c.gimmick = gimmicks[Math.floor(Math.random() * gimmicks.length)];
  return c;
}

async function runOne(n) {
  const [t1, t2] = await Promise.all([generateRandomTeam(), generateRandomTeam()]);
  const battle = new Battle({ name: 'Bot1', team: t1 }, { name: 'Bot2', team: t2 }, { seed: n * 7919 + 13 });
  battle.start();
  let safety = 0;
  while (!battle.ended && safety++ < 1000) {
    let progressed = false;
    for (const i of [0, 1]) {
      const side = battle.sides[i];
      const needs = battle.phase === 'replace' ? side.needsSwitch && !side.choice : !side.choice;
      if (!needs || battle.ended) continue;
      const c = randomChoice(battle, i);
      if (c) {
        const res = battle.choose(i, c);
        if (res.error) {
          // fall back to first legal option
          const req = battle.makeRequest(i);
          if (req.forceSwitch || battle.phase === 'replace') {
            const opts = side.team.map((p, j) => j).filter(j => !side.team[j].fainted && side.team[j] !== side.active);
            battle.choose(i, { action: 'switch', target: opts[0] });
          } else {
            battle.choose(i, { action: 'move', move: 0 });
          }
        }
        progressed = true;
      }
    }
    if (!progressed) throw new Error(`stalled at turn ${battle.turn}, phase ${battle.phase}`);
  }
  if (!battle.ended) {
    // long stall battles are fine; force end
    return { turns: battle.turn, winner: '(timeout)', lines: battle.logLines.length };
  }
  return { turns: battle.turn, winner: battle.winner, lines: battle.logLines.length };
}

(async () => {
  const N = parseInt(process.argv[2] || '15', 10);
  let ok = 0;
  for (let i = 0; i < N; i++) {
    try {
      const r = await runOne(i);
      ok++;
      console.log(`#${i + 1}: ${r.turns} turns, winner ${r.winner}, ${r.lines} log lines`);
    } catch (e) {
      console.error(`#${i + 1}: FAILED -> ${e.stack}`);
    }
  }
  console.log(`\n${ok}/${N} battles completed cleanly`);
  process.exit(ok === N ? 0 : 1);
})();
