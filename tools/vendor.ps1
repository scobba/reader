<#
  vendor.ps1 - downloads third-party runtime deps into ./vendor so the app is
  fully same-origin and works offline. Run once from the project root:

      powershell -ExecutionPolicy Bypass -File tools\vendor.ps1

  Re-running is safe; existing files are skipped unless -Force is passed.
#>
[CmdletBinding()]
param([switch]$Force, [switch]$SkipOcr, [switch]$SkipPiper)

$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$ProgressPreference = 'SilentlyContinue'

$root   = Split-Path -Parent $PSScriptRoot
$vendor = Join-Path $root 'vendor'

$PDFJS_VERSION = '6.2.108'
$TESS_VERSION  = '7.0.0'
$VITS_VERSION      = '1.0.3'
$PIPERWASM_VERSION = '1.0.0'
$ORT_VERSION       = '1.18.0'

function Get-Dep {
    param([string]$Url, [string]$Dest, [switch]$Optional)

    $full = Join-Path $vendor $Dest
    if ((Test-Path $full) -and -not $Force) {
        Write-Host ("  skip  {0}" -f $Dest) -ForegroundColor DarkGray
        return $true
    }
    $dir = Split-Path -Parent $full
    if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }

    try {
        Invoke-WebRequest -Uri $Url -OutFile $full -UseBasicParsing -TimeoutSec 180
        $kb = [math]::Round((Get-Item $full).Length / 1KB)
        Write-Host ("  ok    {0}  ({1} KB)" -f $Dest, $kb) -ForegroundColor Green
        return $true
    } catch {
        if (Test-Path $full) { Remove-Item $full -Force -ErrorAction SilentlyContinue }
        if ($Optional) {
            Write-Host ("  miss  {0}  (optional)" -f $Dest) -ForegroundColor DarkYellow
            return $false
        }
        Write-Host ("  FAIL  {0}" -f $Dest) -ForegroundColor Red
        Write-Host ("        {0}" -f $_.Exception.Message) -ForegroundColor Red
        return $false
    }
}

Write-Host ""
Write-Host "Mobile Reader - vendoring runtime dependencies" -ForegroundColor Cyan
Write-Host "into $vendor"
Write-Host ""

# ---------------------------------------------------------------- pdf.js ----
Write-Host "pdf.js $PDFJS_VERSION" -ForegroundColor Cyan
$pdfBase = "https://cdn.jsdelivr.net/npm/pdfjs-dist@$PDFJS_VERSION"
$okPdf  = Get-Dep "$pdfBase/build/pdf.min.mjs"        'pdfjs/pdf.min.mjs'
$okPdf2 = Get-Dep "$pdfBase/build/pdf.worker.min.mjs" 'pdfjs/pdf.worker.min.mjs'

# Standard 14 font data. Only needed when a PDF omits embedded fonts; without
# these pdf.js still extracts text but logs warnings and renders poorly (which
# matters for the OCR fallback path, since that rasterises pages).
$stdFonts = @(
    'FoxitDingbats.pfb','FoxitFixed.pfb','FoxitFixedBold.pfb','FoxitFixedBoldItalic.pfb',
    'FoxitFixedItalic.pfb','FoxitSerif.pfb','FoxitSerifBold.pfb','FoxitSerifBoldItalic.pfb',
    'FoxitSerifItalic.pfb','FoxitSymbol.pfb',
    'LiberationSans-Bold.ttf','LiberationSans-BoldItalic.ttf',
    'LiberationSans-Italic.ttf','LiberationSans-Regular.ttf',
    'LICENSE_FOXIT','LICENSE_LIBERATION'
)
foreach ($f in $stdFonts) {
    Get-Dep "$pdfBase/standard_fonts/$f" "pdfjs/standard_fonts/$f" -Optional | Out-Null
}

if (-not ($okPdf -and $okPdf2)) {
    Write-Host ""
    Write-Host "pdf.js failed to download - PDF support will not work." -ForegroundColor Red
    exit 1
}

