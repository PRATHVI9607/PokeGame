// Shared client helpers: sprites, type colors, DOM, toasts, modal.
'use strict';

const TYPE_COLORS = {
  Normal: '#9aa07a', Fire: '#e8853a', Water: '#5d8fe0', Electric: '#e5c12f',
  Grass: '#6cb84e', Ice: '#7fcfca', Fighting: '#bd3835', Poison: '#9a449a',
  Ground: '#d9b25f', Flying: '#9f8fe6', Psychic: '#e66488', Bug: '#a3b031',
  Rock: '#b39d44', Ghost: '#6c5a93', Dragon: '#6d43e8', Dark: '#6c594a',
  Steel: '#a9a9c4', Fairy: '#dd8adc', Stellar: '#5ee0c8',
};

function spriteId(speciesName) {
  return String(speciesName || '')
    .toLowerCase()
    .replace(/[':.%]/g, '')
    .replace(/[\s_]+/g, '')
    .replace(/[^a-z0-9-]/g, '');
}
function spriteUrl(speciesName, { back = false, anim = true } = {}) {
  const id = spriteId(speciesName);
  const dir = anim ? (back ? 'ani-back' : 'ani') : (back ? 'gen5-back' : 'gen5');
  const ext = anim ? 'gif' : 'png';
  return `https://play.pokemonshowdown.com/sprites/${dir}/${id}.${ext}`;
}
function iconUrl(speciesName) {
  return `https://play.pokemonshowdown.com/sprites/gen5/${spriteId(speciesName)}.png`;
}
function cryUrl(speciesName) {
  return `https://play.pokemonshowdown.com/audio/cries/${spriteId(speciesName).split('-')[0]}.mp3`;
}

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (v !== null && v !== undefined && v !== false) node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children) {
    if (c == null) continue;
    node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return node;
}
const $ = (sel) => document.querySelector(sel);

function typePill(type, sm = false) {
  return el('span', {
    class: `type-pill${sm ? ' sm' : ''}`,
    text: type,
    style: `background:${TYPE_COLORS[type] || '#666'}`,
  });
}

function toast(msg, { error = false, actions = null, sticky = false } = {}) {
  const t = el('div', { class: `toast${error ? ' error' : ''}` }, el('div', { text: msg }));
  if (actions) {
    const row = el('div', { class: 'toast-actions' });
    for (const a of actions) {
      row.appendChild(el('button', {
        class: `btn btn-sm ${a.primary ? 'btn-primary' : 'btn-ghost'}`,
        text: a.label,
        onclick: () => { a.onClick && a.onClick(); t.remove(); },
      }));
    }
    t.appendChild(row);
  }
  $('#toast-stack').appendChild(t);
  if (!sticky) setTimeout(() => t.remove(), actions ? 18000 : 5000);
  return t;
}

function openModal(contentNode) {
  const backdrop = $('#modal-backdrop');
  const modal = $('#modal');
  modal.innerHTML = '';
  modal.appendChild(contentNode);
  backdrop.hidden = false;
  return { close: closeModal };
}
function closeModal() { $('#modal-backdrop').hidden = true; }
document.addEventListener('click', (e) => {
  if (e.target === $('#modal-backdrop')) closeModal();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeModal();
});

function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
