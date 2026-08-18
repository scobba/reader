/* Settings live in localStorage — they are tiny, and reading them
 * synchronously at boot avoids a flash of unstyled reader text. */

const KEY = 'reader.settings.v1';

const DEFAULTS = {
  engine: 'system',
  voice: '',            // engine-specific voice id; '' means engine default
  rate: 1,
  pitch: 1,
  gapMs: 0,             // extra silence between sentences

  skipCitations: true,
  skipRefs: true,
  skipCaptions: false,
  expandAbbrev: true,
  announceHeadings: true,

  keepAwake: true,
  autoscroll: true,
  sleepSeconds: 0,

  fontSize: 18,
  dyslexic: false,
};

let state = load();

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? { ...DEFAULTS, ...JSON.parse(raw) } : { ...DEFAULTS };
  } catch {
    return { ...DEFAULTS };
  }
}

const listeners = new Set();

export const settings = {
  get all() { return state; },
  get(k) { return state[k]; },

  set(k, v) {
    if (state[k] === v) return;
    state[k] = v;
    save();
    emit([k]);
  },

  patch(obj) {
    const changed = Object.keys(obj).filter(k => state[k] !== obj[k]);
    if (!changed.length) return;
    Object.assign(state, obj);
    save();
    emit(changed);
  },

  reset() { state = { ...DEFAULTS }; save(); emit(Object.keys(DEFAULTS)); },

  /** Returns an unsubscribe function. */
  onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
};

function save() {
  try { localStorage.setItem(KEY, JSON.stringify(state)); } catch { /* private mode */ }
}

function emit(keys) {
  for (const fn of listeners) {
    try { fn(keys, state); } catch (e) { console.error(e); }
  }
}

/** The subset that changes how text is turned into speech. When any of these
 *  change, the sentence list has to be rebuilt. */
export const TEXT_KEYS = [
  'skipCitations', 'skipRefs', 'skipCaptions', 'expandAbbrev', 'announceHeadings',
];

export function affectsText(keys) {
  return keys.some(k => TEXT_KEYS.includes(k));
}