# ----------------------------------------------------------- tesseract.js ----
# OCR is only needed for scanned documents, and the assets are large (~25 MB),
# so they are vendored but NOT precached by the service worker. The app pulls
# them in the first time you OCR something, then they stay cached.
if (-not $SkipOcr) {
    Write-Host ""
    Write-Host "tesseract.js $TESS_VERSION" -ForegroundColor Cyan
    $tessBase = "https://cdn.jsdelivr.net/npm/tesseract.js@$TESS_VERSION"
    Get-Dep "$tessBase/dist/tesseract.min.js" 'tesseract/tesseract.min.js' | Out-Null
    Get-Dep "$tessBase/dist/worker.min.js"    'tesseract/worker.min.js'    | Out-Null

    # Resolve the matching core build.
    $coreVersion = '7.0.0'
    try {
        $meta = Invoke-RestMethod -Uri 'https://registry.npmjs.org/tesseract.js-core/latest' -UseBasicParsing -TimeoutSec 60
        if ($meta.version -like '7.*') { $coreVersion = $meta.version }
    } catch {
        Write-Host "  (could not resolve tesseract.js-core version, using $coreVersion)" -ForegroundColor DarkYellow
    }
    Write-Host "tesseract.js-core $coreVersion" -ForegroundColor Cyan
    $coreBase = "https://cdn.jsdelivr.net/npm/tesseract.js-core@$coreVersion"

    # tesseract.js picks a build at runtime from what the device supports, so
    # every variant has to be present or OCR fails on whichever machine gets
    # the missing one. v7 prefers relaxed SIMD and falls back down this list.
    # LSTM-only builds are about half the size and are all modern tessdata needs.
    $coreFiles = @(
        'tesseract-core-relaxedsimd-lstm.wasm.js','tesseract-core-relaxedsimd-lstm.wasm',
        'tesseract-core-relaxedsimd.wasm.js','tesseract-core-relaxedsimd.wasm',
        'tesseract-core-simd-lstm.wasm.js','tesseract-core-simd-lstm.wasm',
        'tesseract-core-simd.wasm.js','tesseract-core-simd.wasm',
        'tesseract-core-lstm.wasm.js','tesseract-core-lstm.wasm',
        'tesseract-core.wasm.js','tesseract-core.wasm'
    )
    foreach ($f in $coreFiles) {
        Get-Dep "$coreBase/$f" "tesseract/core/$f" -Optional | Out-Null
    }

    Write-Host "tessdata (English)" -ForegroundColor Cyan
    Get-Dep 'https://tessdata.projectnaptha.com/4.0.0/eng.traineddata.gz' `
            'tesseract/lang/eng.traineddata.gz' -Optional | Out-Null
}

# ---------------------------------------------------------------- piper ----
# Piper neural TTS. Three packages that have to agree with each other:
#   vits-web        - the orchestration layer (voice list, OPFS caching)
#   piper-wasm      - espeak-ng phonemiser; the 17 MB .data file is its
#                     pronunciation dictionary and is not optional
#   onnxruntime-web - runs the VITS model
#
# Voice models themselves are NOT vendored: they are ~63 MB each, there are
# many, and vits-web already caches them in the Origin Private File System
# after the first download.
if (-not $SkipPiper) {
    Write-Host ""
    Write-Host "piper (vits-web $VITS_VERSION)" -ForegroundColor Cyan
    $vitsBase = "https://cdn.jsdelivr.net/npm/@diffusionstudio/vits-web@$VITS_VERSION/dist"
    Get-Dep "$vitsBase/vits-web.js"          'piper/vits-web.js'          | Out-Null
    Get-Dep "$vitsBase/piper-DeOu3H9E.js"    'piper/piper-DeOu3H9E.js'    | Out-Null

    Write-Host "piper-wasm $PIPERWASM_VERSION (phonemiser)" -ForegroundColor Cyan
    $pwBase = "https://cdn.jsdelivr.net/npm/@diffusionstudio/piper-wasm@$PIPERWASM_VERSION/build/piper_phonemize"
    Get-Dep "$pwBase.js"   'piper/piper_phonemize.js'   | Out-Null
    Get-Dep "$pwBase.wasm" 'piper/piper_phonemize.wasm' | Out-Null
    Get-Dep "$pwBase.data" 'piper/piper_phonemize.data' | Out-Null

    Write-Host "onnxruntime-web $ORT_VERSION" -ForegroundColor Cyan
    $ortBase = "https://cdn.jsdelivr.net/npm/onnxruntime-web@$ORT_VERSION/dist"
    # The wasm-only ESM backend: no WebGL or WebGPU, which we do not use and
    # which would pull in another 20 MB of binaries.
    Get-Dep "$ortBase/esm/ort.wasm.min.js" 'onnxruntime/ort.wasm.min.js' | Out-Null
    # Both SIMD and plain builds: the loader feature-detects and asks for one
    # of them by name, and a missing variant is a hard failure at runtime.
    Get-Dep "$ortBase/ort-wasm-simd.wasm"  'onnxruntime/ort-wasm-simd.wasm'  | Out-Null
    Get-Dep "$ortBase/ort-wasm.wasm"       'onnxruntime/ort-wasm.wasm'       | Out-Null
}
# ---------------------------------------------------------------- compat ----
# pdf.js 6 is built against a very recent JavaScript baseline: it calls
# language features that reached Safari between 17.4 and 26. On an iPhone even
# slightly behind, importing a PDF dies with "undefined is not a function".
# The worker bundle runs in its own realm and cannot see the page's polyfill,
# so the shim is injected into both bundles here rather than shipped as a
# separate file.
function Add-Compat {
    param([string]$Relative)

    $full = Join-Path $vendor $Relative
    if (-not (Test-Path $full)) { return }

    # What pdf.js needs and WebKit may not have. Everything here is called on
    # the path a document actually takes, so a missing one is not a degraded
    # feature, it is a file that will not open:
    #   Promise.withResolvers      - Safari 17.4; called in dozens of places
    #   ReadableStream async iter. - still absent; pdf.js consumes its text
    #                                stream with `for await (... of stream)`,
    #                                so getTextContent throws without it
    #   Promise.try                - Safari 18.2; the worker message handler
    #                                wraps every single call in it
    #   Uint8Array to/fromBase64   - Safari 18.2; document fingerprints and
    #                                embedded font CSS
    #   Math.sumPrecise            - Safari 18.4; the font sanitiser sizes
    #                                every glyph table with it
    #   Map/WeakMap.getOrInsert*   - Safari 26; dictionary parsing, and
    #                                getMetadata throws without it, which is
    #                                how a document ends up titled after the
    #                                journal's masthead
    # Kept as one line and wrapped in an IIFE: the bundles are minified modules
    # whose top-level names are single letters, so anything the shim declares
    # at module scope would eventually collide with one of them.
    # The worker bundle runs in its own realm and cannot see the page polyfill,
    # so the shim goes into both bundles.
    $shim = '/*mr-compat*/(function(){if(typeof Promise!=="undefined"&&!Promise.withResolvers){Promise.withResolvers=function(){let a,b;const p=new Promise((x,y)=>{a=x;b=y});return{promise:p,resolve:a,reject:b}}}if(typeof Promise!=="undefined"&&!Promise.try){Promise.try=function(f,...a){return new Promise(r=>r(f(...a)))}}const D=(o,n,v)=>{if(o&&!(n in o))Object.defineProperty(o,n,{value:v,writable:true,configurable:true})};const gi=function(k,v){if(!this.has(k))this.set(k,v);return this.get(k)};const gic=function(k,f){if(!this.has(k))this.set(k,f(k));return this.get(k)};if(typeof Map!=="undefined"){D(Map.prototype,"getOrInsert",gi);D(Map.prototype,"getOrInsertComputed",gic)}if(typeof WeakMap!=="undefined"){D(WeakMap.prototype,"getOrInsert",gi);D(WeakMap.prototype,"getOrInsertComputed",gic)}if(!Math.sumPrecise){Math.sumPrecise=function(xs){let s=0,c=0;for(const x of xs){const t=s+x;c+=Math.abs(s)>=Math.abs(x)?(s-t)+x:(x-t)+s;s=t}return s+c}}if(typeof Uint8Array!=="undefined"){D(Uint8Array.prototype,"toHex",function(){let s="";for(let i=0;i<this.length;i++)s+=this[i].toString(16).padStart(2,"0");return s});if(typeof btoa!=="undefined")D(Uint8Array.prototype,"toBase64",function(){let s="";for(let i=0;i<this.length;i+=8192)s+=String.fromCharCode.apply(null,this.subarray(i,i+8192));return btoa(s)});if(typeof atob!=="undefined")D(Uint8Array,"fromBase64",function(b){const s=atob(b),u=new Uint8Array(s.length);for(let i=0;i<s.length;i++)u[i]=s.charCodeAt(i);return u})}if(typeof ReadableStream!=="undefined"&&typeof Symbol!=="undefined"&&Symbol.asyncIterator&&!ReadableStream.prototype[Symbol.asyncIterator]){const v=function(o){const pc=!!(o&&o.preventCancel);const r=this.getReader();return{next(){return r.read().then(x=>{if(x.done)r.releaseLock();return x},e=>{r.releaseLock();throw e})},return(x){if(pc){r.releaseLock();return Promise.resolve({done:true,value:x})}return r.cancel(x).then(()=>{r.releaseLock();return{done:true,value:x}})},throw(e){r.releaseLock();return Promise.reject(e)},[Symbol.asyncIterator](){return this}}};const d={value:v,writable:true,configurable:true};Object.defineProperty(ReadableStream.prototype,Symbol.asyncIterator,d);if(!ReadableStream.prototype.values){Object.defineProperty(ReadableStream.prototype,"values",d)}}})();'

    $lines = [IO.File]::ReadAllText($full)
    # Drop any previous shim so re-running always installs the current one.
    if ($lines.StartsWith('/*mr-compat*/')) {
        $nl = $lines.IndexOf("`n")
        $lines = $lines.Substring($nl + 1)
    }
    [IO.File]::WriteAllText($full, $shim + [Environment]::NewLine + $lines, (New-Object Text.UTF8Encoding($false)))
    Write-Host ("  shim  {0}" -f $Relative) -ForegroundColor Green
}

