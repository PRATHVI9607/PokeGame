# PRD: PokeArena - Browser Pokemon Battle Simulator

## 1. Vision

A free, browser-based competitive Pokemon battle simulator in the spirit of Pokemon Showdown,
powered by a **custom-built battle engine** (no third-party simulator). Players can build teams,
battle friends in an online lobby, queue for random battles, or fight an AI trainer driven by
Google Gemini. Every match supports all four battle gimmicks: **Terastallization, Mega Evolution,
Z-Moves, and Dynamax**.

## 2. Goals

- G1: Accurate, fun 6v6 singles battles with a from-scratch engine (own turn loop, own damage
  formula, own ability/item/status logic). `@pkmn/dex` is used **only as a data source**
  (base stats, move tables, learnsets) - zero simulation logic is borrowed.
- G2: All four gimmicks usable in every match (one use of each per side per battle).
- G3: Full team builder: species/move/item/ability/EV/IV/nature/Tera-type selection,
  import/export in Showdown paste format, saved to localStorage.
- G4: Online play: named lobby with challenge system + random-battle quick matchmaking.
- G5: Bot battles: Gemini-powered AI opponent (user-supplied API key), with a strong
  heuristic fallback when no key is set.
- G6: Premium presentation: dark esports aesthetic, real battle animations (lunge, hit flash,
  HP tween, faint, gimmick transformations, screen shake), Pokemon cries + synthesized SFX
  + battle music.
- G7: Deployable to a free host (Render free tier) with one config file.

## 3. Non-Goals

- Doubles/VGC, tournaments, ladders/ELO, chat moderation, accounts/persistence beyond
  localStorage, perfect parity with every one of 900+ abilities (we target the ~70 most
  common abilities and ~40 most common items; unimplemented ones simply have no effect).

## 4. Architecture

```
browser (vanilla JS SPA)  <-- Socket.IO -->  Node.js server
  - lobby / teambuilder / battle scenes        - express static + REST dex API
  - protocol-event renderer + animator         - engine/  <- CUSTOM battle engine
  - WebAudio SFX + music + cries               - rooms / matchmaking / bot (Gemini REST)
```

Server-authoritative: battles run on the server; clients send choices, receive event logs.

### 4.1 Custom Engine (engine/)

- `data.js` - loads species/moves/items/abilities/learnsets from @pkmn/dex into plain tables;
  hardcoded gen-9 type chart and nature table (ours).
- `pokemon.js` - Pokemon class: stat calc (HP/stat formulas implemented from the known formulas),
  boosts (+/-6 stages), status, volatiles.
- `battle.js` - Battle class: team preview-less 6v6 singles; choice collection; turn order
  (priority -> speed, Trick Room aware); move execution pipeline (accuracy, crits, damage with
  the gen 5+ formula, secondary effects); switch mechanics + hazards; end-of-turn queue
  (weather, status, Leftovers, etc.); win detection. Emits a line-based event log
  (`|move|`, `|-damage|`, `|switch|`, ...) consumed by the client renderer.
- `effects.js` - ability + item handlers registered on hook points
  (onSwitchIn, onModifyAtk, onTakeDamage, onResidual, ...).
- `gimmicks.js` - Tera (type change, STAB rules, Tera Blast), Mega (stone -> forme change,
  stat/ability swap), Z-Moves (crystal -> one-shot Z power table conversion), Dynamax
  (HP x2 for 3 turns, Max Move conversion with stat-boost side effects, Max Guard).
- `random-teams.js` - our own generator: 6 random battle-worthy species with STAB + coverage +
  utility movesets from real learnset data, items, EVs, abilities.
- Determinism: seedable PRNG for testability.

### 4.2 Move coverage strategy

The dex move table carries machine-readable effect data (power, accuracy, priority, secondary
chance/status/boosts, drain, recoil, multihit, selfSwitch, weather, sideConditions, heal,
stat-override fields). The engine interprets these fields generically, which covers the large
majority of moves automatically; ~30 special moves (Stealth Rock, Protect, Substitute, Sucker
Punch, Gyro Ball, Body Press, Foul Play, Knock Off, U-turn, ...) get bespoke handlers.

## 5. Features

### 5.1 Battle (P0)
6v6 singles. Move/switch choices with a turn timer (90s). Mid-turn faint replacement.
Status (BRN/PAR/SLP/PSN/TOX/FRZ), weather (sun/rain/sand/snow), terrains, hazards
(Stealth Rock, Spikes, Toxic Spikes, Sticky Web), screens, Protect, Substitute, crits,
STAB, type chart, immunities, priority, multi-hit, recoil, drain, flinch, confusion.

### 5.2 Gimmicks (P0)
Per battle, each side may use EACH gimmick once: Terastallize, Mega Evolve (needs stone),
Z-Move (needs crystal), Dynamax. UI shows toggle buttons on the move panel when legal.

### 5.3 Team Builder (P0)
Search any species; pick ability/item/nature/EVs/IVs/4 moves (validated against learnset)/
Tera type. Up to 6 Pokemon per team, multiple teams saved locally. Import/export Showdown
paste. Random team button.

### 5.4 Lobby + Matchmaking (P0)
Pick a name -> lobby shows online users + open challenges. Challenge a user (random or your
team) or join the random-battle queue (auto-pair). Rematch offer at battle end. Spectator-safe:
each client only receives its own side's private data.

### 5.5 Gemini Bot (P0)
"Battle the AI" with user-pasted Gemini API key (stored in localStorage, sent per battle,
never persisted server-side; server env GEMINI_API_KEY also supported). Bot receives a
compact battle-state JSON and chooses move/switch/gimmick via gemini-2.0-flash; on error or
no key, falls back to a damage-maximizing heuristic with switch logic. Bot trash-talks via
short Gemini-generated chat lines.

### 5.6 Presentation (P0)
- Dark arena aesthetic, electric-teal single accent, Outfit + JetBrains Mono.
- Animated battle scene: switch-in pop + cry, attack lunge by category, type-colored
  projectile/burst, hit shake + flash, HP bar tween with color thresholds, faint sink,
  weather overlays, gimmick transformation flashes, screen shake on super-effective.
- Audio: Pokemon cries (Showdown CDN), WebAudio-synthesized SFX (hit, super-effective,
  ko, click, heal), looping battle music (mutable). All audio behind a mute toggle.
- Sprites: Showdown sprite CDN (animated gen5 where available).

### 5.7 Deploy (P0)
Single Node process serves everything. `render.yaml` blueprint for Render free tier
(supports websockets). README covers Render + Railway + Fly + local.

## 6. Quality Bars

- A full random battle bot-vs-bot completes without exceptions (automated test script).
- Damage values match hand-computed gen-9 formula cases (unit test script).
- First meaningful paint < 2s on broadband; battle animations 60fps transform/opacity only.
- Works in Chrome/Edge/Firefox current. Mobile: playable single-column layout.

## 7. Milestones

1. Engine core (turns, damage, status, switching, hazards, weather) + tests
2. Gimmicks + abilities/items + random teams
3. Server (rooms, lobby, queue) + bot
4. Client shell + teambuilder
5. Battle scene + animations + audio
6. Polish + deploy config
