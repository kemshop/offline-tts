// Offline support. App files are pre-cached; everything else from this site
// (voice runtime, translator runtime) is cached the first time it's used.
// The voice model itself is cached by the voice worker in 'tv-model-1'.
const VERSION = 'v1';
const SHELL = `tv-shell-${VERSION}`;
const RUNTIME = 'tv-runtime';

const SHELL_FILES = [
  './',
  'index.html',
  'manifest.webmanifest',
  'css/app.css',
  'js/app.js',
  'js/thaitext.js',
  'js/translate.js',
  'js/tts-worker.js',
  'data/lexicon.tsv',
  'data/phrasebook.json',
  'data/phrase-audio.json',
  'model/voice.json',
  'fonts/andika-Regular.woff2',
  'fonts/andika-SemiBold.woff2',
  'fonts/ibm-plex-sans-thai-looped-thai-500-normal.woff2',
  'fonts/ibm-plex-sans-thai-looped-thai-600-normal.woff2',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/favicon-48.png',
  'vendor/ort/ort.wasm.min.mjs',
  'vendor/ort/ort-wasm-simd-threaded.mjs',
  'vendor/ort/ort-wasm-simd-threaded.wasm',
];

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const c = await caches.open(SHELL);
    await c.addAll(SHELL_FILES);
    // Pre-rendered phrasebook audio (small) so the phrasebook works offline straight away
    try {
      const idx = await (await fetch('data/phrase-audio.json')).json();
      const urls = Object.values(idx.files).flatMap((f) => [`${f}-n.ogg`, `${f}-s.ogg`]);
      await c.addAll(urls);
    } catch { /* phrasebook audio falls back to the live voice */ }
    await self.skipWaiting();
  })());
});

// Cross-origin isolation lets the voice use several CPU cores (much faster).
// GitHub Pages can't send these headers, so the service worker adds them.
function isolate(res) {
  if (!res || res.status === 0 || res.type === 'opaque' || res.type === 'opaqueredirect') return res;
  const headers = new Headers(res.headers);
  headers.set('Cross-Origin-Embedder-Policy', 'require-corp');
  headers.set('Cross-Origin-Opener-Policy', 'same-origin');
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) {
      if (k.startsWith('tv-shell-') && k !== SHELL) await caches.delete(k);
    }
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // e.g. Hugging Face — the translator caches those itself
  if (url.pathname.includes('/model/') && url.pathname.includes('.part')) return; // worker caches these itself

  e.respondWith(isolate_((async () => {
    const shell = await caches.open(SHELL);
    const hit = (await shell.match(req, { ignoreSearch: true })) || (await caches.match(req, { ignoreSearch: true }));
    if (hit) return hit;
    if (req.mode === 'navigate') {
      const index = await shell.match('index.html');
      try { return await fetch(req); } catch { if (index) return index; throw new Error('offline'); }
    }
    const res = await fetch(req);
    if (res.ok && res.type === 'basic') {
      const copy = res.clone();
      caches.open(RUNTIME).then((c) => c.put(req, copy)).catch(() => {});
    }
    return res;
  })()));
});

async function isolate_(p) { return isolate(await p); }
