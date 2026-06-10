// App shell: navigation, accounts (register/login), lobby socket wiring,
// challenges, queue, bot battles, cloud team sync.
'use strict';

(() => {
  const socket = io();
  let myName = localStorage.getItem('pa_name') || '';
  let myToken = localStorage.getItem('pa_token') || '';
  let myAccount = null; // username when logged in
  let myId = null;
  let lobbyUsers = [];

  // ---------- navigation ----------
  function showScreen(id) {
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    $(`#screen-${id}`).classList.add('active');
    document.querySelectorAll('.tab').forEach(t =>
      t.classList.toggle('active', t.dataset.screen === id));
  }
  document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
      if (BattleUI.isActive() && tab.dataset.screen !== 'battle') {
        toast('You are in a battle. Forfeit first to leave.', { error: true });
        return;
      }
      showScreen(tab.dataset.screen);
    });
  });
  $('#brand-home').addEventListener('click', () => {
    if (!BattleUI.isActive()) showScreen('home');
  });

  // ---------- account / name ----------
  async function api(path, opts = {}) {
    const headers = Object.assign({ 'Content-Type': 'application/json' }, opts.headers);
    if (myToken) headers.Authorization = 'Bearer ' + myToken;
    const res = await fetch(path, Object.assign({}, opts, { headers }));
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  }

  function joinLobby() {
    socket.emit('lobby:join', { name: myName, token: myToken || undefined });
  }

  async function handleAuthSuccess(data) {
    myToken = data.token;
    myAccount = data.username;
    myName = data.username;
    localStorage.setItem('pa_token', myToken);
    localStorage.setItem('pa_name', myName);
    joinLobby();
    closeModal();
    toast(`Logged in as ${myAccount}. Your teams now sync to your account.`);
    await syncTeamsOnLogin();
  }

  function logout() {
    myToken = '';
    myAccount = null;
    localStorage.removeItem('pa_token');
    Teambuilder.setSyncHandler(null);
    joinLobby();
    closeModal();
    toast('Logged out. Teams stay saved in this browser.');
  }

  function authField(label, type, placeholder) {
    const input = el('input', { class: 'input', type, placeholder, autocomplete: 'off', style: 'width:100%' });
    return { block: el('div', { class: 'field-block', style: 'margin-bottom:10px' }, el('label', { class: 'field-label', text: label }), input), input };
  }

  function openAccountModal(initial = false) {
    if (myAccount) {
      openModal(el('div', {},
        el('h3', { text: myAccount }),
        el('p', { class: 'hint', text: 'Teams are synced to your account on this server.' }),
        el('div', { class: 'modal-actions' },
          el('button', { class: 'btn btn-danger-ghost', text: 'Log out', onclick: logout }),
          el('button', { class: 'btn btn-ghost', text: 'Close', onclick: closeModal }))));
      return;
    }
    // three ways in: guest name / login / register
    const guest = authField('Play as guest', 'text', 'Trainer name');
    guest.input.value = myName;
    const guestBtn = el('button', {
      class: 'btn btn-primary', text: 'Enter lobby',
      onclick: () => {
        const name = guest.input.value.trim();
        if (!name) { guest.input.style.borderColor = 'var(--danger)'; guest.input.focus(); return; }
        myName = name;
        localStorage.setItem('pa_name', name);
        joinLobby();
        closeModal();
      },
    });

    const user = authField('Username', 'text', '3-18 characters');
    const pass = authField('Password', 'password', '8+ characters');
    const err = el('p', { class: 'hint', style: 'color:var(--danger);min-height:18px;margin:4px 0' });
    const doAuth = async (path) => {
      err.textContent = '';
      try {
        const data = await api(path, {
          method: 'POST',
          body: JSON.stringify({ username: user.input.value.trim(), password: pass.input.value }),
        });
        await handleAuthSuccess(data);
      } catch (e) {
        err.textContent = e.message;
      }
    };

    openModal(el('div', {},
      el('h3', { text: initial ? 'Welcome to PokeArena' : 'Account' }),
      guest.block, guestBtn,
      el('hr', { style: 'border:none;border-top:1px solid var(--line);margin:18px 0' }),
      el('p', { class: 'hint', text: 'Or use an account to save teams to the server and keep your name.', style: 'margin-top:0' }),
      user.block, pass.block, err,
      el('div', { class: 'modal-actions', style: 'justify-content:flex-start' },
        el('button', { class: 'btn btn-primary', text: 'Log in', onclick: () => doAuth('/api/auth/login') }),
        el('button', { class: 'btn btn-ghost', text: 'Create account', onclick: () => doAuth('/api/auth/register') }))));
    setTimeout(() => guest.input.focus(), 50);
  }
  $('#name-chip').addEventListener('click', () => openAccountModal(false));

  // ---------- cloud team sync ----------
  const pushTeams = debounce(async () => {
    if (!myToken) return;
    try {
      await api('/api/teams', { method: 'PUT', body: JSON.stringify({ teams: Teambuilder.getTeams() }) });
    } catch { /* offline or expired token: local copy still saved */ }
  }, 1500);

  async function syncTeamsOnLogin() {
    try {
      const { teams } = await api('/api/teams');
      if (teams && teams.length) {
        Teambuilder.replaceAll(teams);
        toast('Loaded your saved teams from the server.');
      } else {
        await api('/api/teams', { method: 'PUT', body: JSON.stringify({ teams: Teambuilder.getTeams() }) });
      }
      Teambuilder.setSyncHandler(pushTeams);
    } catch (e) {
      toast('Team sync failed: ' + e.message, { error: true });
    }
  }

  // ---------- audio toggle ----------
  function renderAudioIcon() {
    $('#audio-on-icon').hidden = AudioMan.isMuted();
    $('#audio-off-icon').hidden = !AudioMan.isMuted();
  }
  $('#audio-toggle').addEventListener('click', () => {
    AudioMan.setMuted(!AudioMan.isMuted());
    renderAudioIcon();
    if (!AudioMan.isMuted()) AudioMan.play('click');
  });
  renderAudioIcon();

  // ---------- lobby ----------
  socket.on('connect', () => {
    if (myName || myToken) joinLobby();
    else openAccountModal(true);
  });
  socket.on('lobby:joined', ({ name, id, registered }) => {
    myName = name;
    myId = id;
    if (registered) myAccount = name;
    else myAccount = null;
    localStorage.setItem('pa_name', name);
    $('#name-chip').textContent = name + (registered ? ' ✓' : '');
    if (registered && !Teambuilder.hasSyncHandler()) syncTeamsOnLogin();
  });
  socket.on('lobby:state', ({ users }) => {
    lobbyUsers = users;
    renderLobby();
  });
  socket.on('lobby:error', ({ error }) => toast(error, { error: true }));
  socket.on('lobby:declined', ({ byName }) => toast(`${byName} declined your challenge.`));
  socket.on('lobby:challenge-sent', ({ toName }) => toast(`Challenge sent to ${toName}.`));

  socket.on('lobby:challenged', ({ id, fromName, mode, gameType }) => {
    AudioMan.play('notify');
    const fmt = `${gameType === 'doubles' ? 'doubles' : 'singles'}, ${mode === 'team' ? 'custom teams' : 'random teams'}`;
    toast(`${fromName} challenges you (${fmt})!`, {
      sticky: true,
      actions: [
        {
          label: 'Accept', primary: true,
          onClick: () => {
            const team = mode === 'team' ? Teambuilder.getCurrentTeamSets() : undefined;
            if (mode === 'team' && (!team || !team.length)) {
              toast('Build a team first in the Teambuilder.', { error: true });
              socket.emit('lobby:decline', { id });
              return;
            }
            socket.emit('lobby:accept', { id, team });
          },
        },
        { label: 'Decline', onClick: () => socket.emit('lobby:decline', { id }) },
      ],
    });
  });

  function renderLobby() {
    const list = $('#user-list');
    list.innerHTML = '';
    const others = lobbyUsers.filter(u => u.id !== myId);
    $('#online-count').textContent = lobbyUsers.length;
    $('#empty-lobby').hidden = others.length > 0;
    for (const u of others) {
      const row = el('li', { class: `user-row${u.status === 'battle' ? ' in-battle' : ''}` },
        el('span', { class: 'u-name', text: u.name }),
        u.registered ? el('span', { class: 'u-badge', text: 'reg' }) : null,
        el('span', { class: 'u-status', text: u.status === 'battle' ? 'in battle' : u.status === 'queue' ? 'queueing' : 'online' }),
      );
      if (u.status === 'lobby') {
        row.appendChild(el('button', {
          class: 'btn btn-ghost btn-sm', text: 'Challenge',
          onclick: () => openChallengeModal(u),
        }));
      }
      list.appendChild(row);
    }
  }

  function openChallengeModal(user) {
    const modeSel = el('select', { class: 'input', style: 'width:100%' },
      el('option', { value: 'random', text: 'Random teams' }),
      el('option', { value: 'team', text: 'My team vs their team' }));
    const fmtSel = el('select', { class: 'input', style: 'width:100%' },
      el('option', { value: 'singles', text: 'Singles' }),
      el('option', { value: 'doubles', text: 'Doubles' }));
    openModal(el('div', {},
      el('h3', { text: `Challenge ${user.name}` }),
      el('div', { class: 'field-block', style: 'margin-bottom:10px' },
        el('label', { class: 'field-label', text: 'Teams' }), modeSel),
      el('div', { class: 'field-block' },
        el('label', { class: 'field-label', text: 'Format' }), fmtSel),
      el('div', { class: 'modal-actions' },
        el('button', {
          class: 'btn btn-primary', text: 'Send challenge',
          onclick: () => {
            const mode = modeSel.value;
            const team = mode === 'team' ? Teambuilder.getCurrentTeamSets() : undefined;
            if (mode === 'team' && (!team || !team.length)) {
              toast('Build a team first in the Teambuilder.', { error: true });
              return;
            }
            socket.emit('lobby:challenge', { to: user.id, mode, team, gameType: fmtSel.value });
            closeModal();
          },
        }),
        el('button', { class: 'btn btn-ghost', text: 'Cancel', onclick: closeModal }))));
  }

  // ---------- queue ----------
  $('#btn-queue').addEventListener('click', () => {
    AudioMan.play('click');
    socket.emit('queue:join', { gameType: $('#queue-format').value });
    $('#btn-queue').hidden = true;
    $('#queue-status').hidden = false;
  });
  $('#btn-queue-cancel').addEventListener('click', () => {
    socket.emit('queue:leave');
    resetQueueUI();
  });
  function resetQueueUI() {
    $('#btn-queue').hidden = false;
    $('#queue-status').hidden = true;
  }

  // ---------- bot battle ----------
  const savedKey = localStorage.getItem('pa_gemini_key') || '';
  $('#gemini-key').value = savedKey;
  $('#btn-bot').addEventListener('click', () => {
    AudioMan.play('click');
    const apiKey = $('#gemini-key').value.trim();
    localStorage.setItem('pa_gemini_key', apiKey);
    const mode = $('#bot-mode').value;
    const team = mode === 'team' ? Teambuilder.getCurrentTeamSets() : undefined;
    if (mode === 'team' && (!team || !team.length)) {
      toast('Build a team first in the Teambuilder.', { error: true });
      return;
    }
    socket.emit('bot:start', { mode, team, apiKey, gameType: $('#bot-format').value });
  });

  // ---------- battle wiring ----------
  BattleUI.bindStatic({
    forfeit: (roomId) => socket.emit('battle:forfeit', { roomId }),
    chat: (roomId, msg) => socket.emit('battle:chat', { roomId, msg }),
  });

  socket.on('battle:start', (data) => {
    resetQueueUI();
    closeModal();
    BattleUI.begin(data, {
      sendChoice: (choice) => socket.emit('battle:choice', { roomId: data.roomId, choice }),
      onLeave: (roomId) => {
        socket.emit('battle:leave', { roomId });
        showScreen('home');
      },
      onRematch: (roomId) => socket.emit('battle:rematch', { roomId }),
    });
    showScreen('battle');
  });
  socket.on('battle:log', ({ roomId, lines }) => {
    if (roomId === BattleUI.roomId()) BattleUI.onLog(lines);
  });
  socket.on('battle:request', ({ roomId, request, needsAction }) => {
    if (roomId === BattleUI.roomId()) BattleUI.onRequest(request, needsAction);
  });
  socket.on('battle:chat', ({ from, msg }) => BattleUI.onChat(from, msg));
  socket.on('battle:error', ({ error }) => toast(error, { error: true }));
  socket.on('battle:end', () => { /* result overlay is driven by the |win| line */ });
  socket.on('battle:rematch-status', () => toast('Rematch requested. Waiting for both sides…'));

  socket.on('disconnect', () => {
    toast('Connection lost. Reconnecting…', { error: true });
    resetQueueUI();
  });

  // ---------- init ----------
  $('#name-chip').textContent = myName || 'Set name';
  Teambuilder.init().catch(e => {
    console.error(e);
    toast('Failed to load Pokemon data. Refresh to retry.', { error: true });
  });
})();
