import { Engine, register, abortError } from './engine.js';

/* The platform synthesiser, via the Web Speech API.
 *
 * Free, instant, no download, and on an iPhone it can sound genuinely good —
 * but only if you first download an enhanced voice under
 *   Settings > Accessibility > Spoken Content > Voices > English
 * The default compact Siri voice is the robotic one people complain about;
 * the "Enhanced" and "Premium" downloads are a different class entirely and
 * this API picks them up automatically once installed.
 *
 * Three long-standing browser bugs are worked around here:
 *   - getVoices() is empty until the voiceschanged event fires (all browsers)
 *   - Chrome silently stops any utterance running past ~15 s
 *   - Safari leaves .speaking true briefly after cancel(), so speaking again
 *     immediately is dropped on the floor
 */

const QUALITY = /premium|enhanced|neural|natural|siri|eloquence/i;

export class SystemEngine extends Engine {
  static id = 'system';
  static label = 'Device voice';

  #voices = [];
  #current = null;
  #keepAlive = 0;

  get description() {
    return 'Uses the voices built into your device. Free, instant and fully offline. ' +
           'On iPhone, download an Enhanced or Premium English voice in Settings › Accessibility › ' +
           'Spoken Content › Voices for a large jump in quality.';
  }

  get backgroundCapable() { return false; }

  static available() {
    return typeof speechSynthesis !== 'undefined' && typeof SpeechSynthesisUtterance !== 'undefined';
  }

  async init() {
    if (!SystemEngine.available()) throw new Error('This browser has no speech synthesis');
    this.#voices = await loadVoices();
  }

  async voices() {
    if (!this.#voices.length) this.#voices = await loadVoices();

    return this.#voices
      .map((v, idx) => ({
        id: v.voiceURI || `${v.name}|${v.lang}`,
        label: v.name + (QUALITY.test(v.name) ? ' ✦' : ''),
        lang: v.lang,
        local: v.localService,
        // Bubble the good voices to the top of the picker: high quality
        // first, then English, then everything else.
        _rank: (QUALITY.test(v.name) ? -100 : 0) +
               (/^en/i.test(v.lang) ? -50 : 0) +
               (v.localService ? -10 : 0) + idx * 0.001,
      }))
      .sort((a, b) => a._rank - b._rank)
      .map(({ _rank, ...rest }) => rest);
  }

  #find(voiceId) {
    if (!voiceId) return null;
    return this.#voices.find(v => (v.voiceURI || `${v.name}|${v.lang}`) === voiceId) || null;
  }

  /**
   * @param {{text:string, voiceId?:string, rate?:number, pitch?:number, signal?:AbortSignal}} o
   */
  async speak({ text, voiceId, rate = 1, pitch = 1, signal }) {
    if (signal?.aborted) throw abortError();
    const body = (text || '').trim();
    if (!body) return;

    if (!this.#voices.length) this.#voices = await loadVoices();

    // Safari drops a speak() issued while a cancel() is still settling.
    if (speechSynthesis.speaking || speechSynthesis.pending) {
      speechSynthesis.cancel();
      await sleep(60);
    }

    return new Promise((resolve, reject) => {
      const u = new SpeechSynthesisUtterance(body);
      const v = this.#find(voiceId);
      if (v) { u.voice = v; u.lang = v.lang; }
      // Browsers clamp differently; 0.1–10 is the spec range, but values past
      // ~2.2 are unintelligible on most voices.
      u.rate = Math.max(0.1, Math.min(rate, 3));
      u.pitch = Math.max(0, Math.min(pitch, 2));
      this.#current = u;

      let settled = false;
      const finish = (fn, arg) => {
        if (settled) return;
        settled = true;
        clearInterval(this.#keepAlive);
        signal?.removeEventListener('abort', onAbort);
        this.#current = null;
        fn(arg);
      };

      const onAbort = () => { speechSynthesis.cancel(); finish(reject, abortError()); };
      signal?.addEventListener('abort', onAbort, { once: true });

      u.onend = () => finish(resolve);
      u.onerror = (e) => {
        // 'interrupted'/'canceled' are what a deliberate stop looks like.
        if (e.error === 'interrupted' || e.error === 'canceled') return finish(reject, abortError());
        finish(reject, new Error(`Speech failed: ${e.error || 'unknown'}`));
      };

      speechSynthesis.speak(u);

      // Chrome (desktop and Android) pauses its own queue after ~15 seconds.
      // A no-op resume on a timer keeps it alive and is harmless elsewhere.
      clearInterval(this.#keepAlive);
      this.#keepAlive = setInterval(() => {
        if (!speechSynthesis.speaking) return;
        try { speechSynthesis.resume(); } catch { /* not supported */ }
      }, 8000);

      // Empty or unspeakable input occasionally produces no events at all.
      setTimeout(() => {
        if (!settled && !speechSynthesis.speaking && !speechSynthesis.pending) finish(resolve);
      }, 900);
    });
  }

  cancel() {
    clearInterval(this.#keepAlive);
    this.#current = null;
    try { speechSynthesis.cancel(); } catch { /* already stopped */ }
  }

  async dispose() { this.cancel(); }
}

/* ═══════════════════════════════════════════════════════ helpers ══════ */

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/** getVoices() races page load in every browser. Poll and listen, give up
 *  after a couple of seconds and return whatever we have. */
function loadVoices(timeout = 2500) {
  return new Promise((resolve) => {
    const got = () => speechSynthesis.getVoices() || [];
    let list = got();
    if (list.length) return resolve(list);

    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearInterval(poll);
      clearTimeout(bail);
      speechSynthesis.removeEventListener('voiceschanged', finish);
      resolve(got());
    };

    speechSynthesis.addEventListener('voiceschanged', finish);
    const poll = setInterval(() => { if (got().length) finish(); }, 120);
    const bail = setTimeout(finish, timeout);
  });
}

register(SystemEngine);
