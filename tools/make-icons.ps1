<#
  Renders the PNG app icons that iOS needs (it will not use an SVG for the
  home-screen icon). Uses GDI+ so no image tooling has to be installed.

      powershell -ExecutionPolicy Bypass -File tools\make-icons.ps1

  The artwork is the same mark as icons/icon.svg, drawn from the same numbers
  on the same 512 grid. Two things let one design survive being written twice:
  the R is a monoline stroke — a stem, a bowl and a leg — rather than a font
  glyph, since GDI+ and a browser would not agree on any typeface; and both
  gradients are given explicit endpoints, so neither renderer has to resolve
  them against a bounding box. Change one file and change the other.
#>
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$root = Split-Path -Parent $PSScriptRoot
$out  = Join-Path $root 'icons'
if (-not (Test-Path $out)) { New-Item -ItemType Directory -Force -Path $out | Out-Null }

$BG_FROM  = '#FFFDFB'
$BG_TO    = '#EFEBFA'
$INK_FROM = '#FF6B4A'
$INK_TO   = '#5B4BE8'

function New-Icon {
    param([int]$Size, [string]$Path, [switch]$Maskable)

    $bmp = New-Object System.Drawing.Bitmap($Size, $Size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode     = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic

    # Maskable icons get cropped to a circle by the launcher, so the artwork
    # is scaled into the safe zone and the background bleeds to the edge.
    $s = $Size / 512.0
    $inset = if ($Maskable) { 0.14 } else { 0.0 }
    # A point on the 512 grid, and a bare length on it.
    $at  = { param($v) [float](($v * $s) * (1 - $inset * 2) + ($Size * $inset)) }
    $len = { param($v) [float](($v * $s) * (1 - $inset * 2)) }

    $col = { param($hex) [System.Drawing.ColorTranslator]::FromHtml($hex) }
    $pt  = { param($x, $y) New-Object System.Drawing.PointF($x, $y) }

    # ── background ────────────────────────────────────────────────────
    $bg = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
        (& $pt 0 0), (& $pt ([float]$Size) ([float]$Size)),
        (& $col $BG_FROM), (& $col $BG_TO))

    if ($Maskable) {
        $g.FillRectangle($bg, 0, 0, $Size, $Size)
    } else {
        # 112 of 512, the rx on the rect in icon.svg.
        $r = [float]($Size * 0.21875)
        $p = New-Object System.Drawing.Drawing2D.GraphicsPath
        $p.AddArc(0, 0, $r*2, $r*2, 180, 90)
        $p.AddArc($Size-$r*2, 0, $r*2, $r*2, 270, 90)
        $p.AddArc($Size-$r*2, $Size-$r*2, $r*2, $r*2, 0, 90)
        $p.AddArc(0, $Size-$r*2, $r*2, $r*2, 90, 90)
        $p.CloseFigure()
        $g.FillPath($bg, $p)
        $p.Dispose()
    }
    $bg.Dispose()

    # ── the R ─────────────────────────────────────────────────────────
    $ink = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
        (& $pt (& $at 185.6) (& $at 112)),
        (& $pt (& $at 326.4) (& $at 400)),
        (& $col $INK_FROM), (& $col $INK_TO))

    $pen = New-Object System.Drawing.Pen($ink, (& $len 56))
    $pen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
    $pen.EndCap   = [System.Drawing.Drawing2D.LineCap]::Round
    $pen.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round

    # stem
    $g.DrawLine($pen, (& $at 168), (& $at 400), (& $at 168), (& $at 112))
    # bowl: top bar, the semicircle that closes it, bottom bar
    $g.DrawLine($pen, (& $at 168), (& $at 112), (& $at 254), (& $at 112))
    $g.DrawArc($pen, (& $at 190), (& $at 112), (& $len 128), (& $len 128), -90, 180)
    $g.DrawLine($pen, (& $at 254), (& $at 240), (& $at 168), (& $at 240))
    # leg
    $g.DrawLine($pen, (& $at 246), (& $at 240), (& $at 344), (& $at 400))

    $pen.Dispose()
    $ink.Dispose()

    $g.Dispose()
    $bmp.Save($Path, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
    Write-Host ("  ok    {0}  ({1}x{1})" -f (Split-Path -Leaf $Path), $Size) -ForegroundColor Green
}

Write-Host ""
Write-Host "Rendering app icons" -ForegroundColor Cyan
New-Icon -Size 180 -Path (Join-Path $out 'icon-180.png')
New-Icon -Size 192 -Path (Join-Path $out 'icon-192.png')
New-Icon -Size 512 -Path (Join-Path $out 'icon-512.png') -Maskable
Write-Host ""
