import { Engine, register, abortError, playBlob, hash } from './engine.js';
import { audio as audioStore } from '../core/db.js';

/* Piper — neural text to speech running entirely on the device.
 *
 * Chosen over the alternatives for a phone: the models are small enough to
 * hold locally, inference is comfortably faster than real time on modern
 * hardware, and because it emits real audio samples the result plays through
 * an <audio> element. That last point is what buys lock-screen controls and
 * playback that survives the screen turning off — neither of which the
 * platform speech API can do on iOS.
 *
 * Two costs are unavoidable and are surfaced in the interface rather than
 * hidden: a voice model is a one-time ~63 MB download, and synthesis takes
 * real time, so sentences are rendered ahead of playback and cached.
 */

/* Curated from the voices vits-web actually ships (its PATH_MAP is the
 * authority). American only, male and female, as asked for.
 *
 * Sizes are measured from the host rather than assumed. Worth knowing: the
 * "low" voices are the same ~60 MB download as the medium ones — they are not
 * a way to save space. What they buy is faster synthesis and 16 kHz output
 * instead of 22 kHz, which only matters on an older phone that struggles to
 * keep ahead of playback. */
const VOICES = [
  // id                        label                                  sex       MB
  ['en_US-amy-medium',        'Amy — natural, easy on long reads',    'female',  60],
  ['en_US-lessac-medium',     'Lessac — very clear, studio',          'female',  60],
  ['en_US-hfc_female-medium', 'HFC Female — crisp diction',           'female',  60],
  ['en_US-kristin-medium',    'Kristin — warm',                       'female',  61],
  ['en_US-ljspeech-medium',   'LJSpeech — neutral, precise',          'female',  61],
  ['en_US-lessac-high',       'Lessac HD — best quality, slowest',    'female', 109],
  ['en_US-kathleen-low',      'Kathleen — fastest synthesis, 16 kHz', 'female',  60],

  ['en_US-ryan-medium',       'Ryan — natural, easy on long reads',   'male',    60],
  ['en_US-hfc_male-medium',   'HFC Male — crisp diction',             'male',    60],
  ['en_US-joe-medium',        'Joe — relaxed',                        'male',    60],
  ['en_US-kusal-medium',      'Kusal — measured',                     'male',    60],
  ['en_US-ryan-high',         'Ryan HD — best quality, slowest',      'male',   115],
  ['en_US-danny-low',         'Danny — fastest synthesis, 16 kHz',    'male',    60],
];

const DEFAULT_VOICE = 'en_US-amy-medium';

export class PiperEngine extends Engine {
  static id = 'piper';
  static label = 'Piper (on-device neural)';

  #worker = null;
  #ready = null;
  #seq = 0;
  #pending = new Map();
  #storedVoices = null;
  #priming = new Set();
  #queue = Promise.resolve();

  get description() {
    return 'A neural voice that runs entirely on your phone. Clearer and far more natural than the ' +
           'built-in voices, and the only option that keeps playing with the screen locked. Each voice ' +
           'is a one-time download of about 63 MB — do that on wifi. Synthesis takes roughly as long as ' +
           'the audio itself, so use “Prepare offline audio” before you leave.';
  }

  get backgroundCapable() { return true; }
  get needsNetworkFirstRun() { return true; }

  static available() {
    // Needs WebAssembly to run the model and OPFS to keep it between sessions.
    return typeof WebAssembly !== 'undefined' &&
           typeof Worker !== 'undefined' &&
           !!navigator.storage?.getDirectory;
  }

  /* ── worker plumbing ──────────────────────────────────────────── */

  #spawn() {
    if (this.#ready) return this.#ready;

    this.#ready = new Promise((resolve, reject) => {
      let worker;
      try {
        worker = new Worker(new URL('./piper-worker.js', import.meta.url), { type: 'module' });
      } catch (err) {
        reject(new Error('Could not start the Piper voice engine: ' + err.message));
        return;
      }

      const boot = setTimeout(
        () => reject(new Error('The Piper voice engine did not start. Check that vendor/piper exists.')),
        20000);

      worker.onmessage = (e) => {
        const { id, ok, result, error, progress } = e.data || {};

        if (id === '__ready') {
          clearTimeout(boot);
          this.#worker = worker;
          resolve(worker);
          return;
        }

        const entry = this.#pending.get(id);
        if (!entry) return;

        if (progress) { entry.onProgress?.(progress); return; }

        this.#pending.delete(id);
        if (ok) entry.resolve(result);
        else entry.reject(new Error(error));
      };

      worker.onerror = (e) => {
        clearTimeout(boot);
        const msg = e.message || 'Piper worker failed to load';
        reject(new Error(msg));
        for (const [, entry] of this.#pending) entry.reject(new Error(msg));
        this.#pending.clear();
      };
    });

