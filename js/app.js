import * as TT from './thaitext.js';
import { translate, loadTranslator, translatorLoaded, removeTranslator } from './translate.js';

const $ = (s) => document.querySelector(s);

// ---------- tiny helpers ----------
function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'html') el.innerHTML = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : String(kid));
  return el;
}
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } },
};
let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg; t.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 2400);
}
const MB = (b) => `${Math.round(b / 1e6)} MB`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ICON = {
  play: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M8 5v14l11-7z"/></svg>',
  stop: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M7 7h10v10H7z"/></svg>',
  slow: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M2.5 15.5a8 7.5 0 0 1 16 0Z"/><circle cx="20.3" cy="12.3" r="2.6" fill="currentColor"/><rect x="4.6" y="14.5" width="3.2" height="4.5" rx="1.2" fill="currentColor"/><rect x="12.8" y="14.5" width="3.2" height="4.5" rx="1.2" fill="currentColor"/></svg>',
  shadow: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 5V2L7 6l5 4V7a5 5 0 1 1-5 5H5a7 7 0 1 0 7-7Z"/></svg>',
  star: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" d="m12 3 2.6 6 6.4.6-4.9 4.2 1.5 6.3L12 16.8 6.4 20l1.5-6.3L3 9.6 9.4 9z"/></svg>',
  starOn: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="m12 3 2.6 6 6.4.6-4.9 4.2 1.5 6.3L12 16.8 6.4 20l1.5-6.3L3 9.6 9.4 9z"/></svg>',
  del: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M9 3h6l1 2h4v2H4V5h4l1-2Zm-3 6h12l-1 12H7L6 9Z"/></svg>',
};
const CONTOUR = {
  1: 'M2 6 H28',
  2: 'M2 7 C10 9 18 10.5 28 10.5',
  3: 'M2 5 C9 0.5 16 1.5 28 11',
  4: 'M2 5 C12 5 20 3.5 28 1',
  5: 'M2 7 C10 11.5 18 10.5 28 1',
};

// ---------- state ----------
const settings = Object.assign({ slow: 1.6, rounds: 3, male: true }, store.get('tv.settings', {}));
let saved = store.get('tv.saved', []);
let phrasebook = { categories: [] };
let translatorInstalled = store.get('tv.translator2', false);

// ---------- voice (worker) ----------
const worker = new Worker(new URL('./tts-worker.js', import.meta.url), { type: 'module' });
let voiceReady = false;
let resolveReady, rejectReady;
const readyP = new Promise((res, rej) => { resolveReady = res; rejectReady = rej; });
readyP.catch(() => {});
const pending = new Map();
let reqId = 0;

worker.onmessage = (e) => {
  const m = e.data;
  if (m.type === 'progress') {
    const pct = m.total ? (m.loaded / m.total) * 100 : 0;
    $('#setupBar').style.width = `${pct.toFixed(1)}%`;
    $('#setupNum').textContent = m.stage === 'starting' ? 'Starting the voice…' : `${MB(m.loaded)} of ${MB(m.total)}`;
  } else if (m.type === 'ready') {
    voiceReady = true; $('#setup').hidden = true; resolveReady();
    try { navigator.storage?.persist?.(); } catch { /* ignore */ }
  } else if (m.type === 'error') {
    $('#setup').hidden = false;
    $('#setup').querySelector('.setup-title').textContent = 'The Thai voice didn’t load';
    $('#setupSub').textContent = `${m.message}. Check your connection, then reopen the app.`;
    rejectReady(new Error(m.message));
  } else if (m.type === 'audio') {
    const p = pending.get(m.id); pending.delete(m.id);
    if (!p) return;
    if (m.error) p.reject(new Error(m.error)); else p.resolve({ audio: m.audio, sampleRate: m.sampleRate });
  }
};
worker.postMessage({ type: 'init' });
setTimeout(() => { if (!voiceReady) $('#setup').hidden = false; }, 700);

// Raw synthesis in the worker (no caching) — also used by tests.
async function synth(thai, lengthScale) {
  await readyP;
  const id = ++reqId;
  const p = new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
  worker.postMessage({ type: 'synth', id, text: TT.normaliseForSpeech(thai), lengthScale });
  return p;
}

