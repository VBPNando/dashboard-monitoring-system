@echo off
REM Monitoring Agent untuk Windows: kirim CPU, RAM & disk server ini ke Dashboard Monitoring System.
REM Jalankan di SERVER DATABASE (mis. komputer XAMPP). Butuh Node.js 18 atau lebih baru.
REM
REM Opsional, hapus "REM " untuk mengaktifkan:
REM set DBMON_AGENT_PORT=9187
REM set DBMON_AGENT_ALLOW=192.168.1.
setlocal
title Monitoring Agent
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo Node.js belum terpasang di server ini. Pasang versi LTS dari https://nodejs.org
  goto stop
)

REM Izinkan port agen di Windows Firewall (butuh "Run as administrator"; diabaikan bila tidak)
if "%DBMON_AGENT_PORT%"=="" set DBMON_AGENT_PORT=9187
netsh advfirewall firewall show rule name="DB Monitor Agent" >nul 2>nul
if errorlevel 1 (
  netsh advfirewall firewall add rule name="DB Monitor Agent" dir=in action=allow protocol=TCP localport=%DBMON_AGENT_PORT% >nul 2>nul
  if errorlevel 1 echo Catatan: aturan firewall belum dibuat. Jalankan file ini dengan klik kanan - Run as administrator, atau buka port %DBMON_AGENT_PORT% secara manual.
)

node dbmon-agent.mjs
echo.
echo Agen berhenti.

:stop
echo.
pause
