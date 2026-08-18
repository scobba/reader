import { Engine, register, abortError, pcmToWav, playBlob, hash } from './engine.js';
import { KOKORO } from '../config.js';
import { audio as audioStore } from '../core/db.js';

/* Kokoro-82M: a small neural TTS model that runs entirely on-device.
 *
 * Why it is worth the trouble: it sounds better than any free system voice,
 * and because it emits real audio samples we can play them through an
 * <audio> element — which means the lock-screen transport works and playback
 * survives the screen turning off. The system engine cannot do either.
 *
 * The costs are real and worth stating plainly:
 *   - the model is ~86 MB and has to be fetched once, online
 *   - inference on a phone is roughly real time, so it renders ahead of
 *     playback rather than on demand, and every sentence is cached in
 *     IndexedDB so a document is only ever rendered once
 *
 * "Prepare offline audio" in the document menu renders a whole article up
 * front, which is the mode this engine is really for: do it on wifi, then
 * listen anywhere with nothing but cached audio.
 */

const FALLBACK_VOICES = [
  ['af_heart',   'Heart — US female',    'en-US'],
  ['af_bella',   'Bella — US female',    'en-US'],
  ['af_nicole',  'Nicole — US female',   'en-US'],
  ['af_sarah',   'Sarah — US female',    'en-US'],
  ['af_sky',     'Sky — US female',      'en-US'],
  ['am_michael', 'Michael — US male',    'en-US'],
  ['am_adam',    'Adam — US male',       'en-US'],
  ['am_eric',    'Eric — US male',       'en-US'],
  ['am_puck',    'Puck — US male',       'en-US'],
  ['bf_emma',    'Emma — UK female',     'en-GB'],
  ['bf_isabella','Isabella — UK female', 'en-GB'],
  ['bm_george',  'George — UK male',     'en-GB'],
  ['bm_daniel',  'Daniel — UK male',     'en-GB'],
];

const DEFAULT_VOICE = 'af_heart';

export class KokoroEngine extends Engine {
  static id = 'kokoro';
  static label = 'Neural voice (on-device)';

  #tts = null;
  #loading = null;
  #queue = Promise.resolve();
  #primed = new Set();

  get description() {
    return 'A neural voice that runs on your device. Clearly better than the built-in voices, ' +
           'and the only option that keeps playing with the screen locked. Downloads about 86 MB ' +
           'the first time — do that on wifi. Rendering is slow on phones, so use ' +
           '“Prepare offline audio” before you leave.';
  }

  get backgroundCapable() { return true; }
  get needsNetworkFirstRun() { return true; }

  static available() {
    // The model runs on WebAssembly; everything else is standard.
    return typeof WebAssembly !== 'undefined';
  }

