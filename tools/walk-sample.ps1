# Walk survey with the laptop: logs every visible Wi-Fi radio (BSSID) every few seconds.
#
#   powershell -ExecutionPolicy Bypass -File tools\walk-sample.ps1
#   powershell -ExecutionPolicy Bypass -File tools\walk-sample.ps1 -Once        (one scan, then stop)
#
# Leave it running in its own window while you walk. In the page, press S and
# click where you stand. Afterwards run:  node tools\survey-import.mjs
#
# What it does: it asks Windows for a fresh scan (the same thing the Wi-Fi list
# of the taskbar does), reads the result with "netsh wlan show networks
# mode=bssid", and appends one row per BSSID to data\private\scans-laptop.ndjson.
# It changes no setting and connects to nothing. Stop it with Ctrl+C.
#
# The numbers are approximate. Windows reports signal as a percentage, not in
# dBm. The script converts it with dBm = percent / 2 - 100 and marks every row
# "approx". 100 % is everything above about -50 dBm, so strong signals are cut
# off there. The Raspberry Pi scanner (collectors\pi\survey.py) gives real dBm.
#
# The log contains network names and BSSIDs: it stays in data\private\ (gitignored).
param(
  [int]$IntervalSeconds = 4,
  [string]$Out = '',
  [switch]$Once,
  [int]$MaxMinutes = 180,
  [string]$Node = 'survey-laptop',
  [switch]$NoFreshScan
)
Set-StrictMode -Version 2
$ErrorActionPreference = 'Stop'
if (-not $Out) { $Out = Join-Path $PSScriptRoot '..\data\private\scans-laptop.ndjson' }
$Out = [System.IO.Path]::GetFullPath($Out)
New-Item -ItemType Directory -Force (Split-Path $Out) | Out-Null
$utf8 = New-Object System.Text.UTF8Encoding($false)

# Windows keeps the last scan for up to a minute. WlanScan asks for a new one.
$freshScanReady = $false
if (-not $NoFreshScan) {
  try {
    Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class AtlasWlan {
  [DllImport("wlanapi.dll")] static extern uint WlanOpenHandle(uint version, IntPtr reserved, out uint negotiated, out IntPtr handle);
  [DllImport("wlanapi.dll")] static extern uint WlanCloseHandle(IntPtr handle, IntPtr reserved);
  [DllImport("wlanapi.dll")] static extern uint WlanEnumInterfaces(IntPtr handle, IntPtr reserved, out IntPtr list);
  [DllImport("wlanapi.dll")] static extern uint WlanScan(IntPtr handle, ref Guid iface, IntPtr ssid, IntPtr ie, IntPtr reserved);
  [DllImport("wlanapi.dll")] static extern void WlanFreeMemory(IntPtr memory);
  // Asks every Wi-Fi adapter for a new scan. Returns how many adapters were asked, or minus the error code.
  public static int RequestScan() {
    uint negotiated; IntPtr handle; IntPtr list;
    uint err = WlanOpenHandle(2, IntPtr.Zero, out negotiated, out handle);
    if (err != 0) return -(int)err;
    try {
      err = WlanEnumInterfaces(handle, IntPtr.Zero, out list);
      if (err != 0) return -(int)err;
      try {
        int count = Marshal.ReadInt32(list);
        int asked = 0;
        for (int i = 0; i < count; i++) {
          IntPtr item = new IntPtr(list.ToInt64() + 8 + i * 532);   // GUID (16) + name (512) + state (4)
          Guid id = (Guid)Marshal.PtrToStructure(item, typeof(Guid));
          if (WlanScan(handle, ref id, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero) == 0) asked++;
        }
        return asked;
      } finally { WlanFreeMemory(list); }
    } finally { WlanCloseHandle(handle, IntPtr.Zero); }
  }
}
"@
    $freshScanReady = $true
  } catch {
    Write-Host "Could not load the fresh-scan helper ($($_.Exception.Message)). Windows will repeat old results for up to a minute: stand 60 seconds at each place."
  }
}

