// Optional on-phone English → Thai translator (NLLB-200 distilled 600M, 8-bit).
// Downloaded once from Hugging Face (~900 MB) and kept in the browser cache.
const MODEL = 'Xenova/nllb-200-distilled-600M';
let pipe = null;
let loading = null;

export const translatorLoaded = () => !!pipe;

export function loadTranslator(onProgress = () => {}) {
  if (pipe) return Promise.resolve(pipe);
  if (loading) return loading;
  loading = (async () => {
    const { pipeline, env } = await import('../vendor/transformers/transformers.min.js');
    env.allowLocalModels = false;
    env.useBrowserCache = true;
    env.backends.onnx.wasm.wasmPaths = new URL('../vendor/transformers/', import.meta.url).href;
    env.backends.onnx.wasm.numThreads = 1;
    const files = new Map();
    pipe = await pipeline('translation', MODEL, {
      dtype: 'q8',
      device: 'wasm',
      progress_callback: (p) => {
        if (p.status === 'progress' && p.file) {
          files.set(p.file, { loaded: p.loaded || 0, total: p.total || 0 });
          let loaded = 0, total = 0;
          for (const f of files.values()) { loaded += f.loaded; total += f.total; }
          onProgress({ loaded, total });
        }
      },
    });
    return pipe;
  })();
  loading.catch(() => { loading = null; });
  return loading;
}

export async function translate(english) {
  const p = await loadTranslator();
  const out = await p(english, { src_lang: 'eng_Latn', tgt_lang: 'tha_Thai', max_new_tokens: 200 });
  return (out[0]?.translation_text || '').trim();
}

export async function removeTranslator() {
  pipe = null; loading = null;
  try { await caches.delete('transformers-cache'); } catch { /* ignore */ }
}
