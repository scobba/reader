export const APP_VERSION = '1.0.0';

/** All third-party code is vendored under /vendor so the app is same-origin
 *  and genuinely works offline. Run tools/vendor.ps1 to (re)populate it. */
export const PDFJS = {
  lib:    new URL('../vendor/pdfjs/pdf.min.mjs', import.meta.url).href,
  worker: new URL('../vendor/pdfjs/pdf.worker.min.mjs', import.meta.url).href,
  fonts:  new URL('../vendor/pdfjs/standard_fonts/', import.meta.url).href,
};

export const TESSERACT = {
  lib:    new URL('../vendor/tesseract/tesseract.min.js', import.meta.url).href,
  worker: new URL('../vendor/tesseract/worker.min.js', import.meta.url).href,
  core:   new URL('../vendor/tesseract/core/', import.meta.url).href,
  lang:   new URL('../vendor/tesseract/lang/', import.meta.url).href,
};

/** Kokoro is the one thing not vendored: it pulls @huggingface/transformers
 *  and an ~86 MB model, which has to come off the network the first time
 *  regardless. After that the browser's HTTP cache holds it. */
export const KOKORO = {
  lib:   'https://cdn.jsdelivr.net/npm/kokoro-js@1.2.1/dist/kokoro.web.js',
  model: 'onnx-community/Kokoro-82M-v1.0-ONNX',
  dtype: 'q8',
};

/** Sentences longer than this are split at a clause boundary. Keeps highlight
 *  granularity useful and stops iOS Safari truncating long utterances. */
export const MAX_SENTENCE_CHARS = 300;

/** How far ahead the neural engine renders audio while you listen. */
export const LOOKAHEAD_SENTENCES = 3;