function Read-VisibleRadios {
  # One object per BSSID from the netsh text. English key names; the signal and band lines are also found by their values.
  $ssid = ''
  $radios = @()
  $current = $null
  foreach ($line in (& netsh wlan show networks mode=bssid)) {
    if ($line -match '^SSID \d+\s*:\s?(.*)$') { $ssid = $Matches[1].Trim(); continue }
    if ($line -match '^\s+BSSID \d+\s*:\s*([0-9a-fA-F:]{17})') {
      if ($current) { $radios += $current }
      $current = @{ bssid = $Matches[1].ToLower(); ssid = $ssid; pct = $null; band = $null; channel = $null }
      continue
    }
    if (-not $current) { continue }
    if ($null -eq $current.pct -and $line -match ':\s*(\d{1,3})%\s*$') { $current.pct = [int]$Matches[1]; continue }
    if ($line -match ':\s*([\d.]+)\s*GHz') {
      if ($Matches[1] -like '2*') { $current.band = '2.4' } elseif ($Matches[1] -like '5*') { $current.band = '5' } elseif ($Matches[1] -like '6*') { $current.band = '6' }
      continue
    }
    if ($null -eq $current.channel -and $line -match '^\s+Channel\s*:\s*(\d+)\s*$') { $current.channel = [int]$Matches[1]; continue }
  }
  if ($current) { $radios += $current }
  return ,$radios
}

function Write-ScanRows($radios, $time) {
  $text = New-Object System.Text.StringBuilder
  $count = 0
  foreach ($radio in $radios) {
    if ($null -eq $radio.pct) { continue }
    if (-not $radio.band -and $null -ne $radio.channel) { if ($radio.channel -le 14) { $radio.band = '2.4' } else { $radio.band = '5' } }
    if ($radio.band -ne '2.4' -and $radio.band -ne '5') { continue }
    $row = [ordered]@{
      time = $time; node_id = $Node; kind = 'scan'; bssid = $radio.bssid; ssid = $radio.ssid; band = $radio.band
      rssi_dbm = [math]::Round($radio.pct / 2.0 - 100, 1); signal_pct = $radio.pct; approx = $true
    }
    if ($null -ne $radio.channel) { $row.channel = $radio.channel }
    [void]$text.Append(($row | ConvertTo-Json -Compress)).Append("`n")
    $count++
  }
  if ($count) { [System.IO.File]::AppendAllText($Out, $text.ToString(), $utf8) }
  return $count
}

if (-not (Test-Path $Out)) {
  $meta = [ordered]@{ kind = 'meta'; source = 'laptop'; node_id = $Node; started = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ'); rssi = 'approximate: Windows signal percent converted with dBm = percent / 2 - 100' }
  [System.IO.File]::AppendAllText($Out, (($meta | ConvertTo-Json -Compress) + "`n"), $utf8)
}

Write-Host "Logging Wi-Fi scans to $Out"
Write-Host "Fresh scan every $IntervalSeconds s: $(if ($freshScanReady) { 'yes' } else { 'no (old results may repeat)' }). Signal is approximate (percent / 2 - 100). Stop with Ctrl+C."
$stopAt = (Get-Date).AddMinutes($MaxMinutes)
$total = 0
$emptyInARow = 0
while ($true) {
  $started = Get-Date
  if ($freshScanReady) {
    $asked = [AtlasWlan]::RequestScan()
    if ($asked -gt 0) { Start-Sleep -Milliseconds 2500 }     # a scan of both bands takes about 2 seconds
  }
  $radios = Read-VisibleRadios
  $time = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
  $written = Write-ScanRows $radios $time
  $total += $written
  if ($written -eq 0) {
    $emptyInARow++
    Write-Host "$((Get-Date).ToString('HH:mm:ss'))  no network found."
    if ($emptyInARow -eq 1) {
      Write-Host '  If this stays so, check three things:'
      Write-Host '  1. Wi-Fi is switched on.'
      Write-Host '  2. Windows 11 needs Location services for Wi-Fi scans: Settings > Privacy & security > Location.'
      Write-Host '     Switch on "Location services" and "Let desktop apps access your location".'
      Write-Host '  3. Run "netsh wlan show networks mode=bssid" yourself and read its message.'
    }
  } else {
    $emptyInARow = 0
    $best = $radios | Where-Object { $null -ne $_.pct } | Sort-Object { $_.pct } -Descending | Select-Object -First 1
    Write-Host "$((Get-Date).ToString('HH:mm:ss'))  $written radios, strongest $($best.pct) % (about $([math]::Round($best.pct / 2.0 - 100)) dBm), $total rows so far"
  }
  if ($Once -or (Get-Date) -gt $stopAt) { break }
  $wait = $IntervalSeconds - ((Get-Date) - $started).TotalSeconds
  if ($wait -gt 0) { Start-Sleep -Milliseconds ([int]($wait * 1000)) }
}
Write-Host "Done. $total rows in $Out (contains network names and BSSIDs: keep it private)."
