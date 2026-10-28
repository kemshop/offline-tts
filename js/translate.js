// Optional on-phone English → Thai translator (Mozilla Firefox Translations,
// ~40 MB). Files come from this site and are cached for offline use by sw.js.
const CACHE = 'tv-translator-1';
let worker = null;
let ready = null;
let isReady = false;
let progressCb = () => {};
const pending = new Map();
let reqId = 0;

export const translatorLoaded = () => isReady;

export function loadTranslator(onProgress = () => {}) {
  progressCb = onProgress;
  if (ready) return ready;
  ready = new Promise((resolve, reject) => {
    worker = new Worker(new URL('./translate-worker.js', import.meta.url));
    worker.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'progress') progressCb(m);
      else if (m.type === 'ready') { isReady = true; resolve(); }
      else if (m.type === 'error') { reject(new Error(m.message)); }
      else if (m.type === 'result') {
        const p = pending.get(m.id); pending.delete(m.id);
        if (p) (m.error ? p.reject(new Error(m.error)) : p.resolve(m.text));
      }
    };
    worker.onerror = (e) => reject(new Error(e.message || 'The translator stopped'));
    worker.postMessage({ type: 'init' });
  });
  ready.catch(() => { ready = null; worker?.terminate(); worker = null; });
  return ready;
}

export async function translate(english) {
  await loadTranslator(progressCb);
  const id = ++reqId;
  const p = new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
  worker.postMessage({ type: 'translate', id, text: english });
  return (await p).trim();
}

export async function removeTranslator() {
  worker?.terminate(); worker = null; ready = null; isReady = false;
  try { await caches.delete(CACHE); } catch { /* ignore */ }
}
