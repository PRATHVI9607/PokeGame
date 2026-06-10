# PokeArena

A browser Pokemon battle simulator in the spirit of Pokemon Showdown, powered by a
**custom battle engine built from scratch**. The turn loop, damage formula, abilities,
items, statuses, weather, terrain and hazards are all our own code; `@pkmn/dex` is
used only as a data source for base stats, move tables and learnsets.

![engine](https://img.shields.io/badge/engine-custom-36e2b4) ![node](https://img.shields.io/badge/node-%3E%3D18-blue)

## Features

- **6v6 singles AND doubles battles**: status, weather, terrain, hazards, screens,
  crits, priority, multi-hit, recoil, drain, confusion, Protect, Substitute,
  spread moves with proper 0.75x penalty, target selection, Follow Me, Helping Hand
- **All four gimmicks in every match**: Terastallization, Mega Evolution,
  Z-Moves and Dynamax (each usable once per side per battle)
- **~90 abilities and ~50 items** implemented, including Disguise, Parental Bond,
  Wonder Guard, Intimidate, weather/terrain setters, choice items, pinch berries
- **Shiny Pokemon**: shiny toggle in the builder, shiny sprites + sparkle effect
  in battle, rare shinies in random teams
- **Accounts (optional)**: register/login (scrypt-hashed passwords, signed session
  tokens, login rate limiting); your teams sync to the server. Guests just pick a name
- **Team builder**: any species, moves validated against real learnsets, items,
  abilities, natures, EV/IV editing with live stat preview, Tera type, shiny,
  Showdown paste import/export, multiple saved teams
- **Online lobby**: see who is online, challenge trainers (singles or doubles,
  random or custom teams)
- **Random battle queue**: per-format matchmaking with generated teams
- **AI opponent**: Gemini-powered bot (paste your API key in the UI) with a
  damage-maximizing heuristic fallback, plays doubles too, banters in chat
- **Presentation**: 3D-perspective arena with a depth-tilted floor, animated
  battles (lunges, projectiles, hit shakes, HP tweens, faints, gimmick
  transformations, weather overlays, screen shake), Pokemon cries, synthesized
  SFX and looping battle music

## Quick start (local)

```bash
npm install
npm start            # open http://localhost:3000
```

Open two browser tabs to battle yourself, or click "Battle the AI".

```bash
npm test             # engine self-test: full bot-vs-bot battles
node scripts/e2e.js  # server e2e: matchmaking + bot battle over real sockets
```

## Host it for free (so friends can play online)

The app is a single Node process that needs **websocket support**. Static hosts
(GitHub Pages, Netlify, Vercel serverless) will NOT work. These free options do:

### Option 1: Render (recommended, ~5 minutes)

1. Push this folder to a GitHub repo:
   ```bash
   git init
   git add .
   git commit -m "PokeArena"
   git remote add origin https://github.com/<you>/pokearena.git
   git push -u origin main
   ```
2. Sign up at [render.com](https://render.com) (free, GitHub login, no card).
3. Click **New > Blueprint**, select your repo. The included `render.yaml`
   configures everything automatically (free plan, build + start commands).
4. Wait for the deploy to go live. You get a public URL like
   `https://pokearena.onrender.com`. Share it - anyone can open it, pick a
   trainer name and battle in the lobby.
5. Optional: in the service's Environment tab set `GEMINI_API_KEY` so the bot
   uses Gemini for every visitor without them pasting a key.

Free-tier caveat: the server sleeps after 15 minutes with no traffic and takes
about 30 seconds to wake on the next visit. Battles in progress survive only
while the server is awake, and the lobby is in-memory (restarts clear it).

### Option 2: Hugging Face Spaces (free, no card, Docker)

1. Create a **Space** at [huggingface.co/new-space](https://huggingface.co/new-space),
   choose **Docker** as the SDK.
2. Push this repo to the Space (it already contains a `Dockerfile` that listens
   on port 7860, which Spaces expects):
   ```bash
   git remote add space https://huggingface.co/spaces/<you>/pokearena
   git push space main
   ```
3. Your game is live at `https://<you>-pokearena.hf.space`.

### Option 3: Railway / Koyeb / Fly.io

All work with the same setup: build `npm install`, start `node server/index.js`,
port comes from the `PORT` env var (already handled). Their free offerings change
often and may require a credit card for verification - check before committing.

### About "login"

There are no passwords by design: players just pick a trainer name when they
open the site (names are de-duplicated per session), and teams are saved in each
player's own browser. That keeps the server stateless and free-tier friendly.
If you later want real accounts, add a small auth layer + database (e.g.
Supabase free tier) on top of `server/index.js`.

## Architecture

```
engine/           custom battle engine (no simulator code imported)
  data.js         type chart, natures, Z/Max tables + dex data accessors
  pokemon.js      stat math, boosts, status, volatiles
  battle.js       turn loop, damage formula, move pipeline, end-of-turn
  effects.js      ~70 abilities + ~40 items as hook functions
  gimmicks.js     Tera / Mega / Z-Move / Dynamax
  random-teams.js random battle team generator
server/           express + socket.io: lobby, queue, rooms, Gemini bot, dex API
public/           vanilla JS client: teambuilder, battle renderer, audio
scripts/          selftest (engine) + e2e (sockets)
```

The engine emits a Showdown-like line protocol (`|move|`, `|-damage|`,
`|-terastallize|`, ...) which the client renders as an animated battle.
Battles are fully server-authoritative; clients only send choices.

See [PRD.md](PRD.md) for the full product spec.

## Gemini API key

Get a free key at [aistudio.google.com/apikey](https://aistudio.google.com/apikey).
Paste it in the "Battle the AI" card. The key stays in your browser's
localStorage and is used server-side only for your own battle's bot decisions.
Or set `GEMINI_API_KEY` on the server to enable it globally.

## Known scope limits

A few niche moves (Counter, Encore, Whirlwind, Wish) are intentional no-ops,
and U-turn-style switches resolve at end of turn rather than mid-turn. Both are
documented in the PRD as accepted simplifications.
