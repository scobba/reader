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

### Piper — the better option

**Piper** is a neural text-to-speech model that runs entirely on the device.
It is the recommended voice: clearer and far more natural than anything the
platform ships, and — because it produces real audio samples rather than
driving the system synthesiser — it is the only mode where **playback keeps
going with the screen locked** and the lock-screen transport works. On iOS the
platform voices stop the moment the screen turns off, which rather defeats the
point of hands-free listening.

Thirteen American voices are offered, male and female, chosen from the set the
runtime actually ships. `Amy` and `Ryan` are the easiest to listen to over a
long article; `Lessac` and the two `HFC` voices have the crispest diction,
which suits dense clinical text; the `HD` pair sound best and synthesise
slowest.

Two costs, both stated in the interface rather than hidden:

- **A voice is a one-time ~60 MB download** (~110 MB for the HD pair), kept in
  the Origin Private File System so it survives restarts. Settings shows which
  voices are on the device and lets you remove them. Do the first download on
  wifi.
- **Synthesis takes time.** Measured at roughly **0.35× real time on a
  desktop** — about three times faster than playback — but on a phone it is
  much closer to break-even. Sentences are rendered a few ahead of playback
  and cached, so it keeps up in practice; for a guaranteed-smooth listen, use
  **Prepare offline audio** from the document menu first.

The "low" voices are worth understanding: they are the *same* ~60 MB download
as the medium ones, so they save no space. What they buy is faster synthesis
at 16 kHz instead of 22 kHz, which only matters on an older phone that cannot
stay ahead of playback.

Kokoro-82M was removed once Piper superseded it: smaller voices, faster
synthesis, and no dependency on a CDN at runtime.

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
and only then does the body split into columns.

Deciding what counts as a gutter is the whole game, because a false one
scrambles reading order worse than a missed one does. Width alone is not
enough to decide it: NEJM leaves 0.9 em between columns, narrower than a
threshold generous enough to ignore the holes that ragged-right text leaves.
So a narrow channel has to earn it — it must be far wider than the region's
own word spacing, the columns either side of it must run alongside each other
for several lines, and at least one of the two edges it cuts must be straight.
A channel that survives all three is a gutter; prose that happens to leave a
hole satisfies none of them.

The same page also has to survive whatever crosses the gutter. A footer under
a two-column abstract covers the channel and would weld the columns together,
so the horizontal cut that peels it off is measured against the text's own
line pitch rather than its font size — a footer sits well under an em below
the last line, but comfortably more than a line's worth of leading.

After that it clusters glyphs into lines by baseline, lifts drop caps back to
the head of the paragraph they open — a cap set three lines deep otherwise
rests on the last of them, and the article starts "cute respiratory failure" —
rejoins letter-spaced section heads, since journals track them wide enough
that pdf.js reads the gaps as spaces and "Methods" arrives as "Me thods",
merges lines into paragraphs using gap, indent and short-line-ending signals,
drops superscript citation markers while it still knows the surrounding font
size, and removes running heads and footers by finding lines that repeat
across pages.

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
    piper.js          on-device neural TTS (Piper)
    piper-worker.js   synthesis worker, so it never blocks the UI
  ui/                 library, reader, dialogs, toasts
vendor/               pdf.js + tesseract.js, fetched by tools/vendor.ps1
tools/
  vendor.ps1          downloads third-party runtime deps
  make-icons.ps1      renders the PNG app icons
  serve.ps1           local static server
test/
  layout.test.mjs     regression tests for the XY-cut and paragraph assembly
  title.test.mjs      which line of a title page is the title
  fixtures/           sample documents; safe to delete before deploying