  /** @param {(pct:number, label:string)=>void} [onProgress] */
  async init(onProgress) {
    if (this.#tts) return;
    if (this.#loading) return this.#loading;

    this.#loading = (async () => {
      let mod;
      try {
        mod = await import(/* @vite-ignore */ KOKORO.lib);
      } catch {
        throw new Error(
          'Could not load the neural voice. It needs an internet connection the first time. ' +
          'Switch to the device voice to keep reading offline.');
      }

      const KokoroTTS = mod.KokoroTTS || mod.default?.KokoroTTS;
      if (!KokoroTTS) throw new Error('The neural voice package did not load correctly');

      const seen = new Map();
      this.#tts = await KokoroTTS.from_pretrained(KOKORO.model, {
        dtype: KOKORO.dtype,
        device: 'wasm',
        progress_callback: (p) => {
          if (!onProgress) return;
          if (p.status === 'progress' && p.file) {
            seen.set(p.file, { loaded: p.loaded || 0, total: p.total || 0 });
            let loaded = 0, total = 0;
            for (const v of seen.values()) { loaded += v.loaded; total += v.total; }
            if (total > 0) {
              onProgress(Math.min(99, Math.round(loaded / total * 100)),
                         `Downloading voice model — ${fmtMB(loaded)} of ${fmtMB(total)}`);
            }
          } else if (p.status === 'ready' || p.status === 'done') {
            onProgress(100, 'Voice model ready');
          }
        },
      });
    })();

    try { await this.#loading; } finally { this.#loading = null; }
  }

  async voices() {
    const list = [];
    try {
      const raw = this.#tts?.voices;
      if (raw && typeof raw === 'object') {
        for (const [id, v] of Object.entries(raw)) {
          list.push({
            id,
            label: v?.name ? `${v.name}${v.gender ? ' — ' + v.gender : ''}` : id,
            lang: v?.language === 'en-gb' ? 'en-GB' : 'en-US',
          });
        }
      }
    } catch { /* fall through to the static list */ }

    if (!list.length) {
      for (const [id, label, lang] of FALLBACK_VOICES) list.push({ id, label, lang });
    }
    return list;
  }

  #cacheKey(text, voice, docId) {
    return `${docId || 'x'}:${hash(text)}:${voice}`;
  }

  /** Render one sentence, using the cache when we already have it. */
  async #render(text, voice, docId, signal) {
    const key = this.#cacheKey(text, voice, docId);

    const cached = await audioStore.get(key).catch(() => null);
    if (cached) return cached;
    if (signal?.aborted) throw abortError();

    await this.init();

    // ONNX runs one session; serialise so lookahead and playback do not fight
    // over it and end up interleaved.
    const blob = await (this.#queue = this.#queue.then(async () => {
      if (signal?.aborted) throw abortError();
      const out = await this.#tts.generate(text, { voice: voice || DEFAULT_VOICE });
      const samples = out.audio || out.data;
      const rate = out.sampling_rate || out.sampleRate || 24000;
      return pcmToWav(samples, rate);
    }));

    audioStore.put(key, docId || 'x', blob).catch(() => { /* quota; not fatal */ });
    return blob;
  }

  async speak({ text, voiceId, rate = 1, signal, docId }) {
    const body = (text || '').trim();
    if (!body) return;
    if (signal?.aborted) throw abortError();

    const blob = await this.#render(body, voiceId || DEFAULT_VOICE, docId, signal);
    if (signal?.aborted) throw abortError();

    // Rate is applied on playback rather than at generation: the model has no
    // speed control, and playbackRate with pitch preservation sounds better
    // than resampling would.
    await playBlob(blob, { rate, signal });
  }

  /** Render ahead without playing. Fire and forget. */
  async prime(items, { voiceId, docId } = {}) {
    for (const text of items) {
      const body = (text || '').trim();
      if (!body) continue;
      const key = this.#cacheKey(body, voiceId || DEFAULT_VOICE, docId);
      if (this.#primed.has(key)) continue;
      this.#primed.add(key);
      this.#render(body, voiceId || DEFAULT_VOICE, docId).catch(() => {
        this.#primed.delete(key);
      });
    }
  }

  /** Render an entire document up front. */
  async renderAll(sentences, { voiceId, docId, onProgress, signal }) {
    await this.init((pct, label) => onProgress?.({ done: 0, total: sentences.length, detail: label }));
    let done = 0;
    for (const s of sentences) {
      if (signal?.aborted) throw abortError();
      await this.#render(s, voiceId || DEFAULT_VOICE, docId, signal);
      onProgress?.({ done: ++done, total: sentences.length, detail: `Sentence ${done} of ${sentences.length}` });
    }
  }

  cancel() {
    const el = document.getElementById('audio-out');
    if (el) { try { el.pause(); } catch { /* nothing playing */ } }
  }

  async dispose() {
    this.cancel();
    this.#primed.clear();
  }
}

const fmtMB = (n) => `${(n / 1048576).toFixed(1)} MB`;

register(KokoroEngine);
