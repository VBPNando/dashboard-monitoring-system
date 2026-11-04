# Dashboard Monitoring System - jalan otomatis lewat Windows Task Scheduler.
# Dipanggil oleh menu.bat / menu-agent.bat (butuh Run as administrator).
#   -Action install|remove|start|stop|restart|status  -Name <nama task>  -Script <bat yang dijalankan>  -Port <port TCP>
param(
  [Parameter(Mandatory = $true)][string]$Action,
  [Parameter(Mandatory = $true)][string]$Name,
  [string]$Script = '',
  [int]$Port = 0
)
$ErrorActionPreference = 'Stop'

function Get-Task { Get-ScheduledTask -TaskName $Name -ErrorAction SilentlyContinue }

function Get-PortPids {
  if ($Port -le 0) { return @() }
  try { @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction Stop | Select-Object -ExpandProperty OwningProcess -Unique) } catch { @() }
}

function Stop-All {
  $t = Get-Task
  if ($t) { try { Stop-ScheduledTask -TaskName $Name } catch {} }
  Start-Sleep -Milliseconds 800
  foreach ($p in Get-PortPids) {
    $proc = Get-Process -Id $p -ErrorAction SilentlyContinue
    if ($proc -and $proc.ProcessName -eq 'node') { Stop-Process -Id $p -Force -ErrorAction SilentlyContinue }
  }
}

function Test-Health {
  if ($Port -le 0) { return $false }
  try {
    $r = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$Port/api/health" -TimeoutSec 3
    return $true
  } catch {
    # Jawaban HTTP apa pun (404/401/403 dari agen) berarti proses hidup; gagal koneksi = mati
    return [bool]$_.Exception.Response
  }
}

switch ($Action) {
  'install' {
    if (-not (Test-Path $Script)) { Write-Host "  File tidak ditemukan: $Script"; exit 1 }
    $node = (Get-Command node -ErrorAction SilentlyContinue).Source
    if (-not $node) { Write-Host '  Node.js tidak ditemukan. Pasang Node.js LTS dari https://nodejs.org'; exit 1 }
    $dir = Split-Path -Parent $Script
    # Lokasi node.exe disimpan agar akun SYSTEM (tanpa PATH pengguna) tetap menemukannya
    [IO.File]::WriteAllText((Join-Path $dir 'node-path.txt'), $node)
    if ($Port -gt 0) { [IO.File]::WriteAllText((Join-Path $dir 'port.txt'), [string]$Port) }

    Stop-All
    $act = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument ('/c ""' + $Script + '""') -WorkingDirectory $dir
    $trg = New-ScheduledTaskTrigger -AtStartup
    $set = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
      -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew
    $pri = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
    Register-ScheduledTask -TaskName $Name -Action $act -Trigger $trg -Settings $set -Principal $pri -Force | Out-Null

    if ($Port -gt 0) {
      $rule = "$Name (TCP $Port)"
      if (-not (Get-NetFirewallRule -DisplayName $rule -ErrorAction SilentlyContinue)) {
        New-NetFirewallRule -DisplayName $rule -Direction Inbound -Action Allow -Protocol TCP -LocalPort $Port | Out-Null
      }
    }
    Start-ScheduledTask -TaskName $Name
    Write-Host '  Menunggu proses menyala...'
    for ($i = 0; $i -lt 20; $i++) { Start-Sleep -Seconds 1; if (Test-Health) { break } }
    if (Test-Health) { Write-Host "  BERHASIL: berjalan di latar belakang (port $Port) dan akan otomatis menyala setiap Windows dinyalakan." }
    else { Write-Host '  Task sudah terpasang, tetapi belum menjawab. Lihat log (menu nomor log) untuk penyebabnya.' }
  }
  'remove' {
    Stop-All
    if (Get-Task) { Unregister-ScheduledTask -TaskName $Name -Confirm:$false; Write-Host '  Jalan otomatis dihapus dan proses latar dihentikan.' }
    else { Write-Host '  Jalan otomatis memang belum terpasang.' }
  }
  'start' {
    if (-not (Get-Task)) { Write-Host '  Jalan otomatis belum terpasang. Pilih menu "Pasang jalan otomatis" dulu.'; exit 1 }
    Start-ScheduledTask -TaskName $Name
    for ($i = 0; $i -lt 20; $i++) { Start-Sleep -Seconds 1; if (Test-Health) { break } }
    if (Test-Health) { Write-Host '  Berjalan.' } else { Write-Host '  Belum menjawab. Lihat log.' }
  }
  'stop' { Stop-All; Write-Host '  Proses latar dihentikan (akan menyala lagi saat Windows restart bila jalan otomatis terpasang).' }
  'restart' {
    Stop-All
    if (Get-Task) { Start-ScheduledTask -TaskName $Name }
    for ($i = 0; $i -lt 20; $i++) { Start-Sleep -Seconds 1; if (Test-Health) { break } }
    if (Test-Health) { Write-Host '  Dinyalakan ulang, berjalan.' } else { Write-Host '  Belum menjawab. Lihat log.' }
  }
  'status' {
    $t = Get-Task
    $auto = if ($t) { 'TERPASANG' } else { 'belum dipasang' }
    $run = if (Test-Health) { "BERJALAN di port $Port" } else { "tidak berjalan (port $Port)" }
    Write-Host "  Jalan otomatis : $auto"
    Write-Host "  Status         : $run"
    $pids = Get-PortPids
    if ($pids.Count -gt 0) {
      $names = ($pids | ForEach-Object { (Get-Process -Id $_ -ErrorAction SilentlyContinue).ProcessName }) -join ', '
      Write-Host "  Port $Port dipakai : $names (PID $($pids -join ', '))"
    }
  }
  'ips' {
    Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
      Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' } |
      ForEach-Object { Write-Host "    http://$($_.IPAddress):$Port" }
  }
  default { Write-Host "Aksi tidak dikenal: $Action"; exit 1 }
}
