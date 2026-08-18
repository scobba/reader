<#
  vendor.ps1 - downloads third-party runtime deps into ./vendor so the app is
  fully same-origin and works offline. Run once from the project root:

      powershell -ExecutionPolicy Bypass -File tools\vendor.ps1

  Re-running is safe; existing files are skipped unless -Force is passed.
#>
[CmdletBinding()]
param([switch]$Force, [switch]$SkipOcr)

$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$ProgressPreference = 'SilentlyContinue'

$root   = Split-Path -Parent $PSScriptRoot
$vendor = Join-Path $root 'vendor'

$PDFJS_VERSION = '6.2.108'
$TESS_VERSION  = '7.0.0'

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
    'FoxitFixedItalic.pfb','FoxitSans.pfb','FoxitSansBold.pfb','FoxitSansBoldItalic.pfb',
    'FoxitSansItalic.pfb','FoxitSerif.pfb','FoxitSerifBold.pfb','FoxitSerifBoldItalic.pfb',
    'FoxitSerifItalic.pfb','FoxitSymbol.pfb',
    'LiberationSans-Bold.ttf','LiberationSans-BoldItalic.ttf',
    'LiberationSans-Italic.ttf','LiberationSans-Regular.ttf'
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

# ------------------------------------------------------------------ done ----
$total = (Get-ChildItem -Recurse -File $vendor | Measure-Object -Property Length -Sum).Sum
Write-Host ""
Write-Host ("Done. vendor/ is {0:N1} MB" -f ($total / 1MB)) -ForegroundColor Cyan
Write-Host ""
