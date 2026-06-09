// Audio: WebAudio-synthesized SFX, Pokemon cries (Showdown CDN) and looping
// battle music. Everything respects the mute toggle.
'use strict';

const AudioMan = (() => {
  let ctx = null;
  let muted = localStorage.getItem('pa_muted') === '1';
  let music = null;
  let musicWanted = false;

  const MUSIC_TRACKS = [
    'https://play.pokemonshowdown.com/audio/dpp-trainer.mp3',
    'https://play.pokemonshowdown.com/audio/bw-trainer.mp3',
    'https://play.pokemonshowdown.com/audio/xy-trainer.mp3',
    'https://play.pokemonshowdown.com/audio/sm-trainer.mp3',
    'https://play.pokemonshowdown.com/audio/bw-subway-trainer.mp3',
    'https://play.pokemonshowdown.com/audio/oras-trainer.mp3',
  ];

  function ac() {
    if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }

  function env(node, t0, attack, decay, peak = 1) {
    node.gain.setValueAtTime(0.0001, t0);
    node.gain.exponentialRampToValueAtTime(peak, t0 + attack);
    node.gain.exponentialRampToValueAtTime(0.0001, t0 + attack + decay);
  }

  function osc(type, freq, t0, dur, peak, freqEnd) {
    const a = ac();
    const o = a.createOscillator();
    const g = a.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t0);
    if (freqEnd) o.frequency.exponentialRampToValueAtTime(freqEnd, t0 + dur);
    env(g, t0, 0.01, dur, peak);
    o.connect(g).connect(a.destination);
    o.start(t0); o.stop(t0 + dur + 0.1);
  }

  function noise(t0, dur, peak, freq = 800) {
    const a = ac();
    const len = Math.floor(a.sampleRate * dur);
    const buf = a.createBuffer(1, len, a.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / len);
    const src = a.createBufferSource();
    src.buffer = buf;
    const filter = a.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = freq;
    const g = a.createGain();
    env(g, t0, 0.005, dur, peak);
    src.connect(filter).connect(g).connect(a.destination);
    src.start(t0);
  }

  const SFX = {
    click() { const t = ac().currentTime; osc('square', 660, t, 0.06, 0.12, 880); },
    hit() { const t = ac().currentTime; noise(t, 0.18, 0.5, 900); osc('sine', 150, t, 0.16, 0.5, 60); },
    supereffective() {
      const t = ac().currentTime;
      noise(t, 0.3, 0.65, 1600); osc('sine', 220, t, 0.25, 0.6, 50);
      osc('sawtooth', 880, t + 0.04, 0.12, 0.18, 440);
    },
    resisted() { const t = ac().currentTime; noise(t, 0.12, 0.25, 500); },
    faint() { const t = ac().currentTime; osc('sawtooth', 320, t, 0.55, 0.35, 55); osc('sine', 180, t + 0.05, 0.5, 0.3, 40); },
    heal() {
      const t = ac().currentTime;
      [523, 659, 784, 1046].forEach((f, i) => osc('sine', f, t + i * 0.09, 0.18, 0.22));
    },
    boost() { const t = ac().currentTime; osc('sine', 300, t, 0.25, 0.25, 900); },
    unboost() { const t = ac().currentTime; osc('sine', 900, t, 0.25, 0.25, 300); },
    status() { const t = ac().currentTime; osc('triangle', 440, t, 0.14, 0.3, 330); osc('triangle', 330, t + 0.15, 0.18, 0.3, 250); },
    gimmick() {
      const t = ac().currentTime;
      noise(t, 0.4, 0.3, 2400);
      [440, 554, 659, 880, 1108].forEach((f, i) => osc('sine', f, t + i * 0.07, 0.3, 0.22));
    },
    win() {
      const t = ac().currentTime;
      [523, 659, 784, 1046, 784, 1046].forEach((f, i) => osc('square', f, t + i * 0.13, 0.22, 0.14));
    },
    lose() {
      const t = ac().currentTime;
      [392, 370, 349, 330].forEach((f, i) => osc('square', f, t + i * 0.2, 0.3, 0.14));
    },
    notify() { const t = ac().currentTime; osc('sine', 880, t, 0.12, 0.2); osc('sine', 1108, t + 0.13, 0.16, 0.2); },
  };

  function play(name) {
    if (muted) return;
    try { SFX[name] && SFX[name](); } catch { /* audio blocked */ }
  }

  function cry(speciesName) {
    if (muted) return;
    try {
      const a = new Audio(cryUrl(speciesName));
      a.volume = 0.5;
      a.play().catch(() => {});
    } catch { /* ignore */ }
  }

  function startMusic() {
    musicWanted = true;
    if (muted) return;
    if (music) { music.play().catch(() => {}); return; }
    music = new Audio(MUSIC_TRACKS[Math.floor(Math.random() * MUSIC_TRACKS.length)]);
    music.loop = true;
    music.volume = 0.22;
    music.play().catch(() => { music = null; });
  }
  function stopMusic() {
    musicWanted = false;
    if (music) { music.pause(); music = null; }
  }

  function setMuted(m) {
    muted = m;
    localStorage.setItem('pa_muted', m ? '1' : '0');
    if (m && music) { music.pause(); music = null; }
    else if (!m && musicWanted) startMusic();
  }
  function isMuted() { return muted; }

  return { play, cry, startMusic, stopMusic, setMuted, isMuted };
})();
