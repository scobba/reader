import { LOOKAHEAD_SENTENCES } from '../config.js';
import { settings } from './settings.js';
import { progress as progressStore } from './db.js';
import { audioElement } from '../tts/engine.js';

/* Playback state machine.
 *
 * Pause is implemented as "abort and restart this sentence", not as the Web
 * Speech pause()/resume() pair. Those two are unreliable in exactly the place
 * it matters — Safari on iOS frequently never fires the resume — and because
 * sentences are capped at ~300 characters, replaying the current one costs at
 * most a few seconds and is entirely predictable to the listener.
 */

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

export class Player {
  #engine = null;
  #sentences = [];
  #doc = null;
  #index = 0;
  #playing = false;
  #abort = null;
  #wakeLock = null;
  #sleepTimer = null;
  #sleepAtSection = false;
  #listeners = new Map();
  #saveTimer = 0;

  /* ── events ───────────────────────────────────────────────────── */
  on(evt, fn) {
    if (!this.#listeners.has(evt)) this.#listeners.set(evt, new Set());
    this.#listeners.get(evt).add(fn);
    return () => this.#listeners.get(evt)?.delete(fn);
  }
  #emit(evt, payload) {
    for (const fn of this.#listeners.get(evt) || []) {
      try { fn(payload); } catch (e) { console.error(e); }
    }
  }