// Synthesis with a cache that survives restarts, so saved phrases replay instantly.
const AUDIO_CACHE = 'tv-audio-1';
async function synthCached(text, lengthScale) {
  const url = `__audio/${lengthScale}/${encodeURIComponent(text)}`;
  let cache = null;
  try { cache = await caches.open(AUDIO_CACHE); } catch { /* no Cache API */ }
  const hit = cache && (await cache.match(url));
  if (hit) return { audio: new Float32Array(await hit.arrayBuffer()), sampleRate: +hit.headers.get('x-sample-rate') };
  const out = await synth(text, lengthScale);
  if (cache) cache.put(url, new Response(out.audio.slice(), { headers: { 'x-sample-rate': String(out.sampleRate) } })).catch(() => {});
  return out;
}

// ---------- audio playback ----------
let actx = null;
let current = null; // {src, resolve}
let playToken = 0;
let prerendered = { slow: 1.6, files: {} };
const bufCache = new Map();
const inflight = new Map();

function audioCtx() {
  actx = actx || new (window.AudioContext || window.webkitAudioContext)();
  return actx;
}

async function getBuffer(thai, slow) {
  const ls = slow ? settings.slow : 1;
  const text = TT.normaliseForSpeech(thai);
  const key = `${ls}|${text}`;
  if (bufCache.has(key)) return bufCache.get(key);
  if (!inflight.has(key)) {
    inflight.set(key, (async () => {
      const pre = prerendered.files[thai];
      if (pre && (!slow || Math.abs(settings.slow - prerendered.slow) < 0.01)) {
        try {
          const res = await fetch(`${pre}-${slow ? 's' : 'n'}.ogg`);
          if (res.ok) return await audioCtx().decodeAudioData(await res.arrayBuffer());
        } catch { /* fall back to live voice */ }
      }
      const { audio, sampleRate } = await synthCached(text, ls);
      const buf = audioCtx().createBuffer(1, audio.length, sampleRate);
      buf.copyToChannel(audio, 0);
      return buf;
    })().finally(() => inflight.delete(key)));
  }
  const buf = await inflight.get(key);
  bufCache.set(key, buf);
  if (bufCache.size > 120) bufCache.delete(bufCache.keys().next().value);
  return buf;
}

function stopAudio() {
  playToken++;
  if (current) { try { current.src.stop(); } catch { /* already stopped */ } current.resolve(false); current = null; }
}
async function play(thai, { slow = false } = {}) {
  stopAudio();
  const my = ++playToken;
  const ctx = audioCtx();
  if (ctx.state === 'suspended') await ctx.resume();
  const buf = await getBuffer(thai, slow);
  if (my !== playToken) return { done: false, duration: buf.duration };
  stopAudio();
  const src = ctx.createBufferSource();
  src.buffer = buf; src.connect(ctx.destination);
  return new Promise((resolve) => {
    current = { src, resolve };
    src.onended = () => { if (current?.src === src) { current = null; resolve(true); } };
    src.start();
  }).then((done) => ({ done, duration: buf.duration }));
}

// ---------- romanisation view ----------
function romanView(thai, { contours = true } = {}) {
  const wrap = h('span', { class: 'roman', 'aria-label': TT.romanPlain(thai) });
  for (const w of TT.romanise(thai)) {
    if (!w.syls) {
      wrap.append(h('span', { class: w.punct ? 'word' : 'unknown', title: 'No pronunciation on file' }, w.punct ? w.raw : w.thai));
      continue;
    }
    const word = h('span', { class: 'word', 'aria-hidden': 'true' });
    w.syls.forEach((s, i) => {
      if (i) word.append(h('span', { class: 'sep' }, '-'));
      const syl = h('span', { class: `syl tone-${s.tone}`, title: `${TT.TONE_NAME[s.tone]} tone` }, h('b', {}, s.text));
      if (contours) syl.append(h('span', { html: `<svg viewBox="0 0 30 12"><path d="${CONTOUR[s.tone]}"/></svg>` }).firstChild);
      word.append(syl);
    });
    wrap.append(word);
  }
  return wrap;
}

