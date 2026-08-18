# Mobile Reader

Reads PDFs, medical journal articles, EPUBs, Word files, web pages and pasted
text aloud. Installs to an iPhone home screen, works offline, keeps everything
on the device.

Built as a zero-build static site: no Node, no npm, no bundler. Every file is
served exactly as it is written. Third-party code is vendored under `vendor/`,
so nothing is fetched from a CDN at runtime.

---

## Getting it onto your iPhone

The app has to be served over HTTPS for iOS to install it or run a service
worker. The fastest route, with no account and no build step:

1. Go to **<https://app.netlify.com/drop>**
2. Drag this whole folder onto the page
3. Wait for the URL it gives you (something like `graceful-otter-1a2b3c.netlify.app`)
4. Open that URL in **Safari** on your iPhone
5. Tap the **Share** button, then **Add to Home Screen**

Open it from the home-screen icon rather than a Safari tab. Installed, it gets
its own storage that Safari will not evict after a week of not using it, which
matters for keeping downloaded documents around.

GitHub Pages, Cloudflare Pages and Vercel all work the same way if you would
rather use one of those.

### Testing it on Windows first

```bash
powershell -ExecutionPolicy Bypass -File tools\serve.ps1
```

Then open <http://localhost:8123>. A service worker needs an `http(s)` origin,
so opening `index.html` directly as a file will not work. On localhost the
service worker deliberately goes network-first so your edits show up
immediately instead of being served from yesterday's cache.

---

## Getting a good voice

This is the single biggest difference in how the app sounds, and it is a
setting on your phone rather than in the app.

On iOS: **Settings › Accessibility › Spoken Content › Voices › English**, then
download one of the **Enhanced** or **Premium** voices (Ava, Evan, Zoe, Nathan
are all good). The default compact voice is the flat robotic one; the enhanced
downloads are a completely different class, they are free, and they work
offline. The app picks them up automatically — they will appear in the voice
list marked with a ✦.

There is also a **neural voice** option in Settings that runs a small model
(Kokoro-82M) on the device. It sounds better than anything Apple ships and it
is the only mode where playback keeps going with the screen locked and shows
lock-screen controls, because it produces real audio rather than driving the
system synthesiser. The trade-offs are real: about 86 MB downloaded once over
wifi, and rendering is roughly real-time on a phone, so use **Prepare offline
audio** from the document menu before you leave rather than expecting it to
keep up live.

---

## What it does to the text

Reading a journal PDF aloud well is mostly a text problem, not a speech
problem. Three things happen between the file and the voice.

### 1. Layout recovery

A PDF stores glyphs at coordinates; it has no idea what a paragraph is.
Concatenating the text in file order reads straight across a two-column page
and produces nonsense.

`js/extract/layout.js` runs a **recursive XY-cut**: it looks for whitespace
gutters, prefers vertical cuts, and recurses. Preferring vertical cuts is what
makes a full-width title above two columns come out right — the title blocks
any full-height gutter, so the page splits horizontally first (title | body),
and only then does the body split into columns. Guards on region width stop a
couple of short ragged-right lines from being mistaken for a column break.

After that it clusters glyphs into lines by baseline, merges lines into
paragraphs using gap, indent and short-line-ending signals, drops superscript
citation markers while it still knows the surrounding font size, and removes
running heads and footers by finding lines that repeat across pages.

Scanned pages have no text layer at all, so they go through Tesseract instead —
and the OCR word boxes are fed through *the same* pipeline, because a scanned
two-column article has exactly the same reading-order problem.

### 2. Cleanup

Inline citations are removed — `[12, 15]`, `(Smith et al., 2019)` — by a check
that is deliberately conservative: anything containing a statistic is kept, so
`(p = 0.03)` and `(95% CI 1.2–3.4)` survive. Reference lists and back matter
are detected and skipped, with or without a heading. Ligature glyphs, soft
hyphens and stray combining accents (`Ko¨tter` → `Kötter`) are repaired, and
words broken across a line are rejoined.

### 3. Speech rewriting

The text on screen keeps the author's exact wording. Only what gets *spoken* is
rewritten, so you can still read along and cite what you see:

| Written | Spoken |
|---|---|
| `mg/dL` | milligrams per deciliter |
| `95% CI 1.2–3.4` | 95 percent confidence interval 1.2 to 3.4 |
| `p < 0.05` | p less than 0.05 |
| `HbA1c` | hemoglobin A one C |
| `500 mg BID` | 500 milligrams twice daily |
| `8× deeper` | 8 times deeper |
| `112×112` | 112 by 112 |
| `Fig. 3` | Figure 3 |
| `et al.` | and colleagues |

Genuinely ambiguous abbreviations are left alone on purpose. A bare `HR` could
be hazard ratio or heart rate, `PE` could be pulmonary embolism or physical
exam — guessing wrong changes the clinical meaning of the sentence, so those
only expand when the context is unambiguous (`HR = 0.68`).

