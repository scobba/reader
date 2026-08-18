<#
  A tiny static file server, so the app can be tested locally without
  installing Node or Python. Service workers require an http(s) origin —
  opening index.html as a file:// URL will not work.

      powershell -ExecutionPolicy Bypass -File tools\serve.ps1
      powershell -ExecutionPolicy Bypass -File tools\serve.ps1 -Port 8080 -Lan

  -Lan also binds your local network address so you can open the app on a
  phone on the same wifi. Note that iOS will not install a PWA or run a
  service worker over plain http from anything except localhost, so use -Lan
  for a quick look only; deploy for real testing on a phone.
#>
[CmdletBinding()]
param([int]$Port = 8123, [switch]$Lan)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot

$mime = @{
  '.html'='text/html; charset=utf-8'; '.htm'='text/html; charset=utf-8'
  '.js'  ='text/javascript; charset=utf-8'
  '.mjs' ='text/javascript; charset=utf-8'
  '.css' ='text/css; charset=utf-8'
  '.json'='application/json; charset=utf-8'
  '.webmanifest'='application/manifest+json; charset=utf-8'
  '.svg' ='image/svg+xml'; '.png'='image/png'; '.jpg'='image/jpeg'; '.ico'='image/x-icon'
  '.wasm'='application/wasm'
  '.pfb' ='application/octet-stream'; '.ttf'='font/ttf'; '.otf'='font/otf'
  '.gz'  ='application/gzip'
  '.txt' ='text/plain; charset=utf-8'; '.md'='text/plain; charset=utf-8'
  '.pdf' ='application/pdf'
  '.traineddata'='application/octet-stream'
}

$listener = New-Object System.Net.HttpListener
$prefixes = @("http://localhost:$Port/")
if ($Lan) { $prefixes += "http://+:$Port/" }
foreach ($p in $prefixes) { $listener.Prefixes.Add($p) }

try {
  $listener.Start()
} catch {
  Write-Host ""
  Write-Host "Could not bind port $Port." -ForegroundColor Red
  if ($Lan) {
    Write-Host "Binding all interfaces needs an elevated prompt. Try without -Lan," -ForegroundColor Yellow
    Write-Host "or run this window as Administrator." -ForegroundColor Yellow
  } else {
    Write-Host "Something else is probably using it. Try -Port 8124." -ForegroundColor Yellow
  }
  exit 1
}

Write-Host ""
Write-Host "Mobile Reader is being served from" -ForegroundColor Cyan
Write-Host "  $root"
Write-Host ""
Write-Host "  http://localhost:$Port/" -ForegroundColor Green
if ($Lan) {
  $ip = (Get-NetIPAddress -AddressFamily IPv4 |
         Where-Object { $_.IPAddress -notlike '127.*' -and $_.PrefixOrigin -ne 'WellKnown' } |
         Select-Object -First 1).IPAddress
  if ($ip) { Write-Host "  http://${ip}:$Port/  (same wifi)" -ForegroundColor Green }
}
Write-Host ""
Write-Host "Press Ctrl+C to stop." -ForegroundColor DarkGray
Write-Host ""

try {
  while ($listener.IsListening) {
    $ctx = $listener.GetContext()
    $req = $ctx.Request
    $res = $ctx.Response

    try {
      $rel = [System.Uri]::UnescapeDataString($req.Url.AbsolutePath).TrimStart('/')
      if ([string]::IsNullOrWhiteSpace($rel)) { $rel = 'index.html' }
      $full = Join-Path $root ($rel -replace '/', '\')

      if ((Test-Path $full -PathType Container)) { $full = Join-Path $full 'index.html' }

      # Keep requests inside the project directory.
      $resolved = $null
      try { $resolved = (Resolve-Path -LiteralPath $full -ErrorAction Stop).Path } catch { }

      if (-not $resolved -or -not $resolved.StartsWith($root, [StringComparison]::OrdinalIgnoreCase)) {
        $res.StatusCode = 404
        $body = [Text.Encoding]::UTF8.GetBytes("404 Not Found: /$rel")
        $res.ContentType = 'text/plain; charset=utf-8'
        $res.ContentLength64 = $body.Length
        $res.OutputStream.Write($body, 0, $body.Length)
      } else {
        $ext = [IO.Path]::GetExtension($resolved).ToLowerInvariant()
        $type = $mime[$ext]
        if (-not $type) { $type = 'application/octet-stream' }

        $bytes = [IO.File]::ReadAllBytes($resolved)
        $res.StatusCode = 200
        $res.ContentType = $type
        # The service worker manages its own versioning; never let the browser
        # cache during development or you will chase ghosts.
        $res.Headers.Add('Cache-Control', 'no-store, must-revalidate')
        $res.Headers.Add('Service-Worker-Allowed', '/')
        $res.ContentLength64 = $bytes.Length
        $res.OutputStream.Write($bytes, 0, $bytes.Length)

        $short = $resolved.Substring($root.Length).TrimStart('\')
        Write-Host ("  200  {0}  ({1:N0} B)" -f $short, $bytes.Length) -ForegroundColor DarkGray
      }
    } catch {
      try {
        $res.StatusCode = 500
        $body = [Text.Encoding]::UTF8.GetBytes("500 " + $_.Exception.Message)
        $res.ContentLength64 = $body.Length
        $res.OutputStream.Write($body, 0, $body.Length)
      } catch { }
      Write-Host ("  500  " + $_.Exception.Message) -ForegroundColor Red
    } finally {
      try { $res.OutputStream.Close() } catch { }
    }
  }
} finally {
  $listener.Stop()
  $listener.Close()
}