// ---------- phrase matching ----------
const norm = (s) => s.toLowerCase().replace(/[’']/g, '').replace(/[^a-z0-9\s/]/g, ' ').replace(/\s+/g, ' ').trim();
function variants(en) {
  return en.split(/\/|\(|\)|,/).map(norm).filter(Boolean).concat(norm(en));
}
function score(query, en) {
  const q = norm(query);
  if (!q) return 0;
  let best = 0;
  for (const v of variants(en)) {
    if (v === q) return 1;
    const a = new Set(q.split(' ')), b = new Set(v.split(' '));
    let inter = 0; for (const x of a) if (b.has(x)) inter++;
    best = Math.max(best, inter / (a.size + b.size - inter));
  }
  return best;
}
function allPhrases() {
  const list = [];
  for (const c of phrasebook.categories) for (const p of c.phrases) list.push({ ...p, from: 'phrasebook' });
  for (const p of saved) list.push({ ...p, from: 'saved' });
  return list;
}
function findMatches(query) {
  return allPhrases().map((p) => ({ p, s: score(query, p.en || '') })).filter((x) => x.s > 0.25).sort((a, b) => b.s - a.s);
}
const findByThai = (th) => allPhrases().find((p) => p.th.replace(/\s/g, '') === th.replace(/\s/g, ''));
const isSaved = (th) => saved.some((p) => p.th === th);

// ---------- saving ----------
function persistSaved() { store.set('tv.saved', saved); renderSaved(); }
function toggleSave(p) {
  if (isSaved(p.th)) { saved = saved.filter((x) => x.th !== p.th); toast('Removed from Saved'); }
  else { saved.unshift({ en: p.en || '', th: p.th, note: p.note, at: Date.now() }); toast('Saved'); }
  persistSaved();
}

// ---------- speak tab ----------
let shadowToken = 0;

function renderResult(r) {
  const box = $('#result');
  box.replaceChildren();
  $('#hint').hidden = true;
  const btn = (cls, icon, label, onclick) => h('button', { class: `ctl ${cls}`, type: 'button', onclick, html: `${icon}<span>${label}</span>` });
  const playBtn = btn('play', ICON.play, 'Play', async () => { cancelShadow(); await safePlay(r.th, false, playBtn); });
  const slowBtn = btn('', ICON.slow, 'Slow', async () => { cancelShadow(); await safePlay(r.th, true, slowBtn); });
  const shadowBtn = btn('', ICON.shadow, 'Shadow', () => runShadow(r.th, shadowBtn));
  const saveBtn = btn(isSaved(r.th) ? 'saved' : '', isSaved(r.th) ? ICON.starOn : ICON.star, isSaved(r.th) ? 'Saved' : 'Save', () => {
    toggleSave(r);
    const on = isSaved(r.th);
    saveBtn.classList.toggle('saved', on);
    saveBtn.innerHTML = `${on ? ICON.starOn : ICON.star}<span>${on ? 'Saved' : 'Save'}</span>`;
  });
  box.append(h('div', { class: 'result' },
    r.source ? h('p', { class: 'src' }, r.source) : null,
    h('p', { class: 'thai-big', lang: 'th' }, r.th),
    romanView(r.th),
    r.en ? h('p', { class: 'meaning' }, `“${r.en}”`) : null,
    r.note ? h('p', { class: 'note' }, r.note) : null,
    r.warn ? h('span', { class: 'badge' }, r.warn) : null,
    h('div', { class: 'controls' }, playBtn, slowBtn, shadowBtn, saveBtn),
    h('div', { class: 'turn', id: 'turn', hidden: true }, h('p', { id: 'turnText' }, ''), h('div', { class: 'bar' }, h('div', { class: 'bar-fill', id: 'turnBar' }))),
  ));
  if (r.alts?.length) box.append(alternatives(r.alts));
}

async function safePlay(th, slow, btn) {
  btn?.classList.add('active');
  try {
    if (!voiceReady) toast('The voice is still loading…');
    return await play(th, { slow });
  } catch (err) {
    toast(`Couldn’t play that: ${err.message}`);
    return { done: false, duration: 0 };
  } finally { btn?.classList.remove('active'); }
}

function cancelShadow() { shadowToken++; const t = document.getElementById('turn'); if (t) t.hidden = true; stopAudio(); }
async function runShadow(th, btn) {
  const my = ++shadowToken;
  const turn = $('#turn'), text = $('#turnText'), bar = $('#turnBar');
  btn.classList.add('active');
  try {
    for (let round = 1; round <= settings.rounds; round++) {
      if (my !== shadowToken) return;
      turn.hidden = false; text.textContent = `Listen (${round} of ${settings.rounds})`; bar.style.transition = 'none'; bar.style.width = '0%';
      const { done, duration } = await safePlay(th, round === 1, null);
      if (!done || my !== shadowToken) return;
      text.textContent = 'Your turn — say it out loud';
      const wait = duration * 1300 + 900;
      void bar.offsetWidth;
      bar.style.transition = `width ${wait}ms linear`; bar.style.width = '100%';
      await sleep(wait);
    }
    if (my === shadowToken) { text.textContent = 'Nice. Go again any time.'; bar.style.transition = 'none'; }
  } finally { btn.classList.remove('active'); }
}

function alternatives(list) {
  return h('div', { class: 'alts' }, h('h3', {}, 'Close matches'), list.slice(0, 4).map((x) => phraseItem(x.p)));
}

async function onSay(e) {
  e?.preventDefault();
  const raw = $('#input').value.trim();
  const text = TT.hasThai(raw) ? TT.cleanThai(raw) : raw;
  if (!text) { $('#input').focus(); return; }
  cancelShadow();
  if (TT.hasThai(text)) {
    const known = findByThai(text);
    renderResult({ th: text, en: known?.en, note: known?.note, source: known ? 'From your phrases' : 'Your Thai' });
    safePlay(text, false, document.querySelector('.ctl.play'));
    return;
  }
  const matches = findMatches(text);
  if (matches[0] && matches[0].s >= 0.75) {
    const p = matches[0].p;
    renderResult({ ...p, source: p.from === 'saved' ? 'From Saved' : 'From the phrasebook', alts: matches.slice(1).filter((m) => m.s >= 0.4) });
    safePlay(p.th, false, document.querySelector('.ctl.play'));
    return;
  }
  if (!translatorInstalled) {
    $('#hint').hidden = true;
    $('#result').replaceChildren(h('div', { class: 'msg' },
      h('p', {}, 'That isn’t in your phrases yet.'),
      h('p', {}, 'To type any English, download the offline translator (about 40 MB, once). Or ask Claude for the Thai and import it into Saved.'),
      h('div', { class: 'row-actions' }, h('button', { class: 'ghost', type: 'button', onclick: () => { openSettings(); installTranslator(); } }, 'Download translator')),
    ));
    if (matches.length) $('#result').append(alternatives(matches));
    return;
  }
  const sayBtn = $('#sayBtn');
  sayBtn.disabled = true;
  const status = h('div', { class: 'msg' }, h('p', {}, translatorLoaded() ? 'Translating…' : 'Loading the translator (first time after opening takes a little while)…'));
  $('#result').replaceChildren(status);
  try {
    let th = TT.cleanThai(await translate(text));
    if (settings.male) th = TT.maleSpeech(th);
    renderResult({ th, en: text, source: 'Offline translator', warn: 'Machine translation — check important things with a native speaker', alts: matches });
    safePlay(th, false, document.querySelector('.ctl.play'));
  } catch (err) {
    const offline = /fetch|network/i.test(err.message);
    status.replaceChildren(h('p', {}, offline
      ? 'Couldn’t load the translator files. If the download never finished, connect to Wi-Fi and try again.'
      : `The translator hit a problem: ${err.message}`));
  } finally { sayBtn.disabled = false; }
}

// ---------- lists ----------
function phraseItem(p, { deletable = false } = {}) {
  const playing = h('button', { class: 'mini', type: 'button', 'aria-label': 'Play slowly', html: ICON.slow });
  const main = h('button', { class: 'item-main', type: 'button' },
    h('span', { class: 'th', lang: 'th' }, p.th),
    h('span', { class: 'rm' }, romanView(p.th, { contours: false })),
    p.en ? h('span', { class: 'en' }, p.en) : null,
  );
  main.addEventListener('click', () => { cancelShadow(); safePlay(p.th, false, null); });
  main.addEventListener('dblclick', () => { $('#input').value = p.en || p.th; showTab('speak'); renderResult({ ...p, source: 'From your phrases' }); });
  playing.addEventListener('click', async () => { cancelShadow(); playing.classList.add('playing'); await safePlay(p.th, true, null); playing.classList.remove('playing'); });
  const second = deletable
    ? h('button', { class: 'mini', type: 'button', 'aria-label': 'Delete', html: ICON.del, onclick: () => { if (confirm(`Delete “${p.en || p.th}”?`)) { saved = saved.filter((x) => x.th !== p.th); persistSaved(); } } })
    : h('button', { class: 'mini', type: 'button', 'aria-label': isSaved(p.th) ? 'Remove from Saved' : 'Save', html: isSaved(p.th) ? ICON.starOn : ICON.star, onclick: (e) => { toggleSave(p); e.currentTarget.innerHTML = isSaved(p.th) ? ICON.starOn : ICON.star; } });
  return h('div', { class: 'item' }, main, h('div', { class: 'item-btns' }, playing, second));
}

function renderPhrases() {
  const q = $('#filter').value.trim().toLowerCase();
  const list = $('#phraseList');
  list.replaceChildren();
  let shown = 0;
  for (const c of phrasebook.categories) {
    const items = c.phrases.filter((p) => !q || p.en.toLowerCase().includes(q) || p.th.includes(q) || TT.romanPlain(p.th).includes(q));
    if (!items.length) continue;
    shown += items.length;
    list.append(h('h2', { class: 'cat' }, c.name), ...items.map((p) => phraseItem(p)));
  }
  if (!shown) list.append(h('p', { class: 'empty' }, `No phrases match “${q}”.`));
}

function renderSaved() {
  const list = $('#savedList');
  list.replaceChildren();
  if (!saved.length) {
    list.append(h('p', { class: 'empty' }, 'Nothing saved yet. Tap the star on any phrase, or import phrases from Claude.'));
    return;
  }
  list.append(...saved.map((p) => phraseItem(p, { deletable: true })));
}

function importPhrases(text) {
  let added = 0;
  for (const line of text.split('\n')) {
    const parts = line.split('|').map((s) => s.trim()).filter(Boolean);
    if (parts.length < 2) continue;
    const th = parts.find((s) => TT.hasThai(s));
    const en = parts.find((s) => !TT.hasThai(s)) || '';
    if (!th || isSaved(th)) continue;
    saved.push({ en, th, at: Date.now() });
    added++;
  }
  persistSaved();
  toast(added ? `Imported ${added} phrase${added === 1 ? '' : 's'}` : 'Nothing new to import');
}

// ---------- tabs ----------
function showTab(name) {
  cancelShadow();
  for (const b of document.querySelectorAll('.tabs button')) b.classList.toggle('on', b.dataset.tab === name);
  for (const s of document.querySelectorAll('.tab')) s.hidden = s.id !== `tab-${name}`;
  window.scrollTo(0, 0);
}

// ---------- settings ----------
function openSettings() {
  $('#slowRange').value = settings.slow; $('#slowVal').textContent = `${settings.slow}× slower`;
  $('#shadowRange').value = settings.rounds; $('#shadowVal').textContent = `${settings.rounds} rounds`;
  $('#maleToggle').checked = settings.male;
  renderTranslatorStatus();
  navigator.storage?.estimate?.().then((e) => { $('#storageInfo').textContent = `Using ${MB(e.usage || 0)} on this phone.`; }).catch(() => {});
  $('#settings').showModal();
}
function saveSettings() { store.set('tv.settings', settings); }

function renderTranslatorStatus(msg) {
  const st = $('#trStatus');
  $('#trInstall').hidden = translatorInstalled;
  $('#trRemove').hidden = !translatorInstalled;
  st.textContent = msg || (translatorInstalled
    ? 'Downloaded. You can type English anywhere, even offline.'
    : 'Lets you type any English sentence offline. About 40 MB. Its Thai is plainer than the phrasebook.');
}

async function installTranslator() {
  if (!confirm('Download the translator now? About 40 MB.')) return;
  try { await navigator.storage?.persist?.(); } catch { /* ignore */ }
  $('#trInstall').disabled = true; $('#trBarWrap').hidden = false;
  renderTranslatorStatus('Downloading…');
  try {
    await loadTranslator(({ loaded, total }) => {
      if (total) { $('#trBar').style.width = `${(loaded / total) * 100}%`; $('#trStatus').textContent = `Downloading… ${MB(loaded)} of ${MB(total)}`; }
    });
    translatorInstalled = true; store.set('tv.translator2', true);
    renderTranslatorStatus(); toast('Translator ready');
  } catch (err) {
    renderTranslatorStatus(`Download stopped: ${err.message}. Tap download to try again.`);
  } finally { $('#trInstall').disabled = false; $('#trBarWrap').hidden = true; }
}

// ---------- legend ----------
function renderLegend() {
  const eg = { 1: 'kun', 2: 'nʉ̀ng', 3: 'mâi', 4: 'rák', 5: 'pǒm' };
  $('#legend').replaceChildren(...[1, 2, 3, 4, 5].map((t) => h('div', { class: `syl tone-${t}` },
    h('b', {}, eg[t]),
    h('span', { html: `<svg viewBox="0 0 30 12"><path d="${CONTOUR[t]}"/></svg>` }).firstChild,
    h('small', {}, TT.TONE_NAME[t]),
  )));
}

// ---------- boot ----------
async function boot() {
  for (const b of document.querySelectorAll('.tabs button')) b.addEventListener('click', () => showTab(b.dataset.tab));
  $('#speakForm').addEventListener('submit', onSay);
  for (const c of document.querySelectorAll('.chip')) c.addEventListener('click', () => { $('#input').value = c.textContent; onSay(); });
  $('#input').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); onSay(); } });
  $('#filter').addEventListener('input', renderPhrases);
  $('#settingsBtn').addEventListener('click', openSettings);
  $('#slowRange').addEventListener('input', (e) => { settings.slow = +(+e.target.value).toFixed(1); $('#slowVal').textContent = `${settings.slow}× slower`; saveSettings(); });
  $('#shadowRange').addEventListener('input', (e) => { settings.rounds = +e.target.value; $('#shadowVal').textContent = `${settings.rounds} rounds`; saveSettings(); });
  $('#maleToggle').addEventListener('change', (e) => { settings.male = e.target.checked; saveSettings(); });
  $('#trInstall').addEventListener('click', installTranslator);
  $('#trRemove').addEventListener('click', async () => {
    if (!confirm('Remove the translator from this phone? You can download it again later.')) return;
    await removeTranslator(); translatorInstalled = false; store.set('tv.translator2', false); renderTranslatorStatus(); toast('Translator removed');
  });
  $('#importBtn').addEventListener('click', () => { $('#importText').value = ''; $('#importDlg').showModal(); });
  $('#importDlg').addEventListener('close', () => { if ($('#importDlg').returnValue === 'import') importPhrases($('#importText').value); });
  $('#exportBtn').addEventListener('click', async () => {
    const text = saved.map((p) => `${p.en} | ${p.th}`).join('\n');
    try { await navigator.clipboard.writeText(text); toast('Copied your saved phrases'); } catch { toast('Couldn’t copy — your browser blocked it'); }
  });
  let deferredInstall = null;
  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferredInstall = e; $('#installBtn').hidden = false; });
  $('#installBtn').addEventListener('click', async () => { if (!deferredInstall) return; deferredInstall.prompt(); await deferredInstall.userChoice; deferredInstall = null; $('#installBtn').hidden = true; });

  if ('serviceWorker' in navigator) {
    // When an update takes over, reload once so the new version is what's on screen
    const hadController = !!navigator.serviceWorker.controller;
    let reloaded = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (hadController && !reloaded) { reloaded = true; location.reload(); }
    });
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
  // Clean up the old 900 MB translator (v1) if it's still on the phone
  try { caches.delete('transformers-cache'); } catch { /* ignore */ }

  const [lex, pb, pre] = await Promise.all([
    fetch('data/lexicon.tsv').then((r) => r.text()),
    fetch('data/phrasebook.json').then((r) => r.json()),
    fetch('data/phrase-audio.json').then((r) => r.json()).catch(() => null),
  ]);
  if (pre) prerendered = pre;
  TT.loadLexiconText(lex);
  phrasebook = pb;
  renderLegend();
  renderPhrases();
  renderSaved();
}
boot().catch((err) => toast(`Startup problem: ${err.message}`));

// expose for testing
window.__tv = { synth, play, getBuffer, TT, get voiceReady() { return voiceReady; } };
