// Team builder: localStorage teams, species/move/item search against the dex
// API, EV/IV/nature editing, Showdown paste import/export.
'use strict';

const Teambuilder = (() => {
  const STORE_KEY = 'pa_teams';
  let teams = [];
  let currentTeamId = null;
  let currentSlot = -1;
  let pokedex = null;          // [{id,name,num,types,baseStats,abilities,nfe}]
  let items = null;
  let natures = null;
  const speciesDetailCache = new Map();

  const STAT_NAMES = { hp: 'HP', atk: 'Atk', def: 'Def', spa: 'SpA', spd: 'SpD', spe: 'Spe' };
  const TYPES = ['Normal','Fire','Water','Electric','Grass','Ice','Fighting','Poison','Ground','Flying','Psychic','Bug','Rock','Ghost','Dragon','Dark','Steel','Fairy'];

  // ---------- persistence ----------
  function load() {
    try { teams = JSON.parse(localStorage.getItem(STORE_KEY)) || []; } catch { teams = []; }
    if (!Array.isArray(teams)) teams = [];
    if (!teams.length) {
      teams.push({ id: Date.now(), name: 'My first team', sets: [null, null, null, null, null, null] });
    }
    currentTeamId = teams[0].id;
  }
  function save() { localStorage.setItem(STORE_KEY, JSON.stringify(teams)); }
  function team() { return teams.find(t => t.id === currentTeamId); }

  // ---------- data ----------
  async function ensureData() {
    if (!pokedex) pokedex = await (await fetch('/api/pokedex')).json();
    if (!items) items = await (await fetch('/api/items')).json();
    if (!natures) natures = await (await fetch('/api/natures')).json();
  }
  async function speciesDetail(id) {
    if (!speciesDetailCache.has(id)) {
      const res = await fetch(`/api/species/${id}`);
      if (!res.ok) return null;
      speciesDetailCache.set(id, await res.json());
    }
    return speciesDetailCache.get(id);
  }

  function blankSet(species) {
    return {
      species: species.name, level: 100, ability: species.abilities[0] || '',
      item: 'Leftovers', nature: 'Serious',
      evs: { hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0 },
      ivs: { hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31 },
      moves: [], teraType: species.types[0],
    };
  }

  // stat preview (same formulas as the engine)
  function calcStat(stat, base, iv, ev, level, nature) {
    if (stat === 'hp') return base === 1 ? 1 : Math.floor((2 * base + iv + Math.floor(ev / 4)) * level / 100) + level + 10;
    let v = Math.floor((2 * base + iv + Math.floor(ev / 4)) * level / 100) + 5;
    const nat = natures[nature] || {};
    if (nat.plus === stat) v = Math.floor(v * 1.1);
    if (nat.minus === stat) v = Math.floor(v * 0.9);
    return v;
  }

  // ---------- rendering ----------
  function renderTeamList() {
    const ul = $('#team-list');
    ul.innerHTML = '';
    for (const t of teams) {
      const count = t.sets.filter(Boolean).length;
      ul.appendChild(el('li', {
        class: `team-row${t.id === currentTeamId ? ' active' : ''}`,
        onclick: () => { currentTeamId = t.id; currentSlot = -1; renderAll(); },
      },
        el('span', { text: t.name || 'Unnamed team' }),
        el('span', { class: 't-count', text: `${count}/6` }),
      ));
    }
  }

  function renderSlots() {
    const t = team();
    $('#team-name').value = t.name;
    const row = $('#slot-row');
    row.innerHTML = '';
    t.sets.forEach((set, i) => {
      const card = el('div', {
        class: `slot-card${i === currentSlot ? ' active' : ''}`,
        onclick: () => { currentSlot = i; renderAll(); },
      });
      if (set) {
        const img = el('img', { src: iconUrl(set.species), alt: set.species, loading: 'lazy' });
        img.onerror = () => { img.style.visibility = 'hidden'; };
        card.appendChild(img);
        card.appendChild(el('div', { class: 's-name', text: set.species }));
        const entry = pokedex && pokedex.find(p => p.name === set.species);
        if (entry) {
          const tp = el('div', { class: 'slot-types' });
          entry.types.forEach(ty => tp.appendChild(typePill(ty, true)));
          card.appendChild(tp);
        }
      } else {
        card.appendChild(el('div', { class: 's-empty', text: '+' }));
        card.appendChild(el('div', { class: 's-name', text: `Slot ${i + 1}` }));
      }
      row.appendChild(card);
    });
  }

  function searchBox({ placeholder, value, onSearch, onPick, renderItem }) {
    const input = el('input', { class: 'input', placeholder, value: value || '', autocomplete: 'off', spellcheck: 'false' });
    const results = el('div', { class: 'search-results', hidden: true });
    const wrap = el('div', { class: 'search-wrap' }, input, results);
    let entries = [];
    const update = debounce(() => {
      const q = input.value.trim().toLowerCase();
      entries = q ? onSearch(q) : [];
      results.innerHTML = '';
      results.hidden = entries.length === 0;
      for (const entry of entries.slice(0, 40)) {
        const item = renderItem(entry);
        item.addEventListener('click', () => {
          results.hidden = true;
          onPick(entry, input);
        });
        results.appendChild(item);
      }
    }, 120);
    input.addEventListener('input', update);
    input.addEventListener('focus', update);
    input.addEventListener('blur', () => setTimeout(() => { results.hidden = true; }, 180));
    return wrap;
  }

  async function renderEditor() {
    const editor = $('#slot-editor');
    const t = team();
    editor.innerHTML = '';
    if (currentSlot < 0) {
      editor.appendChild(el('p', { class: 'hint', text: 'Select a slot above to edit a Pokemon.' }));
      return;
    }
    await ensureData();
    const set = t.sets[currentSlot];

    // species search always shown
    const speciesSearch = searchBox({
      placeholder: 'Search species…',
      value: set ? set.species : '',
      onSearch: (q) => pokedex.filter(p => p.name.toLowerCase().includes(q)).slice(0, 60),
      renderItem: (p) => {
        const img = el('img', { src: iconUrl(p.name), loading: 'lazy' });
        img.onerror = () => { img.style.visibility = 'hidden'; };
        const bst = Object.values(p.baseStats).reduce((a, b) => a + b, 0);
        return el('div', { class: 'search-item' }, img,
          el('span', { text: p.name }),
          el('span', { class: 'si-sub', text: `${p.types.join('/')} · BST ${bst}` }));
      },
      onPick: (p, input) => {
        input.value = p.name;
        t.sets[currentSlot] = blankSet(p);
        save(); renderAll();
      },
    });
    const headRow = el('div', { class: 'field-block' },
      el('label', { class: 'field-label', text: 'Pokemon' }), speciesSearch);
    editor.appendChild(headRow);

    if (!set) return;
    const entry = pokedex.find(p => p.name === set.species);
    const detail = await speciesDetail(spriteId(set.species));
    if (!entry || !detail) return;

    const grid = el('div', { class: 'editor-grid', style: 'margin-top:18px' });
    const colL = el('div', { class: 'editor-col' });
    const colR = el('div', { class: 'editor-col' });
    grid.append(colL, colR);
    editor.appendChild(grid);

    // --- left column: ability / item / nature / level / tera / moves ---
    const abilitySel = el('select', { class: 'input' });
    for (const ab of entry.abilities) {
      abilitySel.appendChild(el('option', { value: ab, text: ab, selected: ab === set.ability }));
    }
    abilitySel.addEventListener('change', () => { set.ability = abilitySel.value; save(); });
    colL.appendChild(el('div', { class: 'field-block' }, el('label', { class: 'field-label', text: 'Ability' }), abilitySel));

    const itemSearch = searchBox({
      placeholder: 'Search items…',
      value: set.item,
      onSearch: (q) => items.filter(i => i.name.toLowerCase().includes(q)),
      renderItem: (i) => el('div', { class: 'search-item' },
        el('span', { text: i.name }),
        el('span', { class: 'si-sub', text: i.megaStone ? 'Mega Stone' : i.zMoveType ? `Z: ${i.zMoveType}` : '' })),
      onPick: (i, input) => { input.value = i.name; set.item = i.name; save(); },
    });
    colL.appendChild(el('div', { class: 'field-block' }, el('label', { class: 'field-label', text: 'Item' }), itemSearch));

    const natureSel = el('select', { class: 'input' });
    for (const [name, n] of Object.entries(natures)) {
      const suffix = n.plus ? ` (+${STAT_NAMES[n.plus]} -${STAT_NAMES[n.minus]})` : ' (neutral)';
      natureSel.appendChild(el('option', { value: name, text: name + suffix, selected: name === set.nature }));
    }
    natureSel.addEventListener('change', () => { set.nature = natureSel.value; save(); renderEditor(); });

    const levelInput = el('input', { class: 'input', type: 'number', min: 1, max: 100, value: set.level });
    levelInput.addEventListener('change', () => {
      set.level = Math.max(1, Math.min(100, +levelInput.value || 100));
      save(); renderEditor();
    });

    const teraSel = el('select', { class: 'input' });
    for (const ty of TYPES) teraSel.appendChild(el('option', { value: ty, text: ty, selected: ty === set.teraType }));
    teraSel.addEventListener('change', () => { set.teraType = teraSel.value; save(); });

    const triple = el('div', { style: 'display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px' },
      el('div', { class: 'field-block' }, el('label', { class: 'field-label', text: 'Nature' }), natureSel),
      el('div', { class: 'field-block' }, el('label', { class: 'field-label', text: 'Level' }), levelInput),
      el('div', { class: 'field-block' }, el('label', { class: 'field-label', text: 'Tera type' }), teraSel),
    );
    colL.appendChild(triple);

    // moves
    const movesBlock = el('div', { class: 'field-block' }, el('label', { class: 'field-label', text: 'Moves' }));
    const movesRow = el('div', { class: 'move-input-row' });
    for (let mi = 0; mi < 4; mi++) {
      const box = searchBox({
        placeholder: `Move ${mi + 1}`,
        value: set.moves[mi] || '',
        onSearch: (q) => detail.moves.filter(m => m.name.toLowerCase().includes(q)),
        renderItem: (m) => el('div', { class: 'search-item' },
          typePill(m.type, true),
          el('span', { text: m.name }),
          el('span', { class: 'si-sub', text: `${m.category === 'Status' ? 'Status' : 'BP ' + m.basePower} · ${m.accuracy}%`.replace('—%', 'always hits') })),
        onPick: (m, input) => { input.value = m.name; set.moves[mi] = m.name; save(); },
      });
      const input = box.querySelector('input');
      input.addEventListener('change', () => {
        if (!input.value.trim()) { set.moves[mi] = undefined; set.moves = set.moves.filter(Boolean); save(); }
      });
      movesRow.appendChild(box);
    }
    movesBlock.appendChild(movesRow);
    colL.appendChild(movesBlock);

    // --- right column: EVs/IVs + stat preview ---
    const evBlock = el('div', { class: 'field-block' });
    const evTotal = el('span', { class: 'ev-total' });
    evBlock.appendChild(el('label', { class: 'field-label' }, 'EVs ', evTotal));
    const statEls = {};
    const updateTotals = () => {
      const total = Object.values(set.evs).reduce((a, b) => a + (+b || 0), 0);
      evTotal.textContent = `${total} / 510`;
      evTotal.classList.toggle('over', total > 510);
      for (const s of Object.keys(STAT_NAMES)) {
        statEls[s].textContent = calcStat(s, entry.baseStats[s], set.ivs[s], set.evs[s], set.level, set.nature);
      }
    };
    for (const s of Object.keys(STAT_NAMES)) {
      const range = el('input', { type: 'range', min: 0, max: 252, step: 4, value: set.evs[s] });
      const num = el('input', { class: 'input ev-num', type: 'number', min: 0, max: 252, value: set.evs[s] });
      const statVal = el('span', { class: 'stat-val mono' });
      statEls[s] = statVal;
      const sync = (v) => {
        v = Math.max(0, Math.min(252, +v || 0));
        set.evs[s] = v; range.value = v; num.value = v;
        save(); updateTotals();
      };
      range.addEventListener('input', () => sync(range.value));
      num.addEventListener('change', () => sync(num.value));
      evBlock.appendChild(el('div', { class: 'ev-row' },
        el('label', { text: STAT_NAMES[s] }), range, num, statVal));
    }
    colR.appendChild(evBlock);
    updateTotals();

    // IVs (collapsed)
    const ivDetails = el('details', {},
      el('summary', { class: 'field-label', style: 'cursor:pointer', text: 'IVs (advanced)' }));
    const ivGrid = el('div', { style: 'display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-top:8px' });
    for (const s of Object.keys(STAT_NAMES)) {
      const num = el('input', { class: 'input', type: 'number', min: 0, max: 31, value: set.ivs[s], title: STAT_NAMES[s] });
      num.addEventListener('change', () => {
        set.ivs[s] = Math.max(0, Math.min(31, +num.value || 0));
        save(); updateTotals();
      });
      ivGrid.appendChild(el('div', {},
        el('label', { class: 'field-label', text: STAT_NAMES[s] }), num));
    }
    ivDetails.appendChild(ivGrid);
    colR.appendChild(ivDetails);

    // remove button
    colR.appendChild(el('button', {
      class: 'btn btn-danger-ghost', text: 'Remove from team', style: 'margin-top:auto',
      onclick: () => { t.sets[currentSlot] = null; save(); renderAll(); },
    }));
  }

  async function renderAll() {
    renderTeamList();
    renderSlots();
    await renderEditor();
  }

  // ---------- Showdown paste import/export ----------
  function exportSet(set) {
    let out = set.species;
    if (set.item) out += ` @ ${set.item}`;
    out += '\n';
    if (set.ability) out += `Ability: ${set.ability}\n`;
    if (set.level && set.level !== 100) out += `Level: ${set.level}\n`;
    if (set.teraType) out += `Tera Type: ${set.teraType}\n`;
    const evParts = Object.entries(set.evs || {}).filter(([, v]) => v > 0)
      .map(([s, v]) => `${v} ${STAT_NAMES[s]}`);
    if (evParts.length) out += `EVs: ${evParts.join(' / ')}\n`;
    if (set.nature && set.nature !== 'Serious') out += `${set.nature} Nature\n`;
    const ivParts = Object.entries(set.ivs || {}).filter(([, v]) => v < 31)
      .map(([s, v]) => `${v} ${STAT_NAMES[s]}`);
    if (ivParts.length) out += `IVs: ${ivParts.join(' / ')}\n`;
    for (const m of set.moves || []) out += `- ${m}\n`;
    return out;
  }
  function exportTeam(t) {
    return t.sets.filter(Boolean).map(exportSet).join('\n');
  }
  function parseStatList(str) {
    const out = {};
    const rev = Object.fromEntries(Object.entries(STAT_NAMES).map(([k, v]) => [v.toLowerCase(), k]));
    for (const part of str.split('/')) {
      const m = part.trim().match(/^(\d+)\s+(\w+)$/);
      if (m && rev[m[2].toLowerCase()]) out[rev[m[2].toLowerCase()]] = +m[1];
    }
    return out;
  }
  function importPaste(text) {
    const sets = [];
    for (const block of text.replace(/\r/g, '').split(/\n\s*\n/)) {
      const lines = block.split('\n').map(l => l.trim()).filter(Boolean);
      if (!lines.length) continue;
      let head = lines[0];
      // strip nickname: "Nick (Species) @ item"
      const nickMatch = head.match(/^.*?\(([^()]+)\)\s*(@.*)?$/);
      let species, item = '';
      const atIdx = head.indexOf(' @ ');
      if (atIdx >= 0) { item = head.slice(atIdx + 3).trim(); head = head.slice(0, atIdx); }
      const nm = head.match(/^.*?\(([^()]+)\)\s*$/);
      species = nm ? nm[1].trim() : head.replace(/\((M|F)\)/g, '').trim();
      if (nickMatch && !nm && nickMatch[1] !== 'M' && nickMatch[1] !== 'F') species = nickMatch[1].trim();
      const set = {
        species, item, ability: '', nature: 'Serious', level: 100,
        evs: { hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0 },
        ivs: { hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31 },
        moves: [], teraType: undefined,
      };
      for (const line of lines.slice(1)) {
        if (line.startsWith('Ability:')) set.ability = line.slice(8).trim();
        else if (line.startsWith('Level:')) set.level = +line.slice(6).trim() || 100;
        else if (line.startsWith('Tera Type:')) set.teraType = line.slice(10).trim();
        else if (line.startsWith('EVs:')) Object.assign(set.evs, parseStatList(line.slice(4)));
        else if (line.startsWith('IVs:')) Object.assign(set.ivs, parseStatList(line.slice(4)));
        else if (line.endsWith(' Nature')) set.nature = line.replace(' Nature', '').trim();
        else if (line.startsWith('- ')) set.moves.push(line.slice(2).trim());
      }
      if (set.species) sets.push(set);
    }
    return sets.slice(0, 6);
  }

  // ---------- public actions ----------
  function getCurrentTeamSets() {
    const t = team();
    return t ? t.sets.filter(Boolean) : [];
  }
  function getTeams() { return teams; }

  function bindUI() {
    $('#btn-new-team').addEventListener('click', () => {
      const t = { id: Date.now(), name: `Team ${teams.length + 1}`, sets: [null, null, null, null, null, null] };
      teams.push(t); currentTeamId = t.id; currentSlot = -1;
      save(); renderAll();
    });
    $('#btn-delete-team').addEventListener('click', () => {
      if (teams.length <= 1) { toast('Keep at least one team.', { error: true }); return; }
      teams = teams.filter(t => t.id !== currentTeamId);
      currentTeamId = teams[0].id; currentSlot = -1;
      save(); renderAll();
    });
    $('#team-name').addEventListener('input', (e) => {
      team().name = e.target.value; save(); renderTeamList();
    });
    $('#btn-random-fill').addEventListener('click', async () => {
      const sets = await (await fetch('/api/randomteam')).json();
      const t = team();
      t.sets = sets.concat([null, null, null, null, null, null]).slice(0, 6);
      currentSlot = -1;
      save(); renderAll();
      toast('Random team generated.');
    });
    $('#btn-export').addEventListener('click', () => {
      const ta = el('textarea', { class: 'input', readonly: true });
      ta.value = exportTeam(team());
      openModal(el('div', {},
        el('h3', { text: 'Export team' }),
        ta,
        el('div', { class: 'modal-actions' },
          el('button', {
            class: 'btn btn-primary', text: 'Copy',
            onclick: () => { navigator.clipboard.writeText(ta.value); toast('Copied to clipboard.'); },
          }),
          el('button', { class: 'btn btn-ghost', text: 'Close', onclick: closeModal }))));
      ta.select();
    });
    $('#btn-import').addEventListener('click', () => {
      const ta = el('textarea', { class: 'input', placeholder: 'Paste a Showdown team here…' });
      openModal(el('div', {},
        el('h3', { text: 'Import team' }),
        ta,
        el('div', { class: 'modal-actions' },
          el('button', {
            class: 'btn btn-primary', text: 'Import',
            onclick: () => {
              const sets = importPaste(ta.value);
              if (!sets.length) { toast('Nothing to import.', { error: true }); return; }
              const t = team();
              t.sets = sets.concat([null, null, null, null, null, null]).slice(0, 6);
              currentSlot = -1;
              save(); renderAll(); closeModal();
              toast(`Imported ${sets.length} Pokemon.`);
            },
          }),
          el('button', { class: 'btn btn-ghost', text: 'Cancel', onclick: closeModal }))));
    });
    $('#btn-validate').addEventListener('click', async () => {
      const sets = getCurrentTeamSets();
      if (!sets.length) { toast('Team is empty.', { error: true }); return; }
      const res = await (await fetch('/api/validateteam', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ team: sets }),
      })).json();
      if (res.ok) toast('Team is battle ready.');
      else toast(res.errors.join('\n'), { error: true });
    });
  }

  async function init() {
    load();
    bindUI();
    await ensureData();
    await renderAll();
  }

  return { init, getCurrentTeamSets, getTeams, renderAll };
})();
