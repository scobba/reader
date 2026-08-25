/* Piper synthesis, off the main thread.
 *
 * vits-web runs inference inline despite what its docstring claims — there is
 * no Worker anywhere in the package. Synthesising a sentence is hundreds of
 * milliseconds of solid compute, so calling it directly would freeze the
 * sentence highlighting and the scroll on every sentence. Everything is
 * therefore driven from here instead.
 *
 * OPFS, where the voice models live, is also happier in a worker: the
 * synchronous access handles are worker-only, and Safari's implementation is
 * better exercised there.
 *
 * Protocol: {id, op, ...args} in, {id, ok, result|error} out, plus
 * {id, progress:{loaded,total,url}} while a model downloads.
 */

import * as vits from '../../vendor/piper/vits-web.js';

const reply = (id, ok, payload) =>
  self.postMessage(ok ? { id, ok: true, result: payload } : { id, ok: false, error: payload });

self.onmessage = async (e) => {
  const { id, op, args = {} } = e.data || {};
  try {
    switch (op) {
      case 'ping':
        // Proves the module graph, the ONNX runtime path and the phonemiser
        // path all resolved, without downloading a 60 MB voice.
        reply(id, true, { ok: true });
        break;

      case 'stored':
        reply(id, true, await vits.stored());
        break;

      case 'download':
        await vits.download(args.voiceId, (p) => {
          self.postMessage({ id, progress: { loaded: p.loaded, total: p.total, url: p.url } });
        });
        reply(id, true, true);
        break;

      case 'remove':
        await vits.remove(args.voiceId);
        reply(id, true, true);
        break;

      case 'flush':
        await vits.flush();
        reply(id, true, true);
        break;

      case 'predict': {
        const blob = await vits.predict(
          { text: args.text, voiceId: args.voiceId },
          (p) => self.postMessage({ id, progress: { loaded: p.loaded, total: p.total, url: p.url } }),
        );
        // Hand back an ArrayBuffer so it can be transferred rather than
        // structured-cloned; a sentence of audio is a few hundred kilobytes.
        const buf = await blob.arrayBuffer();
        self.postMessage({ id, ok: true, result: { buf, type: blob.type } }, [buf]);
        break;
      }

      default:
        reply(id, false, `Unknown op: ${op}`);
    }
  } catch (err) {
    reply(id, false, (err && (err.message || String(err))) || 'Piper worker failed');
  }
};

// Surface load-time failures (a missing vendored file, an OPFS refusal) rather
// than letting the first request hang forever.
self.postMessage({ id: '__ready', ok: true, result: { ready: true } });