  /* ── state ────────────────────────────────────────────────────── */
  get playing() { return this.#playing; }
  get index() { return this.#index; }
  get sentences() { return this.#sentences; }
  get doc() { return this.#doc; }
  get engine() { return this.#engine; }

  setEngine(engine) {
    if (this.#engine === engine) return;
    this.#engine?.cancel();
    this.#engine = engine;
  }

  load(doc, sentences, startIndex = 0) {
    this.stop();
    this.#doc = doc;
    this.#sentences = sentences;
    this.#index = clamp(startIndex, 0, Math.max(0, sentences.length - 1));
    this.#emit('load', { doc, sentences, index: this.#index });
    this.#emit('index', this.#index);
    this.#updateMediaSession();
  }

  /** Re-point at a rebuilt sentence list (a cleanup setting changed) while
   *  holding roughly the same place in the document. */
  reindex(sentences) {
    const wasPlaying = this.#playing;
    const anchor = this.#sentences[this.#index];
    this.pause();
    this.#sentences = sentences;

    if (anchor) {
      const hit = sentences.findIndex(s => s.blockIdx === anchor.blockIdx && s.text === anchor.text);
      this.#index = hit >= 0 ? hit
        : clamp(sentences.findIndex(s => s.blockIdx >= anchor.blockIdx), 0, sentences.length - 1);
      if (this.#index < 0) this.#index = 0;
    }
    this.#emit('load', { doc: this.#doc, sentences, index: this.#index });
    this.#emit('index', this.#index);
    if (wasPlaying) this.play();
  }

  /* ── transport ────────────────────────────────────────────────── */

  /** Must be called synchronously from a user gesture the first time.
   *  iOS will not start any audio otherwise, and an await before the first
   *  speak() is enough to lose the gesture. */
  unlock() {
    try {
      if (typeof speechSynthesis !== 'undefined') {
        const u = new SpeechSynthesisUtterance(' ');
        u.volume = 0;
        speechSynthesis.speak(u);
        speechSynthesis.cancel();
      }
    } catch { /* not available */ }
    try {
      const el = audioElement();
      el.muted = true;
      el.play().then(() => { el.pause(); el.muted = false; }).catch(() => { el.muted = false; });
    } catch { /* not available */ }
  }

  async play() {
    if (this.#playing) return;
    if (!this.#engine) { this.#emit('error', new Error('No voice engine selected')); return; }
    if (!this.#sentences.length) return;

    // Landing on a skipped sentence (a reference, a caption) should move on
    // rather than sit silently.
    if (this.#sentences[this.#index]?.skip) {
      const n = this.#seek(this.#index, 1);
      if (n < 0) { this.#emit('end'); return; }
      this.#index = n;
    }

    this.#playing = true;
    this.#abort = new AbortController();
    this.#emit('state', true);
    this.#acquireWakeLock();
    this.#armSleepTimer();
    this.#updateMediaSession();

    const signal = this.#abort.signal;

    try {
      while (this.#playing && !signal.aborted) {
        const s = this.#sentences[this.#index];
        if (!s) break;

        if (s.skip) {
          const n = this.#seek(this.#index + 1, 1);
          if (n < 0) break;
          this.#index = n;
          continue;
        }

        this.#emit('index', this.#index);
        this.#save();
        this.#primeAhead();

        if (s.pauseBefore) await sleep(s.pauseBefore);
        if (signal.aborted) return;

        await this.#engine.speak({
          text: s.speak,
          voiceId: settings.get('voice'),
          rate: settings.get('rate'),
          pitch: settings.get('pitch'),
          docId: this.#doc?.id,
          signal,
        });

        if (signal.aborted) return;

        const gap = settings.get('gapMs');
        if (gap) await sleep(gap);

        // Stop at the section boundary if the sleep timer asked for it.
        const next = this.#seek(this.#index + 1, 1);
        if (this.#sleepAtSection && next >= 0 &&
            this.#sentences[next].type === 'heading') {
          this.#sleepAtSection = false;
          this.#index = next;
          this.pause();
          this.#emit('sleep');
          return;
        }

        if (next < 0) break;
        this.#index = next;
      }

      if (this.#playing) {
        this.#playing = false;
        this.#emit('state', false);
        this.#emit('end');
        this.#releaseWakeLock();
        this.#save(true);
      }
    } catch (err) {
      if (err?.name === 'AbortError') return;
      this.#playing = false;
      this.#emit('state', false);
      this.#releaseWakeLock();
      this.#emit('error', err);
    }
  }

  pause() {
    if (!this.#playing && !this.#abort) return;
    this.#playing = false;
    this.#abort?.abort();
    this.#abort = null;
    this.#engine?.cancel();
    this.#releaseWakeLock();
    this.#clearSleepTimer();
    this.#emit('state', false);
    this.#save(true);
  }

  toggle() { this.#playing ? this.pause() : this.play(); }

  stop() {
    this.pause();
    this.#index = 0;
    this.#emit('index', 0);
  }

  /** Jump to an exact sentence. */
  goto(index, { autoplay = null } = {}) {
    const wasPlaying = this.#playing;
    this.pause();
    this.#index = clamp(index, 0, Math.max(0, this.#sentences.length - 1));
    this.#emit('index', this.#index);
    this.#save(true);
    this.#updateMediaSession();
    if (autoplay ?? wasPlaying) this.play();
  }

  next() { this.#step(1); }
  prev() { this.#step(-1); }

  #step(dir) {
    const from = this.#index + dir;
    let target = this.#seek(from, dir);
    if (target < 0) target = dir > 0 ? this.#sentences.length - 1 : 0;
    this.goto(target);
  }

  /** Move to the previous / next heading. */
  section(dir) {
    const list = this.#sentences;
    if (dir < 0) {
      // Going back once lands at the start of the current section, twice at
      // the previous one — the behaviour every podcast app has.
      let i = this.#index - 1;
      let firstHeading = -1;
      while (i >= 0) {
        if (list[i].type === 'heading') { firstHeading = i; break; }
        i--;
      }
      if (firstHeading < 0) return this.goto(0);
      if (this.#index - firstHeading <= 2) {
        let j = firstHeading - 1;
        while (j >= 0 && list[j].type !== 'heading') j--;
        return this.goto(Math.max(0, j));
      }
      return this.goto(firstHeading);
    }
    for (let i = this.#index + 1; i < list.length; i++) {
      if (list[i].type === 'heading') return this.goto(i);
    }
    this.goto(list.length - 1);
  }

  /** First playable index at or after `from`, walking in `dir`. */
  #seek(from, dir) {
    for (let i = from; i >= 0 && i < this.#sentences.length; i += dir) {
      if (!this.#sentences[i].skip) return i;
    }
    return -1;
  }

  #primeAhead() {
    if (!this.#engine?.prime) return;
    const ahead = [];
    let i = this.#index + 1;
    while (ahead.length < LOOKAHEAD_SENTENCES && i < this.#sentences.length) {
      const s = this.#sentences[i++];
      if (!s.skip) ahead.push(s.speak);
    }
    if (ahead.length) {
      this.#engine.prime(ahead, {
        voiceId: settings.get('voice'),
        docId: this.#doc?.id,
      });
    }
  }

  /* ── progress ─────────────────────────────────────────────────── */
  #save(immediate = false) {
    if (!this.#doc) return;
    const write = () => progressStore
      .put(this.#doc.id, this.#index, this.#sentences.length)
      .catch(() => {});
    clearTimeout(this.#saveTimer);
    if (immediate) write();
    else this.#saveTimer = setTimeout(write, 1500);
  }

  /* ── screen wake lock ─────────────────────────────────────────── */
  async #acquireWakeLock() {
    if (!settings.get('keepAwake') || !('wakeLock' in navigator)) return;
    try {
      this.#wakeLock = await navigator.wakeLock.request('screen');
      this.#wakeLock.addEventListener('release', () => { this.#wakeLock = null; });
    } catch { /* denied, low battery, or unsupported */ }
  }
  #releaseWakeLock() {
    try { this.#wakeLock?.release(); } catch { /* already gone */ }
    this.#wakeLock = null;
  }
  /** The lock is dropped whenever the tab hides; take it again on return. */
  async refreshWakeLock() {
    if (this.#playing && !this.#wakeLock && document.visibilityState === 'visible') {
      await this.#acquireWakeLock();
    }
  }

  /* ── sleep timer ──────────────────────────────────────────────── */
  #armSleepTimer() {
    this.#clearSleepTimer();
    const secs = Number(settings.get('sleepSeconds')) || 0;
    if (secs === -1) { this.#sleepAtSection = true; return; }
    if (secs > 0) {
      this.#sleepTimer = setTimeout(() => { this.pause(); this.#emit('sleep'); }, secs * 1000);
    }
  }
  #clearSleepTimer() {
    clearTimeout(this.#sleepTimer);
    this.#sleepTimer = null;
  }

  /* ── lock screen ──────────────────────────────────────────────── */
  #updateMediaSession() {
    if (!('mediaSession' in navigator) || !this.#doc) return;
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: this.#doc.title || 'Document',
        artist: this.#doc.author || this.#doc.section || 'Mobile Reader',
        album: this.#sentences[this.#index]?.section || '',
      });
      const set = (a, fn) => { try { navigator.mediaSession.setActionHandler(a, fn); } catch { /* unsupported action */ } };
      set('play', () => this.play());
      set('pause', () => this.pause());
      set('stop', () => this.pause());
      set('nexttrack', () => this.next());
      set('previoustrack', () => this.prev());
      set('seekforward', () => this.next());
      set('seekbackward', () => this.prev());
    } catch { /* MediaMetadata unavailable */ }
  }

  setPlaybackState(state) {
    if ('mediaSession' in navigator) {
      try { navigator.mediaSession.playbackState = state; } catch { /* unsupported */ }
    }
  }
}

function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }

export const player = new Player();

document.addEventListener('visibilitychange', () => player.refreshWakeLock());
