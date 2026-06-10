// Battle scene: renders the engine's line protocol with sequenced animations,
// sound, shiny support and the move/switch/gimmick/target control panel.
// Handles singles and doubles (slots a/b per side).
'use strict';

const BattleUI = (() => {
  let state = null;
  let sendChoice = () => {};
  let onLeave = () => {};
  let onRematch = () => {};
  let queue = [];
  let processing = false;
  let pendingRequest = null;
  let pendingNeedsAction = false;
  let timerInterval = null;

  const STAT_LABELS = { atk: 'Atk', def: 'Def', spa: 'SpA', spd: 'SpD', spe: 'Spe', accuracy: 'Acc', evasion: 'Eva' };
  const STATUS_NAMES = { brn: 'BRN', par: 'PAR', psn: 'PSN', tox: 'TOX', slp: 'SLP', frz: 'FRZ' };
  const HAZARD_NAMES = {
    stealthrock: 'Rocks', spikes: 'Spikes', toxicspikes: 'T-Spikes', stickyweb: 'Web',
    reflect: 'Reflect', lightscreen: 'L-Screen', auroraveil: 'Veil', tailwind: 'Tailwind',
  };

  function freshState() {
    return {
      roomId: null, mySide: 0, players: [], gameType: 'singles', numActives: 1,
      sides: [
        { actives: [null, null], balls: 6, fainted: 0, hazards: {}, screens: {} },
        { actives: [null, null], balls: 6, fainted: 0, hazards: {}, screens: {} },
      ],
      weather: '', terrain: '', trickRoom: false,
      over: false,
      turn: 0,
      // choice-building state
      building: null, // { slot, actions: [], gimmickUsed, pendingMove: null (awaiting target) }
      showSwitch: false,
    };
  }

  const zoneOf = (sideIdx) => (sideIdx === state.mySide ? 'ally' : 'foe');
  const elFor = (sideIdx, slot, suffix) => $(`#${zoneOf(sideIdx)}-${slot}-${suffix}`);
  const ballsEl = (sideIdx) => $(`#${zoneOf(sideIdx)}-balls`);

  function parseRef(ref) {
    // "p1a: Garchomp" / "p2b: Pelipper"
    const m = String(ref).match(/^p(\d)([ab])?:?\s*(.*)$/);
    if (!m) return null;
    return { side: +m[1] - 1, slot: m[2] === 'b' ? 1 : 0, name: m[3] };
  }
  function parseHp(str) {
    if (!str) return { pct: 100, status: '' };
    if (str.includes('fnt')) return { pct: 0, status: 'fnt' };
    const m = str.match(/^(\d+)\/(\d+)\s*(\w+)?/);
    if (!m) return { pct: 100, status: '' };
    return { pct: Math.round(+m[1] / +m[2] * 100), status: m[3] || '' };
  }
  function parseDetails(details) {
    const parts = details.split(',').map(s => s.trim());
    const species = parts[0];
    let level = 100, tera = null, shiny = false;
    for (const p of parts.slice(1)) {
      if (p.startsWith('L')) level = +p.slice(1) || 100;
      if (p.startsWith('tera:')) tera = p.slice(5);
      if (p === 'shiny') shiny = true;
    }
    return { species, level, tera, shiny };
  }
  function activeAt(sideIdx, slot) { return state.sides[sideIdx].actives[slot]; }

  // ---------- log + chat panels ----------
  function logLine(text, cls = 'l-minor') {
    const scroll = $('#log-scroll');
    scroll.appendChild(el('div', { class: cls, text }));
    scroll.scrollTop = scroll.scrollHeight;
  }
  function chatLine(from, msg, system = false) {
    const scroll = $('#chat-scroll');
    const line = el('div', { class: `chat-line${system ? ' system' : ''}` });
    if (!system) line.appendChild(el('span', { class: 'c-from', text: from + ': ' }));
    line.appendChild(document.createTextNode(msg));
    scroll.appendChild(line);
    scroll.scrollTop = scroll.scrollHeight;
  }

  function announce(text, ms = 1400) {
    const a = $('#announcer');
    a.textContent = text;
    a.classList.add('show');
    clearTimeout(a._t);
    a._t = setTimeout(() => a.classList.remove('show'), ms);
  }

  // ---------- visual helpers ----------
  const wait = (ms) => new Promise(r => setTimeout(r, prefersReducedMotion ? Math.min(ms, 60) : ms));

  function animateSprite(sideIdx, slot, cls, dur = 600) {
    const sprite = elFor(sideIdx, slot, 'sprite');
    if (!sprite || prefersReducedMotion) return;
    sprite.classList.remove(cls);
    void sprite.offsetWidth;
    sprite.classList.add(cls);
    setTimeout(() => sprite.classList.remove(cls), dur + 80);
  }

  function shakeStage() {
    if (prefersReducedMotion) return;
    const stage = $('#battle-stage');
    stage.classList.remove('shake');
    void stage.offsetWidth;
    stage.classList.add('shake');
    setTimeout(() => stage.classList.remove('shake'), 500);
  }

  function fireProjectile(fromSide, fromSlot, toSide, toSlot, type) {
    if (prefersReducedMotion) return;
    const stage = $('#battle-stage');
    const fromEl = elFor(fromSide, fromSlot, 'sprite');
    const toEl = elFor(toSide, toSlot, 'sprite');
    if (!fromEl || !toEl) return;
    const fromAnchor = fromEl.getBoundingClientRect();
    const toAnchor = toEl.getBoundingClientRect();
    const stageRect = stage.getBoundingClientRect();
    const p = el('div', { class: 'projectile' });
    p.style.color = TYPE_COLORS[type] || '#fff';
    p.style.left = (fromAnchor.left - stageRect.left + fromAnchor.width / 2) + 'px';
    p.style.top = (fromAnchor.top - stageRect.top + fromAnchor.height / 2) + 'px';
    stage.appendChild(p);
    requestAnimationFrame(() => {
      const dx = (toAnchor.left + toAnchor.width / 2) - (fromAnchor.left + fromAnchor.width / 2);
      const dy = (toAnchor.top + toAnchor.height / 2) - (fromAnchor.top + fromAnchor.height / 2);
      p.style.transform = `translate(${dx}px, ${dy}px)`;
      p.style.opacity = '0';
    });
    setTimeout(() => p.remove(), 600);
  }

  function impactBurst(sideIdx, slot, type) {
    if (prefersReducedMotion) return;
    const fx = elFor(sideIdx, slot, 'fx');
    if (!fx) return;
    const b = el('div', { class: 'impact-burst' });
    b.style.color = TYPE_COLORS[type] || '#fff';
    fx.appendChild(b);
    setTimeout(() => b.remove(), 500);
  }

  function sparkle(sideIdx, slot) {
    if (prefersReducedMotion) return;
    const fx = elFor(sideIdx, slot, 'fx');
    if (!fx) return;
    for (let i = 0; i < 6; i++) {
      const s = el('div', { class: 'shiny-sparkle' });
      s.style.left = (20 + Math.random() * 60) + '%';
      s.style.top = (15 + Math.random() * 55) + '%';
      s.style.animationDelay = (i * 0.09) + 's';
      fx.appendChild(s);
      setTimeout(() => s.remove(), 1300);
    }
  }

  function boostFloat(sideIdx, slot, text, positive) {
    if (prefersReducedMotion) return;
    const fx = elFor(sideIdx, slot, 'fx');
    if (!fx) return;
    const f = el('div', { class: 'boost-float', text });
    f.style.color = positive ? 'var(--accent)' : 'var(--danger)';
    fx.appendChild(f);
    setTimeout(() => f.remove(), 1100);
  }

  function setHp(sideIdx, slot, pct, status) {
    const poke = activeAt(sideIdx, slot);
    if (!poke) return;
    poke.hp = pct;
    if (status !== undefined && status !== 'fnt') poke.status = status;
    const fill = elFor(sideIdx, slot, 'hp');
    if (!fill) return;
    fill.style.width = Math.max(0, pct) + '%';
    fill.classList.toggle('low', pct <= 25);
    fill.classList.toggle('mid', pct > 25 && pct <= 55);
    elFor(sideIdx, slot, 'hp-text').textContent = Math.max(0, pct) + '%';
    renderStatusChip(sideIdx, slot);
  }

  function renderStatusChip(sideIdx, slot) {
    const poke = activeAt(sideIdx, slot);
    const chip = elFor(sideIdx, slot, 'status');
    if (!chip) return;
    const st = poke && poke.status;
    if (st && STATUS_NAMES[st]) {
      chip.hidden = false;
      chip.textContent = STATUS_NAMES[st];
      chip.className = `status-chip status-${st}`;
    } else chip.hidden = true;
  }

  function renderBoosts(sideIdx, slot) {
    const poke = activeAt(sideIdx, slot);
    const wrap = elFor(sideIdx, slot, 'boosts');
    if (!wrap) return;
    wrap.innerHTML = '';
    if (!poke) return;
    for (const [stat, n] of Object.entries(poke.boosts || {})) {
      if (!n) continue;
      wrap.appendChild(el('span', {
        class: `boost-chip${n < 0 ? ' neg' : ''}`,
        text: `${n > 0 ? '+' : ''}${n} ${STAT_LABELS[stat] || stat}`,
      }));
    }
  }

  function renderHazards(sideIdx) {
    const side = state.sides[sideIdx];
    // hazard chips live on slot 0's HUD only
    const wrap = elFor(sideIdx, 0, 'hazards');
    if (!wrap) return;
    wrap.innerHTML = '';
    for (const [id, val] of Object.entries(side.hazards)) {
      if (!val) continue;
      const label = HAZARD_NAMES[id] || id;
      wrap.appendChild(el('span', { class: 'hazard-chip', text: val > 1 ? `${label} x${val}` : label }));
    }
    for (const id of Object.keys(side.screens)) {
      wrap.appendChild(el('span', { class: 'hazard-chip screen', text: HAZARD_NAMES[id] || id }));
    }
  }

  function renderBalls(sideIdx) {
    const side = state.sides[sideIdx];
    const wrap = ballsEl(sideIdx);
    if (!wrap) return;
    wrap.innerHTML = '';
    for (let i = 0; i < side.balls; i++) {
      wrap.appendChild(el('span', { class: `ball${i < side.fainted ? ' fainted' : ''}` }));
    }
  }

  function renderField() {
    const banner = $('#field-banner');
    banner.innerHTML = '';
    const weatherNames = { sun: 'Harsh sunlight', rain: 'Rain', sand: 'Sandstorm', snow: 'Snow' };
    if (state.weather) banner.appendChild(el('span', { class: 'field-chip', text: weatherNames[state.weather] || state.weather }));
    if (state.terrain) banner.appendChild(el('span', { class: 'field-chip', text: state.terrain + ' terrain' }));
    if (state.trickRoom) banner.appendChild(el('span', { class: 'field-chip', text: 'Trick Room' }));
    const layer = $('#weather-layer');
    layer.className = 'weather-layer' + (state.weather ? ` on ${state.weather}` : '');
  }

  function setSprite(sideIdx, slot, species, { tera = false, dmax = false, shiny = false } = {}) {
    const sprite = elFor(sideIdx, slot, 'sprite');
    if (!sprite) return;
    const back = sideIdx === state.mySide;
    sprite.classList.remove('hidden', 'anim-faint', 'dynamaxed', 'terastallized');
    sprite.onerror = () => {
      // animated sprite missing: static, then non-shiny, then icon
      sprite.onerror = () => {
        sprite.onerror = () => { sprite.onerror = null; sprite.src = iconUrl(species); };
        sprite.src = spriteUrl(species, { back, anim: false, shiny: false });
      };
      sprite.src = spriteUrl(species, { back, anim: false, shiny });
    };
    sprite.src = spriteUrl(species, { back, anim: true, shiny });
    if (dmax) sprite.classList.add('dynamaxed');
    if (tera) sprite.classList.add('terastallized');
  }

  // ---------- line handlers (animation queue) ----------
  async function handleLine(line) {
    if (!line.startsWith('|')) return;
    const parts = line.slice(1).split('|');
    const cmd = parts[0];

    switch (cmd) {
      case 'player': case 'teamsize': case 'start':
        return;
      case 'gametype': {
        state.gameType = parts[1] === 'doubles' ? 'doubles' : 'singles';
        state.numActives = state.gameType === 'doubles' ? 2 : 1;
        applyGameTypeLayout();
        return;
      }

      case 'turn': {
        state.turn = +parts[1];
        $('#turn-badge').hidden = false;
        $('#turn-badge').textContent = 'Turn ' + state.turn;
        logLine('Turn ' + state.turn, 'l-turn');
        await wait(250);
        return;
      }

      case 'switch': {
        const ref = parseRef(parts[1]);
        const det = parseDetails(parts[2]);
        const hp = parseHp(parts[3]);
        state.sides[ref.side].actives[ref.slot] = {
          name: ref.name, species: det.species, level: det.level,
          hp: hp.pct, status: hp.status === 'fnt' ? '' : hp.status,
          boosts: {}, tera: !!det.tera, dmax: false, shiny: det.shiny,
        };
        elFor(ref.side, ref.slot, 'hud').hidden = false;
        elFor(ref.side, ref.slot, 'name').textContent = ref.name;
        elFor(ref.side, ref.slot, 'level').textContent = 'Lv ' + det.level;
        setSprite(ref.side, ref.slot, det.species, { tera: !!det.tera, shiny: det.shiny });
        animateSprite(ref.side, ref.slot, 'anim-enter', 550);
        if (det.shiny) sparkle(ref.side, ref.slot);
        setHp(ref.side, ref.slot, hp.pct, hp.status);
        renderBoosts(ref.side, ref.slot);
        renderHazards(ref.side);
        renderBalls(ref.side);
        AudioMan.cry(det.species);
        logLine(`${ownerName(ref.side)} sent out ${ref.name}!${det.shiny ? ' (shiny!)' : ''}`, 'l-major');
        if (state.turn > 0) {
          announce(ref.side === state.mySide ? `Go, ${ref.name}!` : `${ownerName(ref.side)} sent out ${ref.name}!`, 1100);
        }
        await wait(620);
        return;
      }

      case 'move': {
        const ref = parseRef(parts[1]);
        const target = parts[3] ? parseRef(parts[3]) : null;
        const moveName = parts[2];
        const type = parts[4] || 'Normal';
        const cat = parts[5] || 'Physical';
        logLine(`${ref.name} used ${moveName}!`, 'l-major');
        announce(`${ref.name} used ${moveName}!`);
        if (cat === 'Physical') {
          animateSprite(ref.side, ref.slot, ref.side === state.mySide ? 'anim-lunge-ally' : 'anim-lunge-foe', 520);
        } else if (cat === 'Special') {
          animateSprite(ref.side, ref.slot, 'anim-special', 560);
          if (target) fireProjectile(ref.side, ref.slot, target.side, target.slot, type);
        } else {
          animateSprite(ref.side, ref.slot, 'anim-status-move', 560);
        }
        state.lastMoveType = type;
        await wait(prefersReducedMotion ? 80 : 480);
        return;
      }

      case '-damage': {
        const ref = parseRef(parts[1]);
        const hp = parseHp(parts[2]);
        const from = (parts[3] || '').replace('[from] ', '');
        const silent = (parts[3] || '').includes('[silent]');
        const poke = activeAt(ref.side, ref.slot);
        const prev = poke ? poke.hp : 100;
        setHp(ref.side, ref.slot, hp.pct, hp.status);
        if (silent) return;
        if (from && !from.includes('move:')) {
          logLine(`${ref.name} was hurt by ${prettyEffect(from)}. (${Math.max(0, prev - hp.pct)}%)`);
          animateSprite(ref.side, ref.slot, 'anim-hit', 460);
          await wait(380);
        } else {
          impactBurst(ref.side, ref.slot, state.lastMoveType);
          animateSprite(ref.side, ref.slot, 'anim-hit', 460);
          AudioMan.play('hit');
          logLine(`${ref.name} lost ${Math.max(0, prev - hp.pct)}% of its health.`);
          await wait(500);
        }
        return;
      }

      case '-heal': {
        const ref = parseRef(parts[1]);
        const hp = parseHp(parts[2]);
        const silent = (parts[3] || '').includes('[silent]');
        setHp(ref.side, ref.slot, hp.pct, hp.status);
        if (silent) return;
        animateSprite(ref.side, ref.slot, 'anim-heal', 750);
        AudioMan.play('heal');
        const from = (parts[3] || '').replace('[from] ', '');
        logLine(`${ref.name} restored health${from ? ' with ' + prettyEffect(from) : ''}.`, 'l-good');
        await wait(420);
        return;
      }

      case '-sethp': {
        const ref = parseRef(parts[1]);
        const hp = parseHp(parts[2]);
        setHp(ref.side, ref.slot, hp.pct, hp.status);
        await wait(250);
        return;
      }

      case '-supereffective': {
        AudioMan.play('supereffective');
        shakeStage();
        logLine("It's super effective!", 'l-good');
        announce("It's super effective!");
        await wait(320);
        return;
      }
      case '-resisted': {
        AudioMan.play('resisted');
        logLine("It's not very effective…");
        await wait(200);
        return;
      }
      case '-immune': {
        const ref = parseRef(parts[1]);
        logLine(`It doesn't affect ${ref.name}…`);
        announce(`It doesn't affect ${ref.name}…`);
        await wait(350);
        return;
      }
      case '-crit': {
        logLine('A critical hit!', 'l-good');
        announce('A critical hit!');
        await wait(220);
        return;
      }
      case '-miss': {
        const ref = parseRef(parts[1]);
        logLine(`${ref.name}'s attack missed!`);
        announce('It missed!');
        await wait(350);
        return;
      }
      case '-fail': {
        logLine('But it failed!');
        await wait(280);
        return;
      }
      case '-hitcount': {
        logLine(`Hit ${parts[2]} time(s)!`);
        return;
      }

      case 'faint': {
        const ref = parseRef(parts[1]);
        const side = state.sides[ref.side];
        side.fainted = Math.min(side.balls, side.fainted + 1);
        const poke = activeAt(ref.side, ref.slot);
        if (poke) { poke.hp = 0; poke.faintedOut = true; }
        setHp(ref.side, ref.slot, 0, 'fnt');
        animateSprite(ref.side, ref.slot, 'anim-faint', 850);
        AudioMan.play('faint');
        logLine(`${ref.name} fainted!`, 'l-bad');
        announce(`${ref.name} fainted!`);
        renderBalls(ref.side);
        await wait(900);
        elFor(ref.side, ref.slot, 'sprite').classList.add('hidden');
        elFor(ref.side, ref.slot, 'hud').hidden = true;
        return;
      }

      case '-status': {
        const ref = parseRef(parts[1]);
        const poke = activeAt(ref.side, ref.slot);
        if (poke) poke.status = parts[2];
        renderStatusChip(ref.side, ref.slot);
        AudioMan.play('status');
        logLine(`${ref.name} ${statusText(parts[2])}`, 'l-bad');
        await wait(380);
        return;
      }
      case '-curestatus': {
        const ref = parseRef(parts[1]);
        const poke = activeAt(ref.side, ref.slot);
        if (poke) poke.status = '';
        renderStatusChip(ref.side, ref.slot);
        logLine(`${ref.name} recovered from its status.`, 'l-good');
        await wait(250);
        return;
      }

      case '-boost': case '-unboost': {
        const ref = parseRef(parts[1]);
        const stat = parts[2];
        const n = +parts[3] * (cmd === '-unboost' ? -1 : 1);
        const poke = activeAt(ref.side, ref.slot);
        if (poke) {
          poke.boosts[stat] = (poke.boosts[stat] || 0) + n;
          renderBoosts(ref.side, ref.slot);
        }
        AudioMan.play(n > 0 ? 'boost' : 'unboost');
        boostFloat(ref.side, ref.slot, `${n > 0 ? '+' : ''}${n} ${STAT_LABELS[stat] || stat}`, n > 0);
        logLine(`${ref.name}'s ${STAT_LABELS[stat] || stat} ${n > 0 ? 'rose' : 'fell'}${Math.abs(n) > 1 ? ' sharply' : ''}!`);
        await wait(360);
        return;
      }
      case '-setboost': {
        const ref = parseRef(parts[1]);
        const poke = activeAt(ref.side, ref.slot);
        if (poke) { poke.boosts[parts[2]] = +parts[3]; renderBoosts(ref.side, ref.slot); }
        AudioMan.play('boost');
        logLine(`${ref.name} maxed its ${STAT_LABELS[parts[2]] || parts[2]}!`, 'l-good');
        await wait(360);
        return;
      }
      case '-clearallboost': {
        for (const s of [0, 1]) {
          for (let slot = 0; slot < 2; slot++) {
            const poke = activeAt(s, slot);
            if (poke) { poke.boosts = {}; renderBoosts(s, slot); }
          }
        }
        logLine('All stat changes were erased!');
        await wait(300);
        return;
      }
      case '-clearboost': {
        const ref = parseRef(parts[1]);
        const poke = activeAt(ref.side, ref.slot);
        if (poke) { poke.boosts = {}; renderBoosts(ref.side, ref.slot); }
        logLine(`${ref.name}'s stat changes were removed!`);
        return;
      }

      case '-weather': {
        const w = parts[1];
        const map = { SunnyDay: 'sun', RainDance: 'rain', Sandstorm: 'sand', Snowscape: 'snow', none: '' };
        const newWeather = map[w] !== undefined ? map[w] : '';
        const upkeep = (parts[2] || '').includes('upkeep');
        if (!upkeep && newWeather !== state.weather) {
          state.weather = newWeather;
          renderField();
          if (newWeather) {
            logLine(weatherStartText(newWeather), 'l-major');
            announce(weatherStartText(newWeather));
            await wait(550);
          } else {
            logLine('The weather cleared up.');
          }
        }
        return;
      }
      case '-fieldstart': {
        const what = parts[1].replace('move: ', '');
        if (what.includes('Trick Room')) state.trickRoom = true;
        else state.terrain = what.replace(' Terrain', '');
        renderField();
        logLine(`${what} took effect!`, 'l-major');
        await wait(400);
        return;
      }
      case '-fieldend': {
        const what = parts[1].replace('move: ', '');
        if (what.includes('Trick Room')) state.trickRoom = false;
        else state.terrain = '';
        renderField();
        logLine(`${what} faded.`);
        return;
      }

      case '-sidestart': {
        const sideIdx = +parts[1].slice(1) - 1;
        const what = parts[2].replace('move: ', '');
        const id = what.toLowerCase().replace(/[^a-z]/g, '');
        const side = state.sides[sideIdx];
        if (['reflect', 'lightscreen', 'auroraveil', 'tailwind', 'safeguard', 'mist'].includes(id)) {
          side.screens[id] = true;
        } else if (id === 'spikes' || id === 'toxicspikes') {
          side.hazards[id] = (side.hazards[id] || 0) + 1;
        } else {
          side.hazards[id] = 1;
        }
        renderHazards(sideIdx);
        logLine(`${what} was set on ${ownerName(sideIdx)}'s side!`, 'l-major');
        await wait(320);
        return;
      }
      case '-sideend': {
        const sideIdx = +parts[1].slice(1) - 1;
        const what = parts[2].replace('move: ', '');
        const id = what.toLowerCase().replace(/[^a-z]/g, '');
        const side = state.sides[sideIdx];
        if (id === 'hazards') side.hazards = {};
        else { delete side.hazards[id]; delete side.screens[id]; }
        renderHazards(sideIdx);
        logLine(`${what} wore off for ${ownerName(sideIdx)}'s side.`);
        return;
      }

      case '-terastallize': {
        const ref = parseRef(parts[1]);
        const poke = activeAt(ref.side, ref.slot);
        if (poke) poke.tera = true;
        AudioMan.play('gimmick');
        animateSprite(ref.side, ref.slot, 'anim-gimmick', 1000);
        await wait(550);
        elFor(ref.side, ref.slot, 'sprite').classList.add('terastallized');
        logLine(`${ref.name} terastallized into the ${parts[2]} type!`, 'l-good');
        announce(`${ref.name} terastallized into ${parts[2]}!`);
        await wait(500);
        return;
      }
      case '-mega': {
        const ref = parseRef(parts[1]);
        AudioMan.play('gimmick');
        animateSprite(ref.side, ref.slot, 'anim-gimmick', 1000);
        await wait(550);
        logLine(`${ref.name} mega evolved into ${parts[2]}!`, 'l-good');
        announce(`${ref.name} mega evolved!`);
        await wait(450);
        return;
      }
      case 'detailschange': {
        const ref = parseRef(parts[1]);
        const det = parseDetails(parts[2]);
        const poke = activeAt(ref.side, ref.slot);
        if (poke) poke.species = det.species;
        setSprite(ref.side, ref.slot, det.species, {
          tera: poke && poke.tera, dmax: poke && poke.dmax, shiny: poke && poke.shiny,
        });
        animateSprite(ref.side, ref.slot, 'anim-enter', 500);
        AudioMan.cry(det.species);
        await wait(400);
        return;
      }
      case '-zpower': {
        const ref = parseRef(parts[1]);
        AudioMan.play('gimmick');
        animateSprite(ref.side, ref.slot, 'anim-gimmick', 1000);
        logLine(`${ref.name} surrounded itself with its Z-Power!`, 'l-good');
        announce(`${ref.name} unleashes its Z-Power!`);
        await wait(700);
        return;
      }
      case '-dynamax': {
        const ref = parseRef(parts[1]);
        const poke = activeAt(ref.side, ref.slot);
        if (poke) poke.dmax = true;
        AudioMan.play('gimmick');
        animateSprite(ref.side, ref.slot, 'anim-gimmick', 1000);
        await wait(600);
        elFor(ref.side, ref.slot, 'sprite').classList.add('dynamaxed');
        logLine(`${ref.name} dynamaxed!`, 'l-good');
        announce(`${ref.name} is dynamaxing!`);
        await wait(450);
        return;
      }
      case '-enddynamax': {
        const ref = parseRef(parts[1]);
        const poke = activeAt(ref.side, ref.slot);
        if (poke) poke.dmax = false;
        elFor(ref.side, ref.slot, 'sprite').classList.remove('dynamaxed');
        logLine(`${ref.name} returned to normal size.`);
        await wait(300);
        return;
      }

      case 'cant': {
        const ref = parseRef(parts[1]);
        const why = parts[2];
        const texts = {
          slp: 'is fast asleep.', par: 'is paralyzed! It can\'t move!',
          frz: 'is frozen solid!', flinch: 'flinched and couldn\'t move!',
          recharge: 'must recharge!',
        };
        logLine(`${ref.name} ${texts[why] || 'can\'t move!'}`, 'l-bad');
        announce(`${ref.name} ${texts[why] || 'can\'t move!'}`);
        await wait(450);
        return;
      }

      case '-activate': {
        const ref = parseRef(parts[1]);
        const what = (parts[2] || '').replace('move: ', '').replace('ability: ', '').replace('item: ', '');
        if (what && ref) logLine(`${ref.name}: ${what} activated.`);
        await wait(200);
        return;
      }
      case '-ability': {
        const ref = parseRef(parts[1]);
        logLine(`[${ref.name}'s ${parts[2]}]`, 'l-major');
        await wait(250);
        return;
      }
      case '-enditem': {
        const ref = parseRef(parts[1]);
        logLine(`${ref.name}'s ${prettyEffect(parts[2])} was used up.`);
        return;
      }
      case '-item': {
        const ref = parseRef(parts[1]);
        logLine(`${ref.name} obtained ${parts[2]}.`);
        return;
      }
      case '-start': {
        const ref = parseRef(parts[1]);
        const what = (parts[2] || '').replace('move: ', '');
        if (what === 'confusion') logLine(`${ref.name} became confused!`, 'l-bad');
        else if (what === 'Substitute') logLine(`${ref.name} put up a substitute!`, 'l-major');
        else if (what === 'typechange') logLine(`${ref.name} became ${parts[3]} type!`);
        else logLine(`${ref.name}: ${what}`);
        await wait(280);
        return;
      }
      case '-end': {
        const ref = parseRef(parts[1]);
        logLine(`${ref.name}'s ${(parts[2] || '').toLowerCase()} ended.`);
        return;
      }
      case '-singleturn': {
        const ref = parseRef(parts[1]);
        const what = (parts[2] || '').replace('move: ', '');
        logLine(`${ref.name}: ${what}!`, 'l-major');
        await wait(280);
        return;
      }
      case '-message': {
        logLine(parts[1], 'l-major');
        await wait(280);
        return;
      }

      case 'win': {
        state.over = true;
        const winner = parts[1];
        const iWon = winner === state.players[state.mySide].name;
        AudioMan.stopMusic();
        AudioMan.play(iWon ? 'win' : 'lose');
        $('#result-title').textContent = iWon ? 'Victory' : 'Defeat';
        $('#result-sub').textContent = `${winner} won the battle!`;
        $('#result-overlay').hidden = false;
        logLine(`${winner} won the battle!`, 'l-turn');
        stopTimer();
        renderControlsWaiting('Battle over.');
        return;
      }
      default:
        return;
    }
  }

  function applyGameTypeLayout() {
    const doubles = state.gameType === 'doubles';
    $('#foe-1-zone').hidden = !doubles;
    $('#ally-1-zone').hidden = !doubles;
    $('#battle-stage').classList.toggle('doubles', doubles);
  }

  function ownerName(sideIdx) {
    return state.players[sideIdx] ? state.players[sideIdx].name : `Player ${sideIdx + 1}`;
  }
  function prettyEffect(s) {
    return String(s).replace(/^(item|ability|move):\s*/, '').replace(/^psn$/, 'poison').replace(/^brn$/, 'its burn');
  }
  function statusText(st) {
    return {
      brn: 'was burned!', par: 'was paralyzed!', psn: 'was poisoned!',
      tox: 'was badly poisoned!', slp: 'fell asleep!', frz: 'was frozen solid!',
    }[st] || `got ${st}!`;
  }
  function weatherStartText(w) {
    return {
      sun: 'The sunlight turned harsh!', rain: 'It started to rain!',
      sand: 'A sandstorm kicked up!', snow: 'It started to snow!',
    }[w];
  }

  // ---------- queue ----------
  function enqueue(lines) {
    queue.push(...lines);
    if (!processing) processQueue();
  }
  async function processQueue() {
    processing = true;
    while (queue.length) {
      const line = queue.shift();
      try { await handleLine(line); } catch (e) { console.error('line error', line, e); }
    }
    processing = false;
    if (pendingRequest) renderControls();
  }

  // ---------- controls (choice building) ----------
  function renderControlsWaiting(msg) {
    $('#controls-msg').textContent = msg;
    $('#gimmick-row').innerHTML = '';
    $('#move-grid').innerHTML = '';
    $('#switch-row').innerHTML = '';
  }

  function slotsNeedingAction(req) {
    if (req.forceSwitch) {
      return req.forceSwitch.map((n, i) => n ? i : -1).filter(i => i >= 0);
    }
    return (req.actives || []).map((a, i) => a ? i : -1).filter(i => i >= 0);
  }

  function startBuilding() {
    const req = pendingRequest;
    state.building = {
      order: slotsNeedingAction(req),
      idx: 0,
      actions: new Array(state.numActives).fill(null),
      gimmickSel: null,    // gimmick toggled for the CURRENT slot
      gimmickUsed: false,  // a gimmick is committed in a previous slot
      usedSwitchTargets: new Set(),
    };
  }

  function currentSlot() {
    const b = state.building;
    return b && b.idx < b.order.length ? b.order[b.idx] : -1;
  }

  function advanceOrSubmit() {
    const b = state.building;
    b.idx++;
    if (b.idx >= b.order.length) {
      submitChoice({ actions: b.actions });
    } else {
      state.showSwitch = false;
      renderControls();
    }
  }

  function renderControls() {
    const req = pendingRequest;
    if (!req || state.over) return;
    if (processing) return;
    if (!pendingNeedsAction || req.wait) {
      renderControlsWaiting('Waiting for the opponent…');
      stopTimer();
      return;
    }
    if (!state.building) startBuilding();
    const b = state.building;
    const slot = currentSlot();
    if (slot < 0) { renderControlsWaiting('Waiting…'); return; }

    const moveGrid = $('#move-grid');
    const switchRow = $('#switch-row');
    const gimmickRow = $('#gimmick-row');
    moveGrid.innerHTML = '';
    switchRow.innerHTML = '';
    gimmickRow.innerHTML = '';

    const myTeam = req.side.pokemon;
    const slotLabel = state.numActives > 1 ? ` (${(activeAt(state.mySide, slot) || {}).name || 'slot ' + (slot + 1)})` : '';

    if (req.forceSwitch) {
      $('#controls-msg').textContent = `Choose a replacement${slotLabel}.`;
      renderSwitchButtons(myTeam, slot, true);
      maybeBackButton(gimmickRow);
      return;
    }

    const active = req.actives[slot];
    if (!active) { advanceOrSubmit(); return; }

    $('#controls-msg').textContent = `What will ${(activeAt(state.mySide, slot) || {}).name || 'your Pokemon'} do?`;

    // gimmick toggles (one per side per turn)
    if (!b.gimmickUsed) {
      const gimmicks = [];
      if (active.canTera) gimmicks.push({ id: 'tera', label: `Terastallize · ${active.canTera}`, cls: 'g-tera' });
      if (active.canMega) gimmicks.push({ id: 'mega', label: 'Mega Evolve', cls: 'g-mega' });
      if (active.canZMove) gimmicks.push({ id: 'zmove', label: 'Z-Move', cls: 'g-zmove' });
      if (active.canDynamax) gimmicks.push({ id: 'dynamax', label: 'Dynamax', cls: 'g-dynamax' });
      for (const g of gimmicks) {
        gimmickRow.appendChild(el('button', {
          class: `gimmick-btn ${g.cls}${b.gimmickSel === g.id ? ' on' : ''}`,
          text: g.label,
          onclick: () => {
            b.gimmickSel = b.gimmickSel === g.id ? null : g.id;
            AudioMan.play('click');
            renderControls();
          },
        }));
      }
    }
    maybeBackButton(gimmickRow);

    // move buttons (transformed by active gimmick toggle)
    const useMax = b.gimmickSel === 'dynamax' || active.dynamaxed;
    const useZ = b.gimmickSel === 'zmove';
    active.moves.forEach((m, i) => {
      let label = m.name, type = m.type, bp = m.basePower, disabled = m.disabled;
      if (useMax && active.maxMoves && active.maxMoves[i]) {
        const mm = active.maxMoves[i];
        label = mm.name; type = mm.type; bp = mm.basePower;
      } else if (useZ) {
        const z = active.canZMove && active.canZMove[i];
        if (z) { label = z.name; type = z.type; bp = z.basePower; }
        else disabled = true;
      }
      const btn = el('button', {
        class: 'move-btn', disabled,
        style: `--type-color:${TYPE_COLORS[type] || '#888'}`,
        onclick: () => {
          AudioMan.play('click');
          pickMove(i, m);
        },
      },
        el('span', { class: 'm-name', text: label }),
        el('span', { class: 'm-meta' },
          typePill(type, true),
          el('span', { text: m.category }),
          bp ? el('span', { text: 'BP ' + bp }) : null,
          el('span', { class: 'm-pp', text: `${m.pp}/${m.maxpp}` }),
        ),
      );
      moveGrid.appendChild(btn);
    });

    if (state.showSwitch) renderSwitchButtons(myTeam, slot, false);
    startTimer(req.deadline);
  }

  function maybeBackButton(row) {
    const b = state.building;
    if (b && b.idx > 0) {
      row.appendChild(el('button', {
        class: 'gimmick-btn', text: '< Back',
        onclick: () => {
          const prevSlot = b.order[b.idx - 1];
          const prev = b.actions[prevSlot];
          if (prev && prev.action === 'switch') b.usedSwitchTargets.delete(prev.target);
          if (prev && prev.gimmick) b.gimmickUsed = false;
          b.actions[prevSlot] = null;
          b.idx--;
          b.gimmickSel = null;
          renderControls();
        },
      }));
    }
  }

  function pickMove(moveIdx, moveData) {
    const b = state.building;
    const slot = currentSlot();
    const a = { action: 'move', move: moveIdx };
    if (b.gimmickSel) { a.gimmick = b.gimmickSel; b.gimmickUsed = true; b.gimmickSel = null; }

    // doubles target selection for single-target moves
    const foeSideIdx = 1 - state.mySide;
    const foes = state.sides[foeSideIdx].actives
      .map((p, s) => ({ p, s }))
      .filter(x => x.p && x.p.hp > 0 && !x.p.faintedOut);
    const needsTarget = state.numActives > 1 && foes.length > 1 &&
      !['allAdjacentFoes', 'allAdjacent', 'self', 'allySide', 'allyTeam', 'all', 'adjacentAllyOrSelf'].includes(moveData.target);
    if (needsTarget) {
      b.actions[currentSlot()] = null;
      renderTargetPicker(a, foes);
      return;
    }
    if (foes.length) a.target = { side: foeSideIdx, slot: foes[0].s };
    b.actions[slot] = a;
    advanceOrSubmit();
  }

  function renderTargetPicker(action, foes) {
    const moveGrid = $('#move-grid');
    const switchRow = $('#switch-row');
    moveGrid.innerHTML = '';
    switchRow.innerHTML = '';
    $('#controls-msg').textContent = 'Choose a target.';
    for (const { p, s } of foes) {
      const img = el('img', { src: iconUrl(p.species), alt: '' });
      img.onerror = () => { img.style.visibility = 'hidden'; };
      moveGrid.appendChild(el('button', {
        class: 'switch-btn target-btn',
        onclick: () => {
          AudioMan.play('click');
          action.target = { side: 1 - state.mySide, slot: s };
          state.building.actions[currentSlot()] = action;
          advanceOrSubmit();
        },
      },
        img,
        el('span', {}, el('div', { text: p.name }), el('div', { class: 'sw-hp', text: p.hp + '% HP' })),
      ));
    }
    moveGrid.appendChild(el('button', {
      class: 'gimmick-btn', text: '< Back',
      onclick: () => renderControls(),
    }));
  }

  function renderSwitchButtons(myTeam, slot, force) {
    const switchRow = $('#switch-row');
    const b = state.building;
    switchRow.innerHTML = '';
    myTeam.forEach((p, i) => {
      if (p.active) return;
      const fainted = p.condition.includes('fnt');
      const taken = b.usedSwitchTargets.has(i);
      const hpm = p.condition.match(/^(\d+)\/(\d+)/);
      const pct = fainted ? 0 : hpm ? Math.round(+hpm[1] / +hpm[2] * 100) : 100;
      const img = el('img', { src: iconUrl(p.species), alt: '' });
      img.onerror = () => { img.style.visibility = 'hidden'; };
      switchRow.appendChild(el('button', {
        class: 'switch-btn', disabled: fainted || taken,
        onclick: () => {
          AudioMan.play('click');
          b.usedSwitchTargets.add(i);
          b.actions[slot] = { action: 'switch', target: i };
          advanceOrSubmit();
        },
      },
        img,
        el('span', {},
          el('div', { text: p.species + (p.shiny ? ' ✦' : '') }),
          el('div', { class: 'sw-hp', text: fainted ? 'Fainted' : taken ? 'Chosen' : pct + '% HP' })),
      ));
    });
  }

  function submitChoice(choice) {
    state.building = null;
    state.showSwitch = false;
    pendingNeedsAction = false;
    renderControlsWaiting('Waiting for the opponent…');
    stopTimer();
    sendChoice(choice);
  }

  function startTimer(deadline) {
    stopTimer();
    if (!deadline) return;
    const timerEl = $('#turn-timer');
    timerEl.hidden = false;
    const tick = () => {
      const left = Math.max(0, Math.round((deadline - Date.now()) / 1000));
      timerEl.textContent = Math.floor(left / 60) + ':' + String(left % 60).padStart(2, '0');
      if (left <= 0) stopTimer();
    };
    tick();
    timerInterval = setInterval(tick, 1000);
  }
  function stopTimer() {
    clearInterval(timerInterval);
    $('#turn-timer').hidden = true;
  }

  // ---------- public API ----------
  function begin({ roomId, yourSide, players, gameType }, callbacks) {
    state = freshState();
    state.roomId = roomId;
    state.mySide = yourSide;
    state.players = players;
    state.gameType = gameType === 'doubles' ? 'doubles' : 'singles';
    state.numActives = state.gameType === 'doubles' ? 2 : 1;
    sendChoice = callbacks.sendChoice;
    onLeave = callbacks.onLeave;
    onRematch = callbacks.onRematch;
    queue = [];
    processing = false;
    pendingRequest = null;
    pendingNeedsAction = false;

    $('#log-scroll').innerHTML = '';
    $('#chat-scroll').innerHTML = '';
    $('#result-overlay').hidden = true;
    $('#turn-badge').hidden = true;
    $('#field-banner').innerHTML = '';
    $('#weather-layer').className = 'weather-layer';
    for (const z of ['ally', 'foe']) {
      for (const s of [0, 1]) {
        $(`#${z}-${s}-hud`).hidden = true;
        $(`#${z}-${s}-sprite`).classList.add('hidden');
        $(`#${z}-${s}-fx`).innerHTML = '';
      }
      $(`#${z}-balls`).innerHTML = '';
    }
    applyGameTypeLayout();
    renderControlsWaiting('Battle starting…');
    logLine(`${players[0].name} vs ${players[1].name} · ${state.gameType}`, 'l-turn');
    AudioMan.startMusic();
  }

  function onLog(lines) { enqueue(lines); }

  function onRequest(request, needsAction) {
    pendingRequest = request;
    pendingNeedsAction = needsAction;
    state.building = null;
    if (!processing) renderControls();
  }

  function onChat(from, msg) {
    chatLine(from, msg, from === 'System');
    if (from !== 'System') AudioMan.play('notify');
  }

  function bindStatic(socketEmitters) {
    $('#btn-show-switch').addEventListener('click', () => {
      state.showSwitch = !state.showSwitch;
      renderControls();
    });
    $('#btn-forfeit').addEventListener('click', () => {
      if (state && !state.over) socketEmitters.forfeit(state.roomId);
    });
    $('#btn-rematch').addEventListener('click', () => {
      $('#result-overlay').hidden = true;
      onRematch(state.roomId);
      renderControlsWaiting('Waiting for a rematch…');
    });
    $('#btn-back-lobby').addEventListener('click', () => {
      AudioMan.stopMusic();
      onLeave(state ? state.roomId : null);
    });
    $('#chat-form').addEventListener('submit', (e) => {
      e.preventDefault();
      const input = $('#chat-input');
      if (input.value.trim() && state) {
        socketEmitters.chat(state.roomId, input.value.trim());
        input.value = '';
      }
    });
  }

  function roomId() { return state ? state.roomId : null; }
  function isActive() { return !!state && !state.over; }

  return { begin, onLog, onRequest, onChat, bindStatic, roomId, isActive };
})();
