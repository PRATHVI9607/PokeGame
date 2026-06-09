// Battle scene: renders the engine's line protocol with sequenced animations,
// sound and the move/switch/gimmick control panel.
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
      roomId: null, mySide: 0, players: [],
      sides: [
        { active: null, balls: 6, fainted: 0, hazards: {}, screens: {} },
        { active: null, balls: 6, fainted: 0, hazards: {}, screens: {} },
      ],
      weather: '', terrain: '', trickRoom: false,
      gimmick: null, // selected toggle
      showSwitch: false,
      over: false,
      turn: 0,
    };
  }

  const zoneOf = (sideIdx) => (sideIdx === state.mySide ? 'ally' : 'foe');
  const elFor = (sideIdx, suffix) => $(`#${zoneOf(sideIdx)}-${suffix}`);

  function parseRef(ref) {
    // "p1a: Garchomp"
    const m = String(ref).match(/^p(\d)a?:?\s*(.*)$/);
    if (!m) return null;
    return { side: +m[1] - 1, name: m[2] };
  }
  function parseHp(str) {
    // "57/100 brn" | "0 fnt"
    if (!str) return { pct: 100, status: '' };
    if (str.includes('fnt')) return { pct: 0, status: 'fnt' };
    const m = str.match(/^(\d+)\/(\d+)\s*(\w+)?/);
    if (!m) return { pct: 100, status: '' };
    return { pct: Math.round(+m[1] / +m[2] * 100), status: m[3] || '' };
  }
  function parseDetails(details) {
    // "Garchomp, L85, F, shiny, tera:Fire"
    const parts = details.split(',').map(s => s.trim());
    const species = parts[0];
    let level = 100, tera = null;
    for (const p of parts.slice(1)) {
      if (p.startsWith('L')) level = +p.slice(1) || 100;
      if (p.startsWith('tera:')) tera = p.slice(5);
    }
    return { species, level, tera };
  }

  // ---------- log + chat panels ----------
  function logLine(text, cls = 'l-minor') {
    const scroll = $('#log-scroll');
    scroll.appendChild(el('div', { class: cls, text }));
    scroll.scrollTop = scroll.scrollHeight;
  }
  function chatLine(from, msg, system = false) {
    const scroll = $('#chat-scroll');
    const line = el('div', { class: `chat-line${system ? ' system' : ''}` });
    if (!system) {
      line.appendChild(el('span', { class: 'c-from', text: from + ': ' }));
    }
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

  function animateSprite(sideIdx, cls, dur = 600) {
    const sprite = elFor(sideIdx, 'sprite');
    if (prefersReducedMotion) return;
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

  function fireProjectile(fromSide, type) {
    if (prefersReducedMotion) return;
    const stage = $('#battle-stage');
    const fromAnchor = elFor(fromSide, 'sprite').getBoundingClientRect();
    const toAnchor = elFor(1 - fromSide, 'sprite').getBoundingClientRect();
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

  function impactBurst(sideIdx, type) {
    if (prefersReducedMotion) return;
    const fx = elFor(sideIdx, 'fx');
    const b = el('div', { class: 'impact-burst' });
    b.style.color = TYPE_COLORS[type] || '#fff';
    fx.appendChild(b);
    setTimeout(() => b.remove(), 500);
  }

  function boostFloat(sideIdx, text, positive) {
    if (prefersReducedMotion) return;
    const fx = elFor(sideIdx, 'fx');
    const f = el('div', { class: 'boost-float', text });
    f.style.color = positive ? 'var(--accent)' : 'var(--danger)';
    fx.appendChild(f);
    setTimeout(() => f.remove(), 1100);
  }

  function setHp(sideIdx, pct, status) {
    const side = state.sides[sideIdx];
    if (!side.active) return;
    side.active.hp = pct;
    if (status !== undefined && status !== 'fnt') side.active.status = status;
    const fill = elFor(sideIdx, 'hp');
    fill.style.width = Math.max(0, pct) + '%';
    fill.classList.toggle('low', pct <= 25);
    fill.classList.toggle('mid', pct > 25 && pct <= 55);
    elFor(sideIdx, 'hp-text').textContent = Math.max(0, pct) + '%';
    renderStatusChip(sideIdx);
  }

  function renderStatusChip(sideIdx) {
    const side = state.sides[sideIdx];
    const chip = elFor(sideIdx, 'status');
    const st = side.active && side.active.status;
    if (st && STATUS_NAMES[st]) {
      chip.hidden = false;
      chip.textContent = STATUS_NAMES[st];
      chip.className = `status-chip status-${st}`;
    } else chip.hidden = true;
  }

  function renderBoosts(sideIdx) {
    const side = state.sides[sideIdx];
    const wrap = elFor(sideIdx, 'boosts');
    wrap.innerHTML = '';
    if (!side.active) return;
    for (const [stat, n] of Object.entries(side.active.boosts || {})) {
      if (!n) continue;
      wrap.appendChild(el('span', {
        class: `boost-chip${n < 0 ? ' neg' : ''}`,
        text: `${n > 0 ? '+' : ''}${n} ${STAT_LABELS[stat] || stat}`,
      }));
    }
  }

  function renderHazards(sideIdx) {
    const side = state.sides[sideIdx];
    const wrap = elFor(sideIdx, 'hazards');
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
    const wrap = elFor(sideIdx, 'balls');
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

  function setSprite(sideIdx, species, { tera = false, dmax = false } = {}) {
    const sprite = elFor(sideIdx, 'sprite');
    const back = sideIdx === state.mySide;
    sprite.classList.remove('hidden', 'anim-faint', 'dynamaxed', 'terastallized');
    sprite.onerror = () => {
      // animated sprite missing: fall back to static gen5
      sprite.onerror = () => { sprite.onerror = null; sprite.src = iconUrl(species); };
      sprite.src = spriteUrl(species, { back, anim: false });
    };
    sprite.src = spriteUrl(species, { back, anim: true });
    if (dmax) sprite.classList.add('dynamaxed');
    if (tera) sprite.classList.add('terastallized');
  }

  // ---------- line handlers (animation queue) ----------
  async function handleLine(line) {
    if (!line.startsWith('|')) return;
    const parts = line.slice(1).split('|');
    const cmd = parts[0];

    switch (cmd) {
      case 'player': case 'teamsize': case 'gametype': case 'start':
        return;

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
        const side = state.sides[ref.side];
        const wasActive = side.active && !side.active.faintedOut;
        side.active = {
          name: ref.name, species: det.species, level: det.level,
          hp: hp.pct, status: hp.status === 'fnt' ? '' : hp.status,
          boosts: {}, tera: !!det.tera, dmax: false,
        };
        elFor(ref.side, 'hud').hidden = false;
        elFor(ref.side, 'name').textContent = ref.name;
        elFor(ref.side, 'level').textContent = 'Lv ' + det.level;
        setSprite(ref.side, det.species, { tera: !!det.tera });
        animateSprite(ref.side, 'anim-enter', 550);
        setHp(ref.side, hp.pct, hp.status);
        renderBoosts(ref.side);
        renderHazards(ref.side);
        renderBalls(ref.side);
        AudioMan.cry(det.species);
        logLine(`${ownerName(ref.side)} sent out ${ref.name}!`, 'l-major');
        if (wasActive || state.turn > 0) {
          announce(ref.side === state.mySide ? `Go, ${ref.name}!` : `${ownerName(ref.side)} sent out ${ref.name}!`, 1100);
        }
        await wait(620);
        return;
      }

      case 'move': {
        const ref = parseRef(parts[1]);
        const moveName = parts[2];
        const type = parts[4] || 'Normal';
        const cat = parts[5] || 'Physical';
        logLine(`${ref.name} used ${moveName}!`, 'l-major');
        announce(`${ref.name} used ${moveName}!`);
        if (cat === 'Physical') animateSprite(ref.side, ref.side === state.mySide ? 'anim-lunge-ally' : 'anim-lunge-foe', 520);
        else if (cat === 'Special') { animateSprite(ref.side, 'anim-special', 560); fireProjectile(ref.side, type); }
        else animateSprite(ref.side, 'anim-status-move', 560);
        state.lastMoveType = type;
        state.lastMoveCat = cat;
        await wait(prefersReducedMotion ? 80 : 480);
        return;
      }

      case '-damage': {
        const ref = parseRef(parts[1]);
        const hp = parseHp(parts[2]);
        const from = (parts[3] || '').replace('[from] ', '');
        const silent = (parts[3] || '').includes('[silent]');
        const prev = state.sides[ref.side].active ? state.sides[ref.side].active.hp : 100;
        setHp(ref.side, hp.pct, hp.status);
        if (silent) return;
        if (from && !from.includes('move:')) {
          logLine(`${ref.name} was hurt by ${prettyEffect(from)}. (${Math.max(0, prev - hp.pct)}%)`);
          animateSprite(ref.side, 'anim-hit', 460);
          await wait(380);
        } else {
          impactBurst(ref.side, state.lastMoveType);
          animateSprite(ref.side, 'anim-hit', 460);
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
        setHp(ref.side, hp.pct, hp.status);
        if (silent) return;
        animateSprite(ref.side, 'anim-heal', 750);
        AudioMan.play('heal');
        const from = (parts[3] || '').replace('[from] ', '');
        logLine(`${ref.name} restored health${from ? ' with ' + prettyEffect(from) : ''}.`, 'l-good');
        await wait(420);
        return;
      }

      case '-sethp': {
        const ref = parseRef(parts[1]);
        const hp = parseHp(parts[2]);
        setHp(ref.side, hp.pct, hp.status);
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
        if (side.active) { side.active.hp = 0; side.active.faintedOut = true; }
        setHp(ref.side, 0, 'fnt');
        animateSprite(ref.side, 'anim-faint', 850);
        AudioMan.play('faint');
        logLine(`${ref.name} fainted!`, 'l-bad');
        announce(`${ref.name} fainted!`);
        renderBalls(ref.side);
        await wait(900);
        elFor(ref.side, 'sprite').classList.add('hidden');
        elFor(ref.side, 'hud').hidden = true;
        return;
      }

      case '-status': {
        const ref = parseRef(parts[1]);
        const side = state.sides[ref.side];
        if (side.active) side.active.status = parts[2];
        renderStatusChip(ref.side);
        AudioMan.play('status');
        logLine(`${ref.name} ${statusText(parts[2])}`, 'l-bad');
        await wait(380);
        return;
      }
      case '-curestatus': {
        const ref = parseRef(parts[1]);
        const side = state.sides[ref.side];
        if (side.active) side.active.status = '';
        renderStatusChip(ref.side);
        logLine(`${ref.name} recovered from its status.`, 'l-good');
        await wait(250);
        return;
      }

      case '-boost': case '-unboost': {
        const ref = parseRef(parts[1]);
        const stat = parts[2];
        const n = +parts[3] * (cmd === '-unboost' ? -1 : 1);
        const side = state.sides[ref.side];
        if (side.active) {
          side.active.boosts[stat] = (side.active.boosts[stat] || 0) + n;
          renderBoosts(ref.side);
        }
        AudioMan.play(n > 0 ? 'boost' : 'unboost');
        boostFloat(ref.side, `${n > 0 ? '+' : ''}${n} ${STAT_LABELS[stat] || stat}`, n > 0);
        logLine(`${ref.name}'s ${STAT_LABELS[stat] || stat} ${n > 0 ? 'rose' : 'fell'}${Math.abs(n) > 1 ? ' sharply' : ''}!`);
        await wait(360);
        return;
      }
      case '-setboost': {
        const ref = parseRef(parts[1]);
        const side = state.sides[ref.side];
        if (side.active) { side.active.boosts[parts[2]] = +parts[3]; renderBoosts(ref.side); }
        AudioMan.play('boost');
        logLine(`${ref.name} maxed its ${STAT_LABELS[parts[2]] || parts[2]}!`, 'l-good');
        await wait(360);
        return;
      }
      case '-clearallboost': {
        for (const s of [0, 1]) {
          if (state.sides[s].active) { state.sides[s].active.boosts = {}; renderBoosts(s); }
        }
        logLine('All stat changes were erased!');
        await wait(300);
        return;
      }
      case '-clearboost': {
        const ref = parseRef(parts[1]);
        if (state.sides[ref.side].active) { state.sides[ref.side].active.boosts = {}; renderBoosts(ref.side); }
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
        const side = state.sides[ref.side];
        if (side.active) side.active.tera = true;
        AudioMan.play('gimmick');
        animateSprite(ref.side, 'anim-gimmick', 1000);
        await wait(550);
        elFor(ref.side, 'sprite').classList.add('terastallized');
        logLine(`${ref.name} terastallized into the ${parts[2]} type!`, 'l-good');
        announce(`${ref.name} terastallized into ${parts[2]}!`);
        await wait(500);
        return;
      }
      case '-mega': {
        const ref = parseRef(parts[1]);
        AudioMan.play('gimmick');
        animateSprite(ref.side, 'anim-gimmick', 1000);
        await wait(550);
        logLine(`${ref.name} mega evolved into ${parts[2]}!`, 'l-good');
        announce(`${ref.name} mega evolved!`);
        await wait(450);
        return;
      }
      case 'detailschange': {
        const ref = parseRef(parts[1]);
        const det = parseDetails(parts[2]);
        const side = state.sides[ref.side];
        if (side.active) side.active.species = det.species;
        setSprite(ref.side, det.species, {
          tera: side.active && side.active.tera,
          dmax: side.active && side.active.dmax,
        });
        animateSprite(ref.side, 'anim-enter', 500);
        AudioMan.cry(det.species);
        await wait(400);
        return;
      }
      case '-zpower': {
        const ref = parseRef(parts[1]);
        AudioMan.play('gimmick');
        animateSprite(ref.side, 'anim-gimmick', 1000);
        logLine(`${ref.name} surrounded itself with its Z-Power!`, 'l-good');
        announce(`${ref.name} unleashes its Z-Power!`);
        await wait(700);
        return;
      }
      case '-dynamax': {
        const ref = parseRef(parts[1]);
        const side = state.sides[ref.side];
        if (side.active) side.active.dmax = true;
        AudioMan.play('gimmick');
        animateSprite(ref.side, 'anim-gimmick', 1000);
        await wait(600);
        elFor(ref.side, 'sprite').classList.add('dynamaxed');
        logLine(`${ref.name} dynamaxed!`, 'l-good');
        announce(`${ref.name} is dynamaxing!`);
        await wait(450);
        return;
      }
      case '-enddynamax': {
        const ref = parseRef(parts[1]);
        const side = state.sides[ref.side];
        if (side.active) side.active.dmax = false;
        elFor(ref.side, 'sprite').classList.remove('dynamaxed');
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
        logLine(`${ref.name} protected itself!`, 'l-major');
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

  // ---------- controls ----------
  function renderControlsWaiting(msg) {
    $('#controls-msg').textContent = msg;
    $('#gimmick-row').innerHTML = '';
    $('#move-grid').innerHTML = '';
    $('#switch-row').innerHTML = '';
  }

  function renderControls() {
    const req = pendingRequest;
    if (!req || state.over) return;
    if (processing) return;
    if (!pendingNeedsAction || req.wait) {
      renderControlsWaiting('Waiting for the opponent…');
      return;
    }
    const moveGrid = $('#move-grid');
    const switchRow = $('#switch-row');
    const gimmickRow = $('#gimmick-row');
    moveGrid.innerHTML = '';
    switchRow.innerHTML = '';
    gimmickRow.innerHTML = '';

    const myTeam = req.side.pokemon;

    if (req.forceSwitch) {
      $('#controls-msg').textContent = 'Choose your next Pokemon.';
      renderSwitchButtons(myTeam, true);
      return;
    }
    if (!req.active) { renderControlsWaiting('Waiting…'); return; }

    $('#controls-msg').textContent = 'What will you do?';

    // gimmick toggles
    const gimmicks = [];
    if (req.active.canTera) gimmicks.push({ id: 'tera', label: `Terastallize · ${req.active.canTera}`, cls: 'g-tera' });
    if (req.active.canMega) gimmicks.push({ id: 'mega', label: 'Mega Evolve', cls: 'g-mega' });
    if (req.active.canZMove) gimmicks.push({ id: 'zmove', label: 'Z-Move', cls: 'g-zmove' });
    if (req.active.canDynamax) gimmicks.push({ id: 'dynamax', label: 'Dynamax', cls: 'g-dynamax' });
    for (const g of gimmicks) {
      gimmickRow.appendChild(el('button', {
        class: `gimmick-btn ${g.cls}${state.gimmick === g.id ? ' on' : ''}`,
        text: g.label,
        onclick: () => {
          state.gimmick = state.gimmick === g.id ? null : g.id;
          AudioMan.play('click');
          renderControls();
        },
      }));
    }

    // move buttons (transformed by active gimmick toggle)
    const useMax = state.gimmick === 'dynamax' || req.active.dynamaxed;
    const useZ = state.gimmick === 'zmove';
    req.active.moves.forEach((m, i) => {
      let label = m.name, type = m.type, bp = m.basePower, disabled = m.disabled;
      if (useMax && req.active.maxMoves && req.active.maxMoves[i]) {
        const mm = req.active.maxMoves[i];
        label = mm.name; type = mm.type; bp = mm.basePower;
      } else if (useZ) {
        const z = req.active.canZMove && req.active.canZMove[i];
        if (z) { label = z.name; type = z.type; bp = z.basePower; }
        else disabled = true;
      }
      const btn = el('button', {
        class: 'move-btn', disabled,
        style: `--type-color:${TYPE_COLORS[type] || '#888'}`,
        onclick: () => {
          AudioMan.play('click');
          const choice = { action: 'move', move: i };
          if (state.gimmick) choice.gimmick = state.gimmick;
          submitChoice(choice);
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

    if (state.showSwitch) renderSwitchButtons(myTeam, false);
    startTimer(req.deadline);
  }

  function renderSwitchButtons(myTeam, force) {
    const switchRow = $('#switch-row');
    switchRow.innerHTML = '';
    myTeam.forEach((p, i) => {
      if (p.active) return;
      const fainted = p.condition.includes('fnt');
      const hpm = p.condition.match(/^(\d+)\/(\d+)/);
      const pct = fainted ? 0 : hpm ? Math.round(+hpm[1] / +hpm[2] * 100) : 100;
      const img = el('img', { src: iconUrl(p.species), alt: '' });
      img.onerror = () => { img.style.visibility = 'hidden'; };
      switchRow.appendChild(el('button', {
        class: 'switch-btn', disabled: fainted,
        onclick: () => {
          AudioMan.play('click');
          submitChoice({ action: 'switch', target: i });
        },
      },
        img,
        el('span', {}, el('div', { text: p.species }), el('div', { class: 'sw-hp', text: fainted ? 'Fainted' : pct + '% HP' })),
      ));
    });
  }

  function submitChoice(choice) {
    state.gimmick = null;
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
      timerEl.textContent = `0:${String(left % 60).padStart(2, '0')}`.replace('0:', Math.floor(left / 60) + ':');
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
  function begin({ roomId, yourSide, players }, callbacks) {
    state = freshState();
    state.roomId = roomId;
    state.mySide = yourSide;
    state.players = players;
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
      $(`#${z}-hud`).hidden = true;
      $(`#${z}-sprite`).classList.add('hidden');
      $(`#${z}-balls`).innerHTML = '';
      $(`#${z}-fx`).innerHTML = '';
    }
    renderControlsWaiting('Battle starting…');
    logLine(`${players[0].name} vs ${players[1].name}`, 'l-turn');
    AudioMan.startMusic();
  }

  function onLog(lines) { enqueue(lines); }

  function onRequest(request, needsAction) {
    pendingRequest = request;
    pendingNeedsAction = needsAction;
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
