# Read-only Wi-Fi probe for the laptop. Writes to data/private/ (gitignored).
# Lists every visible BSSID with SSID, band, channel and signal %, plus the current connection.
# Run from the project folder:  powershell -ExecutionPolicy Bypass -File tools\probe-wifi.ps1
$out = Join-Path $PSScriptRoot '..\data\private'
New-Item -ItemType Directory -Force $out | Out-Null
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$file = Join-Path $out "probe-$stamp.txt"
"== current connection ==" | Out-File $file
netsh wlan show interfaces | Out-File $file -Append
"`n== visible networks (BSSID mode) ==" | Out-File $file -Append
netsh wlan show networks mode=bssid | Out-File $file -Append
Write-Host "Saved $file (contains BSSIDs; keep private)"