```

Nothing under `test/` is served or precached, so the whole directory can be
deleted before deploying.

### Running the tests

```bash
node --test test/
```

Node is not a runtime dependency — the app itself still needs no toolchain —
but `layout.js` is pure geometry, and it is the one file where a tuning
constant can quietly ruin every document without throwing anything. The tests
build page geometry by hand, one case per layout the XY-cut has to get right:
tight two- and three-column measures, a full-width heading or footer crossing
the gutter, a marginal note, list markers hanging in the margin, drop caps,
letter-spaced section heads, and a paragraph running from the foot of one
column to the head of the next.

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

pdf.js 6 is built against a very recent JavaScript baseline. None of what it
assumes is an optional extra — every one of these sits on the path a document
actually takes, so a missing one is not a degraded feature, it is a file that
will not open. All of them are patched into the bundles by `tools/vendor.ps1`
(re-running it reapplies them):

| Needs | Since | Used for |
|---|---|---|
| `Promise.withResolvers` | Safari 17.4 | called in dozens of places |
| async iteration over a `ReadableStream` | **never shipped** | how pdf.js consumes its own text stream |
| `Promise.try` | Safari 18.2 | the worker message handler wraps every call in it |
| `Uint8Array` `toBase64` / `fromBase64` / `toHex` | Safari 18.2 | document fingerprints, embedded font CSS |
| `Math.sumPrecise` | Safari 18.4 | the font sanitiser sizes every glyph table with it |
| `Map` / `WeakMap` `getOrInsert`, `getOrInsertComputed` | Safari 26 | dictionary parsing, and `getMetadata()` |

Async iteration over a `ReadableStream` is the one Safari has never shipped at
any version: pdf.js streams text out of its worker and consumes it with
`for await (const chunk of stream)`, so without that polyfill
`getTextContent()` throws "undefined is not a function" and no PDF can be read
on an iPhone at all.

The last row fails more quietly than the rest. `getMetadata()` is called inside
a `try` that treats metadata as optional, so nothing breaks — the document just
loses its embedded title and gets named after whatever heading comes first,
which on a journal PDF is the masthead. A document in the library called *The
new england* is this, not a layout problem.

The worker bundle runs in its own realm and cannot see a polyfill loaded by the
page, so the shim is injected into both `pdf.min.mjs` and `pdf.worker.min.mjs`
rather than shipped only as `js/compat.js`. It is one line, wrapped in an IIFE:
the bundles are minified modules whose top-level names are single letters, and
anything the shim declared at module scope would eventually collide with one.

With those in place the practical floor is:

| | Minimum |
|---|---|
| PDF, HTML, text, speech | iOS 15.4 / Safari 15.4 |
| EPUB and DOCX (needs `DecompressionStream`) | iOS 16.4 |
| Keep-screen-awake (Wake Lock) | iOS 16.4 |

## If the worker is unusable

PDF parsing runs in a module worker so a long document does not freeze the
interface. That worker is also the most fragile thing the app depends on:
WebKit has a history of breaking module workers spawned from a page that a
service worker controls, and when it breaks it breaks for every document, so
the app simply looks broken.

`js/extract/pdf.js` therefore treats the worker as best-effort. pdf.js already
recovers by itself when `new Worker()` throws, but the failure it cannot see is
a worker that constructs successfully and then never replies — a hang rather
than an error. So opening a document races a deadline (12 s on first use), and
on timeout the same pdf.js bundle is run on the main thread instead. The
outcome is remembered, so only the first import pays for the discovery.

The result is slower on large files and blocks the interface while it parses,
but it works. Settings › Show diagnostics reports which path was taken.

## Notes on the Piper integration

`@diffusionstudio/vits-web` is published expecting a bundler, so
`tools/vendor.ps1` applies five rewrites to it after download. Re-running the
script reapplies them; the patches are idempotent.

1. **`import("onnxruntime-web")`** — a bare specifier. Nothing resolves that in
   a browser without an import map or a bundler, so it is pointed at the
   vendored copy.
2. **`wasm.numThreads = navigator.hardwareConcurrency`** → `1`. Multi-threaded
   WebAssembly needs `SharedArrayBuffer`, which needs the page to be
   cross-origin isolated via COOP and COEP headers. GitHub Pages sends neither
   and they cannot be added, so threading would fail at runtime.
3. **`ONNX_BASE` and `WASM_BASE`** → `new URL(..., import.meta.url)`. These are
   read at runtime by Emscripten and onnxruntime, which resolve them against
   the *worker's* base URL rather than the module's. Anchoring them to
   `import.meta.url` keeps them correct from any caller and at any deployment
   sub-path, so the app works at `github.io/reader/` as well as at a domain
   root.
4. **`download()` did not await its own write.** It called the OPFS write
   without awaiting, so the promise resolved while a 60 MB write was still in
   flight and the next read got a truncated model — surfacing as
   `No graph was found in the protobuf`. Upstream bug; `predict()`'s
   on-demand path awaits correctly and is unaffected.

Inference is also moved into `js/tts/piper-worker.js`. The package runs it
inline despite a docstring claiming otherwise — there is no `Worker` anywhere
in it — and synthesising a sentence is hundreds of milliseconds of solid
compute, which would freeze the sentence highlighting on every sentence.

Voice models are deliberately **not** vendored: they are ~60 MB each, there are
many, and the runtime already caches them in OPFS after first download. The
runtime itself (~38 MB of espeak pronunciation data and ONNX WebAssembly) *is*
vendored, but sits in the service worker's lazy tier, so it costs nothing
unless you actually choose Piper.
