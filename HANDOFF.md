# HANDOFF - PokeArena developer guide

For anyone joining the project. Read this top to bottom once; it explains how
everything fits together, how to verify changes, and what to watch out for.

## What this is

A Pokemon battle simulator (Showdown-style) with a **fully custom battle engine**.
`@pkmn/dex` supplies DATA only (base stats, move tables, learnsets). Every line
of simulation logic is ours. Singles AND doubles. All four gimmicks (Tera, Mega,
Z-Moves, Dynamax). Accounts with server-side team storage. Gemini-powered bot.

## Run + test

```bash
npm install
npm start                  # http://localhost:3000
npm test                   # engine self-test: full random battles, singles + doubles
node scripts/e2e.js        # boots real server: auth checks + queue PvP + doubles bot battle
```

Both test scripts MUST pass before pushing. They catch most engine and
server regressions (they play entire battles with random choices + gimmicks).

## Repo map

```
engine/                 THE custom battle engine (no third-party sim code)
  data.js               type chart, natures, Z/Max tables; thin wrappers over @pkmn/dex
  pokemon.js            stat formulas, boosts, status, volatiles, dynamax HP scaling
  battle.js             core: Side/Battle classes, turn loop, damage formula, targeting,
                        status moves, end-of-turn. Built around side.actives[] so
                        singles (1 active) and doubles (2 actives) share one code path
  effects.js            ~90 abilities + ~50 items as hook functions called from battle.js
  gimmicks.js           Tera/Mega/Z/Dynamax rules and conversion tables
  random-teams.js       random battle generator (STAB+coverage+utility from learnsets)
server/
  index.js              express static + dex REST API + socket.io lobby/queue/challenges
  rooms.js              BattleRoom: battle<->socket wiring, turn timer, bot loop, rematch
  bot.js                Gemini decisions (JSON-in/JSON-out) + heuristic fallback + banter
  teams.js              team validation (species/moves/learnset legality/EVs)
  db.js                 better-sqlite3: users, user_teams, meta(secret). scrypt + HMAC tokens
  auth.js               /api/auth/* + /api/teams routes, login rate limiting
public/
  index.html            single page: home/lobby, teambuilder, battle screens
  css/style.css         design system + 3D arena scene + all battle animations
  js/util.js            sprite/cry URLs, type colors, dom helpers, toast/modal
  js/audio.js           WebAudio-synthesized SFX + PS-CDN cries + battle music
  js/teambuilder.js     teams in localStorage (+cloud sync hooks), paste import/export
  js/battle.js          protocol renderer: animation queue + choice builder UI
  js/app.js             navigation, account modal, socket wiring, team sync
scripts/
  selftest.js           engine-only battles (fast, no server)
  e2e.js                full-stack test over real sockets
```

## The two protocols you must understand

### 1. Battle log protocol (server -> client, Showdown-like)

`engine/battle.js` emits lines; `public/js/battle.js` renders them with
animation pacing. Examples:

```
|switch|p1a: Garchomp|Garchomp, L78, M, shiny|100/100
|move|p1a: Garchomp|Earthquake|p2b: Heatran|Ground|Physical   <- type+category appended for animations
|-damage|p2b: Heatran|12/100
|-supereffective|p2b: Heatran
|-terastallize|p1a: Garchomp|Steel
|faint|p2b: Heatran
|turn|7
|win|Ash
```

Position refs: `p1a`/`p1b`/`p2a`/`p2b` (slot b only exists in doubles).
HP in logs is always percent (private exact HP only goes in requests).

### 2. Choice format (client -> server)

Every decision is `{ actions: [perSlotActionOrNull] }` aligned to active slots
(length 1 in singles, 2 in doubles):

```js
{ actions: [
  { action: 'move', move: 2, gimmick: 'tera',           // gimmick optional, max 1/side/turn
    target: { side: 1, slot: 0 } },                     // target needed in doubles only
  { action: 'switch', target: 4 },                      // bench index
]}
```

Requests (`battle.makeRequest(sideIdx)`) carry `actives[]` (move data, pp,
canTera/canMega/canZMove/canDynamax/maxMoves) or `forceSwitch: [bool, bool]`
during the replacement phase, plus `side.pokemon` (your full team, exact HP).
`rqid` increments at each decision point; rooms.js dedupes sends on it.

## Battle flow (server side)