Sentence splitting is abbreviation-aware. `Fig. 3`, `Dr. Smith`, `et al.`,
`E. coli`, `12.4%`, `p < 0.05` and `37 °C` do not break a sentence, because a
mid-sentence cut is instantly audible — the synthesiser drops its intonation
and pauses in the wrong place.

Everything in this stage is re-derived from the stored blocks whenever you
change a setting, so toggling "skip citations" is instant and never re-parses
the original file.

---

## Using it

- **Add** — the `+` button takes files, a URL, or pasted text. On iPhone, tap
  *Browse* to reach anything in Files, including PDFs shared out of Safari or a
  journal app.
- **Web pages** — many publishers block direct fetching from a browser, and no
  client-side trick fixes that. If a URL fails, open it in Safari, Select All →
  Copy, and use the **Paste** tab. That always works.
- **Tap any sentence** to start reading from there.
- **Jump to section** in the document menu navigates by heading.
- **Scanned PDF?** If the import says there is no text layer, open it and choose
  **Re-extract with OCR**. It runs entirely on the device, and it is genuinely
  slow: tens of seconds per page on a phone, and the first run also pulls in a
  10 MB language model. Start it, leave the screen on, and come back. The
  result is stored, so you only pay this once per document.

### Keyboard (desktop)

| Key | |
|---|---|
| `Space` | play / pause |
| `←` `→` | previous / next sentence |
| `↑` `↓` | previous / next section |
| `Esc` | back to library |

---

## Layout

```
index.html            shell, all four sheets
sw.js                 service worker; network-first on localhost, cache-first deployed
js/
  config.js           vendored asset URLs, tuning constants
  core/
    db.js             IndexedDB: docs, content, files, progress, audio
    settings.js       localStorage settings + change notification
    zip.js            dependency-free ZIP reader (unlocks EPUB and DOCX)
    ingest.js         import pipeline
    player.js         playback state machine, wake lock, media session
  extract/
    layout.js         XY-cut, line clustering, paragraph assembly  ← the core
    pdf.js            pdf.js -> positioned glyphs
    ocr.js            Tesseract -> the same pipeline
    html.js epub.js docx.js text.js
  clean/
    normalize.js      unicode repair, citation removal, noise detection
    abbrev.js         speech rewriting rules
    segment.js        abbreviation-aware sentence splitter
    structure.js      zoning + script assembly
  tts/
    engine.js         engine contract, WAV encoding, shared audio element
    system.js         Web Speech API (+ three browser bug workarounds)
    kokoro.js         on-device neural TTS
  ui/                 library, reader, dialogs, toasts
vendor/               pdf.js + tesseract.js, fetched by tools/vendor.ps1
tools/
  vendor.ps1          downloads third-party runtime deps
  make-icons.ps1      renders the PNG app icons
  serve.ps1           local static server
test/fixtures/        sample documents; safe to delete before deploying
```

`vendor/` is about 56 MB, but only ~2.5 MB of it (the shell plus pdf.js) is
precached on install. The OCR engine and its language model are the bulk, and
they are only downloaded the first time you actually OCR something.

To re-fetch or upgrade the vendored libraries:

```bash
powershell -ExecutionPolicy Bypass -File tools\vendor.ps1 -Force
```

---

## Known limits

- **iOS device voices stop when the screen locks.** This is a WebKit
  restriction on the Web Speech API, not something the app can work around.
  Use the neural voice if you need to listen with the screen off — it plays
  real audio through a media element, which iOS does allow in the background.
- **Pause restarts the current sentence** rather than resuming mid-word.
  Safari's `speechSynthesis.resume()` frequently never fires; restarting a
  sentence capped at ~300 characters is predictable and always works.
- **Tables read poorly.** Most are detected and skipped, but a table laid out
  so it looks like prose will be read as prose. There is no good way to speak
  a table aloud anyway.
- **OCR on a phone is slow.** Keep the app in the foreground while it runs;
  browsers throttle background tabs hard enough to stall it almost completely.
- **Scanned handwriting** will not work. Tesseract is for printed text.

## Browser requirements

The vendored pdf.js calls `Promise.withResolvers`, which only reached Safari in
17.4. `tools/vendor.ps1` injects a small polyfill into both pdf.js bundles —
including the worker one, which runs in its own realm and cannot see a
polyfill loaded by the page — so older devices work too. Re-running the
vendor script reapplies it automatically.

With that in place the practical floor is:

| | Minimum |
|---|---|
| PDF, HTML, text, speech | iOS 15.4 / Safari 15.4 |
| EPUB and DOCX (needs `DecompressionStream`) | iOS 16.4 |
| Keep-screen-awake (Wake Lock) | iOS 16.4 |

Anything older will load the app but fail on import with a message rather than
working silently badly.
