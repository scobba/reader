/* Service worker.
 *
 * Two tiers on purpose:
 *   CORE  — the app shell plus pdf.js. Precached on install (~2.5 MB) so the
 *           app opens and parses PDFs on a plane the first time you try.
 *   HEAVY — the OCR engine and its 10 MB language model. Far too big to force
 *           on everyone, so it is cached opportunistically the first time you
 *           actually OCR something, and served from cache forever after.
 *
 * Bump VERSION whenever any precached file changes; the old cache is dropped
 * on activate.
 */
const VERSION = 'v1.1.2';
const CORE  = `reader-core-${VERSION}`;
const HEAVY = 'reader-heavy';        // deliberately unversioned: assets are
                                     // immutable, keyed by their own filename

const CORE_ASSETS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/app.css',
  './js/main.js',
  './js/compat.js',
  './js/diag.js',
  './js/config.js',
  './js/core/db.js',
  './js/core/settings.js',
  './js/core/zip.js',
  './js/core/player.js',
  './js/core/ingest.js',
  './js/extract/index.js',
  './js/extract/pdf.js',
  './js/extract/layout.js',
  './js/extract/html.js',
  './js/extract/epub.js',
  './js/extract/docx.js',
  './js/extract/text.js',
  './js/extract/ocr.js',
  './js/clean/normalize.js',
  './js/clean/abbrev.js',
  './js/clean/segment.js',
  './js/clean/structure.js',
  './js/tts/engine.js',
  './js/tts/manager.js',
  './js/tts/system.js',
  './js/tts/piper.js',
  './js/tts/piper-worker.js',
  './js/ui/library.js',
  './js/ui/reader.js',
  './js/ui/dialogs.js',
  './js/ui/toast.js',
  './vendor/pdfjs/pdf.min.mjs',
  './vendor/pdfjs/pdf.worker.min.mjs',
  './icons/icon.svg',
  './icons/icon-180.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const cache = await caches.open(CORE);
    // Individually, so one 404 (e.g. a missing optional icon) cannot abort the
    // whole install the way cache.addAll would.
    await Promise.all(CORE_ASSETS.map(async (url) => {
      try {
        const res = await fetch(new Request(url, { cache: 'reload' }));
        if (res.ok) await cache.put(url, res);
      } catch { /* offline during install; runtime cache will pick it up */ }
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(
      keys.filter(k => k.startsWith('reader-core-') && k !== CORE)
          .map(k => caches.delete(k))
    );
    await self.clients.claim();
  })());
});

self.addEventListener('message', (e) => {
  if (e.data === 'skipWaiting') self.skipWaiting();
});

/* Large optional runtimes. Vendored so they work offline, but far too big to
 * force on every install, so they are cached the first time they are actually
 * used: ~25 MB of OCR engine, and ~38 MB of Piper (the espeak pronunciation
 * data plus the ONNX WebAssembly builds). Voice models are not here — those
 * live in the Origin Private File System, managed by the Piper engine. */
const isHeavy = (url) =>
  url.pathname.includes('/vendor/tesseract/') ||
  url.pathname.includes('/vendor/piper/') ||
  url.pathname.includes('/vendor/onnxruntime/') ||
  url.pathname.includes('/vendor/pdfjs/standard_fonts/');

/* On localhost the cache-first strategy below would serve yesterday's code
 * every time you edit a file, which turns every change into a debugging
 * session about caching. Development runs network-first instead; deployed
 * origins are unaffected. */
const DEV = ['localhost', '127.0.0.1', '[::1]'].includes(self.location.hostname);

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // Never touch cross-origin traffic: article fetches must stay live, and the
  // Piper voice download is stored in OPFS by the engine rather than here.
  if (url.origin !== self.location.origin) return;

  // Navigations: network first so a redeploy is picked up, cache as fallback.
  if (req.mode === 'navigate') {
    e.respondWith((async () => {
      try {
        const fresh = await fetch(req);
        const cache = await caches.open(CORE);
        cache.put('./index.html', fresh.clone());
        return fresh;
      } catch {
        return (await caches.match('./index.html')) ||
               (await caches.match('./')) ||
               Response.error();
      }
    })());
    return;
  }

  // Everything else: cache first. All of it is versioned or immutable.
  e.respondWith((async () => {
    if (DEV) {
      try { return await fetch(req); } catch { /* fall through to cache */ }
    }
    const hit = await caches.match(req, { ignoreSearch: false });
    if (hit) return hit;
    try {
      const res = await fetch(req);
      if (res.ok && (res.type === 'basic' || res.type === 'default')) {
        const target = isHeavy(url) ? HEAVY : CORE;
        const cache = await caches.open(target);
        cache.put(req, res.clone());
      }
      return res;
    } catch (err) {
      return new Response('Offline and not cached', { status: 504, statusText: 'Offline' });
    }
  })());
});