    return this.#ready;
  }

  async #call(op, args, onProgress) {
    const worker = await this.#spawn();
    const id = `r${++this.#seq}`;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject, onProgress });
      worker.postMessage({ id, op, args });
    });
  }

  /* ── engine interface ─────────────────────────────────────────── */

  async init(onProgress) {
    onProgress?.(5, 'Starting the voice engine');
    await this.#spawn();
    await this.#call('ping');
    onProgress?.(100, 'Voice engine ready');
  }

  async voices() {
    const stored = await this.storedVoices().catch(() => []);
    return VOICES.map(([id, label, sex, mb]) => ({
      id,
      label: `${label} (${sex})`,
      lang: 'en-US',
      sex,
      megabytes: mb,
      downloaded: stored.includes(id),
    }));
  }

  /** Voice ids already held in OPFS. */
  async storedVoices({ refresh = false } = {}) {
    if (!refresh && this.#storedVoices) return this.#storedVoices;
    this.#storedVoices = await this.#call('stored');
    return this.#storedVoices;
  }

  async isVoiceReady(voiceId) {
    return (await this.storedVoices()).includes(voiceId || DEFAULT_VOICE);
  }

  /** @param {(p:{loaded:number,total:number})=>void} [onProgress] */
  async downloadVoice(voiceId, onProgress) {
    await this.#call('download', { voiceId: voiceId || DEFAULT_VOICE }, onProgress);
    await this.storedVoices({ refresh: true });
  }

  async removeVoice(voiceId) {
    await this.#call('remove', { voiceId });
    await this.storedVoices({ refresh: true });
  }

  voiceInfo(voiceId) {
    const row = VOICES.find(v => v[0] === (voiceId || DEFAULT_VOICE));
    return row ? { id: row[0], label: row[1], sex: row[2], megabytes: row[3] } : null;
  }

  /* ── synthesis ────────────────────────────────────────────────── */

  #key(text, voiceId, docId) {
    return `${docId || 'x'}:${hash(text)}:${voiceId}`;
  }

  async #render(text, voiceId, docId, signal) {
    const key = this.#key(text, voiceId, docId);

    const cached = await audioStore.get(key).catch(() => null);
    if (cached) return cached;
    if (signal?.aborted) throw abortError();

    // One model, one session: serialise so lookahead rendering and the
    // sentence being played do not interleave and thrash the runtime.
    const blob = await (this.#queue = this.#queue.then(async () => {
      if (signal?.aborted) throw abortError();
      const { buf, type } = await this.#call('predict', { text, voiceId });
      return new Blob([buf], { type: type || 'audio/wav' });
    }).catch((err) => {
      // Keep the chain alive; a single failed sentence must not wedge the rest.
      this.#queue = Promise.resolve();
      throw err;
    }));

    audioStore.put(key, docId || 'x', blob).catch(() => { /* quota; not fatal */ });
    return blob;
  }

  async speak({ text, voiceId, rate = 1, signal, docId }) {
    const body = (text || '').trim();
    if (!body) return;
    if (signal?.aborted) throw abortError();

    const voice = voiceId || DEFAULT_VOICE;
    const blob = await this.#render(body, voice, docId, signal);
    if (signal?.aborted) throw abortError();

    // Piper has no speed control we can reach through this library, so rate is
    // applied on playback. preservesPitch keeps a 1.5x read from sounding
    // comical; it is set in playBlob.
    await playBlob(blob, { rate, signal });
  }

  async prime(items, { voiceId, docId } = {}) {
    const voice = voiceId || DEFAULT_VOICE;
    for (const text of items) {
      const body = (text || '').trim();
      if (!body) continue;
      const key = this.#key(body, voice, docId);
      if (this.#priming.has(key)) continue;
      this.#priming.add(key);
      this.#render(body, voice, docId).catch(() => this.#priming.delete(key));
    }
  }

  /** Render a whole document ahead of time. */
  async renderAll(sentences, { voiceId, docId, onProgress, signal }) {
    const voice = voiceId || DEFAULT_VOICE;
    await this.init();

    if (!(await this.isVoiceReady(voice))) {
      const info = this.voiceInfo(voice);
      await this.downloadVoice(voice, (p) => onProgress?.({
        done: 0, total: sentences.length,
        detail: `Downloading ${info?.label || voice} — ${fmtMB(p.loaded)} of ${fmtMB(p.total)}`,
      }));
    }

    let done = 0;
    for (const s of sentences) {
      if (signal?.aborted) throw abortError();
      await this.#render(s, voice, docId, signal);
      onProgress?.({ done: ++done, total: sentences.length,
                     detail: `Sentence ${done} of ${sentences.length}` });
    }
  }

  cancel() {
    const el = document.getElementById('audio-out');
    if (el) { try { el.pause(); } catch { /* nothing playing */ } }
  }

  async dispose() {
    this.cancel();
    this.#priming.clear();
    try { this.#worker?.terminate(); } catch { /* already gone */ }
    this.#worker = null;
    this.#ready = null;
  }
}

const fmtMB = (n) => `${((n || 0) / 1048576).toFixed(1)} MB`;

register(PiperEngine);