1. `BattleRoom.start()` builds teams (custom or `generateRandomTeam()`),
   creates `Battle`, emits `battle:start` (with `gameType`), calls `battle.start()`, `flush()`.
2. `flush()` = drain `battle.takeOutbox()` -> broadcast `battle:log` ->
   `sendRequests()` (rqid-deduped) -> arm 120s timer -> `runBot()`.
3. Player choices arrive via `battle:choice`; `battle.choose()` validates and,
   once all sides chose, runs the whole turn synchronously and fills the outbox.
4. Faints -> `phase: 'replace'` -> forceSwitch requests -> `commitReplacements()`.
5. Timer expiry auto-picks via `bot.heuristicChoice` for the late side.

## Accounts + security (server/db.js, server/auth.js)

- Passwords: `crypto.scryptSync` (N=16384), per-user random salt, timing-safe compare,
  dummy hash burn for unknown users (no user enumeration).
- Sessions: stateless HMAC-SHA256 tokens (`payload.signature`, 30-day expiry).
  Signing secret persisted in the DB `meta` table (or `SESSION_SECRET` env).
- Login throttle: 5 failures per IP+username -> 15 min lockout (in-memory).
- Teams: one JSON blob per user (`PUT/GET /api/teams`, Bearer auth, 400KB cap).
- Socket `lobby:join` accepts the token; verified users get their account name
  (and a "reg" badge). Guests just type a name - that is intentional.
- DB file: `pokearena.db` next to repo, or `DATABASE_PATH` env. **On Render free
  tier the disk is ephemeral**: accounts/teams reset on redeploy. Attach a persistent
  disk (paid) or point DATABASE_PATH at one if persistence matters.

## Client battle UI (public/js/battle.js)

- Lines are queued and processed sequentially (async) so animations pace out.
- Controls are a per-slot "choice builder": in doubles you pick slot A's action,
  then slot B's (with a Back button), single-target moves vs 2 alive foes show a
  target picker; then the whole `{actions}` array is submitted at once.
- Zone elements are addressed `#ally-0-*`, `#foe-1-*`, etc. Slot-1 zones are
  `hidden` in singles (`applyGameTypeLayout()`).
- Shiny: detail strings carry `, shiny`; sprites use `ani-shiny`/`ani-back-shiny`
  dirs with graceful fallback chain (animated -> static -> static non-shiny -> icon).

## Engine extension points

- New ability/item: add a branch in the right hook in `engine/effects.js`
  (`modifyStat`, `modifyBasePower`, `contactEffects`, `residualEffects`,
  `afterDamagedItem`, `statusBlocked`, ...). Unknown abilities are silently inert.
- New special-case move: `statusMoveSpecial()` (status moves) or
  `basePowerCallback()` / `afterDamage()` (damaging) in `engine/battle.js`.
- Weather must be read via `battle.effWeather()` (Cloud Nine/Air Lock aware),
  never `battle.weather` directly.
- RNG: always `battle.random()/chance()/sample()` (seedable; never Math.random
  inside the engine or replays/tests break).

## Known intentional limitations

- Counter/Mirror Coat/Encore/Disable/Taunt/Whirlwind/Roar/Wish: no-op (logged as failed).
- U-turn/Baton Pass switches resolve in the replace phase after the turn, not mid-turn.
- Charge moves (Solar Beam etc.) fire instantly (Solar Beam halved off-sun).
- No trapping (Arena Trap/Shadow Tag), no Transform/Imposter/Illusion/Stance Change.
- Doubles: no explicit ally-targeting UI for friendly moves (single-target moves
  default to foes; Helping Hand/Follow Me ARE implemented).

## Deploying

- Render: `render.yaml` blueprint (free tier; websockets fine; DB ephemeral - see above).
- Docker hosts (HF Spaces etc.): `Dockerfile` listens on 7860.
- Env vars: `PORT`, `GEMINI_API_KEY` (global bot brain), `DATABASE_PATH`, `SESSION_SECRET`.

## Conventions

- No build step. Vanilla JS everywhere, CommonJS on the server.
- Client scripts load in order: util -> audio -> teambuilder -> battle -> app.
- CSS: one accent color (`--accent` teal), 12px radius, animate transform/opacity only,
  `[hidden]{display:none!important}` keeps the hidden attribute authoritative.
- Run `npm test` + `node scripts/e2e.js` before every push.
