// App shell: navigation, lobby socket wiring, challenges, queue, bot battles.
'use strict';

(() => {
  const socket = io();
  let myName = localStorage.getItem('pa_name') || '';
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

  // ---------- name ----------
  function promptName(initial = false) {
    const input = el('input', { class: 'input', placeholder: 'Trainer name', value: myName, maxlength: 18, style: 'width:100%' });
    const join = () => {
      const name = input.value.trim();
      if (!name) return;
      myName = name;
      localStorage.setItem('pa_name', name);
      socket.emit('lobby:join', { name });
      closeModal();
    };
    openModal(el('div', {},
      el('h3', { text: initial ? 'Welcome to PokeArena' : 'Change name' }),
      el('p', { class: 'hint', text: 'Pick a trainer name to enter the lobby.', style: 'margin-top:0' }),
      input,
      el('div', { class: 'modal-actions' },
        el('button', { class: 'btn btn-primary', text: 'Enter lobby', onclick: join }))));
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') join(); });
    setTimeout(() => input.focus(), 50);
  }
  $('#name-chip').addEventListener('click', () => promptName(false));

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
    if (myName) socket.emit('lobby:join', { name: myName });
    else promptName(true);
  });
  socket.on('lobby:joined', ({ name, id }) => {
    myName = name;
    myId = id;
    localStorage.setItem('pa_name', name);
    $('#name-chip').textContent = name;
  });
  socket.on('lobby:state', ({ users }) => {
    lobbyUsers = users;
    renderLobby();
  });
  socket.on('lobby:error', ({ error }) => toast(error, { error: true }));
  socket.on('lobby:declined', ({ byName }) => toast(`${byName} declined your challenge.`));
  socket.on('lobby:challenge-sent', ({ toName }) => toast(`Challenge sent to ${toName}.`));

  socket.on('lobby:challenged', ({ id, fromName, mode }) => {
    AudioMan.play('notify');
    toast(`${fromName} challenges you (${mode === 'team' ? 'custom teams' : 'random teams'})!`, {
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
    openModal(el('div', {},
      el('h3', { text: `Challenge ${user.name}` }),
      el('div', { class: 'field-block' },
        el('label', { class: 'field-label', text: 'Format' }), modeSel),
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
            socket.emit('lobby:challenge', { to: user.id, mode, team });
            closeModal();
          },
        }),
        el('button', { class: 'btn btn-ghost', text: 'Cancel', onclick: closeModal }))));
  }

  // ---------- queue ----------
  let inQueue = false;
  $('#btn-queue').addEventListener('click', () => {
    AudioMan.play('click');
    socket.emit('queue:join', {});
    inQueue = true;
    $('#btn-queue').hidden = true;
    $('#queue-status').hidden = false;
  });
  $('#btn-queue-cancel').addEventListener('click', () => {
    socket.emit('queue:leave');
    resetQueueUI();
  });
  function resetQueueUI() {
    inQueue = false;
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
    socket.emit('bot:start', { mode, team, apiKey });
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
