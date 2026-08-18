<#
  Renders the PNG app icons that iOS needs (it will not use an SVG for the
  home-screen icon). Uses GDI+ so no image tooling has to be installed.

      powershell -ExecutionPolicy Bypass -File tools\make-icons.ps1
#>
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$root = Split-Path -Parent $PSScriptRoot
$out  = Join-Path $root 'icons'
if (-not (Test-Path $out)) { New-Item -ItemType Directory -Force -Path $out | Out-Null }

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
    $art = { param($v) [float](($v * $s) * (1 - $inset * 2) + ($Size * $inset)) }

    # background
    $bgRect = New-Object System.Drawing.RectangleF(0, 0, $Size, $Size)
    $bg = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
        $bgRect,
        [System.Drawing.ColorTranslator]::FromHtml('#1d2530'),
        [System.Drawing.ColorTranslator]::FromHtml('#0d1116'),
        90.0)
    if ($Maskable) {
        $g.FillRectangle($bg, $bgRect)
    } else {
        $r = [float]($Size * 0.22)
        $p = New-Object System.Drawing.Drawing2D.GraphicsPath
        $p.AddArc(0, 0, $r*2, $r*2, 180, 90)
        $p.AddArc($Size-$r*2, 0, $r*2, $r*2, 270, 90)
        $p.AddArc($Size-$r*2, $Size-$r*2, $r*2, $r*2, 0, 90)
        $p.AddArc(0, $Size-$r*2, $r*2, $r*2, 90, 90)
        $p.CloseFigure()
        $g.FillPath($bg, $p)
        $p.Dispose()
    }

    # page
    $page = New-Object System.Drawing.SolidBrush ([System.Drawing.ColorTranslator]::FromHtml('#f2f5f9'))
    $px = & $art 112; $py = & $art 86
    $pw = (& $art 342) - $px; $ph = (& $art 386) - $py
    $rr = [float]($pw * 0.095)
    $pp = New-Object System.Drawing.Drawing2D.GraphicsPath
    $pp.AddArc($px, $py, $rr*2, $rr*2, 180, 90)
    $pp.AddArc($px+$pw-$rr*2, $py, $rr*2, $rr*2, 270, 90)
    $pp.AddArc($px+$pw-$rr*2, $py+$ph-$rr*2, $rr*2, $rr*2, 0, 90)
    $pp.AddArc($px, $py+$ph-$rr*2, $rr*2, $rr*2, 90, 90)
    $pp.CloseFigure()
    $g.FillPath($page, $pp)
    $pp.Dispose()

    # text lines
    $line = New-Object System.Drawing.SolidBrush ([System.Drawing.ColorTranslator]::FromHtml('#aab4c2'))
    $lens = @(162, 162, 128, 150, 96)
    for ($i = 0; $i -lt $lens.Count; $i++) {
        $ly = & $art (134 + $i * 43)
        $lx = & $art 146
        $lw = (& $art (146 + $lens[$i])) - $lx
        $lh = (& $art 149) - (& $art 134)
        $g.FillRectangle($line, $lx, $ly, $lw, $lh)
    }

    # sound arcs
    $accent = [System.Drawing.ColorTranslator]::FromHtml('#4b91ff')
    $pen = New-Object System.Drawing.Pen($accent, [float]((& $art 26) - (& $art 0)))
    $pen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
    $pen.EndCap   = [System.Drawing.Drawing2D.LineCap]::Round
    $g.DrawArc($pen, (& $art 300), (& $art 198), (& $art 116) - (& $art 0), (& $art 116) - (& $art 0), -55, 110)
    $g.DrawArc($pen, (& $art 262), (& $art 152), (& $art 208) - (& $art 0), (& $art 208) - (& $art 0), -55, 110)
    $pen.Dispose()

    # play badge
    $badge = New-Object System.Drawing.SolidBrush $accent
    $cx = & $art 330; $cy = & $art 378; $rad = (& $art 76) - (& $art 0)
    $g.FillEllipse($badge, $cx - $rad, $cy - $rad, $rad*2, $rad*2)

    $tri = New-Object System.Drawing.SolidBrush ([System.Drawing.ColorTranslator]::FromHtml('#0d1116'))
    $pts = @(
        (New-Object System.Drawing.PointF((& $art 312), (& $art 348))),
        (New-Object System.Drawing.PointF((& $art 364), (& $art 378))),
        (New-Object System.Drawing.PointF((& $art 312), (& $art 408)))
    )
    $g.FillPolygon($tri, $pts)

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