Write-Host ""
# vits-web ships expecting a bundler. Three things must change before it can
# run from a plain <script type="module"> on a static host.
function Patch-Vits {
    $full = Join-Path $vendor 'piper/vits-web.js'
    if (-not (Test-Path $full)) { return }
    $src = [IO.File]::ReadAllText($full)
    $hits = 0

    # 1. A bare specifier. Nothing resolves "onnxruntime-web" in a browser
    #    without an import map or a bundler, so point it at the vendored file.
    if ($src -match 'import\("onnxruntime-web"\)') {
        $src = $src -replace 'import\("onnxruntime-web"\)', 'import("../onnxruntime/ort.wasm.min.js")'
        $hits++
    }

    # 2. Multi-threaded WASM needs SharedArrayBuffer, which needs the page to
    #    be cross-origin isolated (COOP + COEP). GitHub Pages sends neither
    #    header and they cannot be added, so threading would fail at runtime.
    if ($src -match 'wasm\.numThreads\s*=\s*navigator\.hardwareConcurrency') {
        $src = $src -replace 'wasm\.numThreads\s*=\s*navigator\.hardwareConcurrency', 'wasm.numThreads=1'
        $hits++
    }

    # 3. Runtime assets must come from our own origin, not a CDN, or the app
    #    stops working the moment it goes offline.
    $before = $src
    $src = $src -replace '"https://cdnjs\.cloudflare\.com/ajax/libs/onnxruntime-web/[0-9.]+/"', 'new URL("../onnxruntime/",import.meta.url).href'
    $src = $src -replace '"https://cdn\.jsdelivr\.net/npm/@diffusionstudio/piper-wasm@[0-9.]+/build/piper_phonemize"', 'new URL("./piper_phonemize",import.meta.url).href'
    if ($src -ne $before) { $hits += 2 }

    # 4. Upstream bug: download() fires the OPFS write without awaiting it, so
    #    the promise resolves while a 63 MB write is still in flight and the
    #    next read gets a truncated model ("No graph was found in the
    #    protobuf"). predict()'s own on-demand path awaits correctly; only the
    #    explicit download() API is affected.
    $pat = '(\s)p\(a, await S\('
    if ($src -match $pat) {
        $src = $src -replace $pat, '$1await p(a, await S('
        $hits++
    }
    [IO.File]::WriteAllText($full, $src, (New-Object Text.UTF8Encoding($false)))
    Write-Host ("  patch piper/vits-web.js  ({0} rewrites)" -f $hits) -ForegroundColor Green
}
Write-Host "Compatibility shims" -ForegroundColor Cyan
Add-Compat 'pdfjs/pdf.min.mjs'
Add-Compat 'pdfjs/pdf.worker.min.mjs'
if (-not $SkipPiper) { Patch-Vits }

# ------------------------------------------------------------------ done ----
$total = (Get-ChildItem -Recurse -File $vendor | Measure-Object -Property Length -Sum).Sum
Write-Host ""
Write-Host ("Done. vendor/ is {0:N1} MB" -f ($total / 1MB)) -ForegroundColor Cyan
Write-Host ""
