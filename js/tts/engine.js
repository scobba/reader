/* The speech engine contract.
 *
 * Two implementations ship: the platform's own synthesiser (instant, free,
 * no download) and Piper (a neural model that runs on-device and sounds
 * markedly better). They differ in one way that matters architecturally: the
 * system engine speaks text and tells us when it finished, while Piper
 * *produces audio*, which we play through a real <audio> element — and that
 * is what buys lock-screen controls and playback with the screen off.
 *
 *   speak()   resolves when the sentence has finished being spoken
 *   cancel()  stops immediately; the pending speak() rejects with AbortError
 *   prime()   optional, best-effort: render ahead of playback
 */

export class Engine {
  static id = 'base';
  static label = 'Base';

  get id() { return this.constructor.id; }
  get label() { return this.constructor.label; }
  get description() { return ''; }
  /** True when audio comes out as a media element, i.e. it keeps playing
   *  when the screen locks and gets lock-screen controls. */
  get backgroundCapable() { return false; }
  get needsNetworkFirstRun() { return false; }

  async init() {}
  async voices() { return []; }
  async speak() { throw new Error('not implemented'); }
  cancel() {}
  async prime() {}
  async dispose() {}
}

export const abortError = () => new DOMException('Cancelled', 'AbortError');

/* ═══════════════════════════════════════════════════════ registry ═════ */

const registry = new Map();

export function register(cls) { registry.set(cls.id, cls); }
export function listEngines() { return [...registry.values()]; }
export function getEngineClass(id) { return registry.get(id); }

/* ═══════════════════════════════════════════════════════ audio bits ═══ */

/** FNV-1a. Only used to key the audio cache, so collision resistance beyond
 *  "different sentences get different keys" is not required. */
export function hash(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}

/** Float32 PCM -> a 16-bit WAV blob. Written out by hand because the neural
 *  engine's raw output has to reach an <audio> element somehow, and WAV is
 *  the only container every browser will decode without a codec. */
export function pcmToWav(samples, sampleRate) {
  const n = samples.length;
  const buf = new ArrayBuffer(44 + n * 2);
  const v = new DataView(buf);

  const str = (off, s) => { for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i)); };

  str(0, 'RIFF');
  v.setUint32(4, 36 + n * 2, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  v.setUint32(16, 16, true);        // PCM chunk size
  v.setUint16(20, 1, true);         // format: PCM
  v.setUint16(22, 1, true);         // mono
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true);
  v.setUint16(32, 2, true);         // block align
  v.setUint16(34, 16, true);        // bits per sample
  str(36, 'data');
  v.setUint32(40, n * 2, true);

  let o = 44;
  for (let i = 0; i < n; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    v.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    o += 2;
  }
  return new Blob([buf], { type: 'audio/wav' });
}

/** One shared <audio> element for the whole app. iOS ties background audio
 *  and the lock-screen transport to a media element, and creating a new one
 *  per sentence loses that association. */
let _el = null;
export function audioElement() {
  if (_el) return _el;
  _el = document.getElementById('audio-out') || document.createElement('audio');
  _el.id = 'audio-out';
  _el.playsInline = true;
  _el.preload = 'auto';
  if (!_el.isConnected) document.body.appendChild(_el);
  return _el;
}

/** Play a blob to completion on the shared element. */
export function playBlob(blob, { rate = 1, signal } = {}) {
  const el = audioElement();
  const url = URL.createObjectURL(blob);

  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (fn, arg) => {
      if (settled) return;
      settled = true;
      el.removeEventListener('ended', onEnd);
      el.removeEventListener('error', onErr);
      signal?.removeEventListener('abort', onAbort);
      URL.revokeObjectURL(url);
      fn(arg);
    };
    const onEnd = () => done(resolve);
    const onErr = () => done(reject, new Error('Audio playback failed'));
    const onAbort = () => { el.pause(); done(reject, abortError()); };

    el.addEventListener('ended', onEnd);
    el.addEventListener('error', onErr);
    signal?.addEventListener('abort', onAbort, { once: true });

    if (signal?.aborted) return onAbort();

    el.src = url;
    el.playbackRate = rate;
    // Safari resets preservesPitch on src change; without it a 1.5x read
    // sounds like a chipmunk.
    el.preservesPitch = true;
    el.mozPreservesPitch = true;
    el.webkitPreservesPitch = true;
    el.play().catch(e => done(reject, e));
  });
}
