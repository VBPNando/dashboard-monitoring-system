@echo off
REM ==================================================================
REM  Monitoring Agent - MENU (jalankan di SERVER DATABASE)
REM  Klik dua kali. Menu otomatis meminta izin administrator.
REM ==================================================================
setlocal EnableExtensions
cd /d "%~dp0"
title Monitoring Agent - Menu

net session >nul 2>&1
if errorlevel 1 (
  echo Meminta izin administrator...
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)

set "TASK=Monitoring Agent"
set "PS=powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0autostart.ps1""
set PORT=
if exist "port.txt" set /p PORT=<"port.txt"
if "%PORT%"=="" set PORT=9187

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo Node.js belum terpasang di server ini. Pasang Node.js LTS dari https://nodejs.org lalu buka menu ini lagi.
  pause
  exit /b 1
)

:menu
cls
echo ==================================================================
echo   MONITORING AGENT  -  CPU, RAM ^& DISK SERVER INI
echo ==================================================================
%PS% -Action status -Name "%TASK%" -Port %PORT%
echo ------------------------------------------------------------------
echo   1. Pasang JALAN OTOMATIS (menyala sendiri saat Windows hidup)
echo   2. Hapus jalan otomatis
echo   3. Nyalakan ulang agen
echo   4. Hentikan agen
echo   5. Tampilkan Agent URL ^& Token (untuk diisi di dashboard)
echo   6. Lihat log agen
echo   T. Jalankan di jendela ini saja (untuk mencoba)
echo   0. Keluar
echo ------------------------------------------------------------------
set "CH="
set /p CH=Pilih: 
if "%CH%"=="1" goto install
if "%CH%"=="2" goto remove
if "%CH%"=="3" goto restart
if "%CH%"=="4" goto stop
if "%CH%"=="5" goto show
if "%CH%"=="6" goto log
if /i "%CH%"=="T" goto try
if "%CH%"=="0" exit /b 0
goto menu

:install
echo.
%PS% -Action install -Name "%TASK%" -Script "%~dp0run-agent.bat" -Port %PORT%
goto show

:remove
echo.
%PS% -Action remove -Name "%TASK%" -Port %PORT%
goto pause

:restart
echo.
%PS% -Action restart -Name "%TASK%" -Port %PORT%
goto pause

:stop
echo.
%PS% -Action stop -Name "%TASK%" -Port %PORT%
goto pause

:show
echo.
if not exist "agent-token.txt" (
  echo Token belum dibuat. Jalankan agen dulu ^(menu 1 atau T^).
  goto pause
)
echo   Isi di dashboard: panel database - menu ... - Atur agen CPU ^& RAM
echo.
echo   Agent URL (pilih IP yang bisa dijangkau komputer dashboard):
%PS% -Action ips -Name "%TASK%" -Port %PORT%
echo.
set /p TOKEN=<"agent-token.txt"
echo   Token:
echo     %TOKEN%
goto pause

:log
if exist "agent.log" (start "" notepad "agent.log") else (echo. & echo Belum ada log. & goto pause)
goto menu

:try
%PS% -Action status -Name "%TASK%" -Port %PORT% | findstr /c:"BERJALAN" >nul
if not errorlevel 1 (
  echo.
  echo Agen sudah berjalan di latar belakang. Hentikan dulu ^(menu 4^) bila ingin menjalankan di jendela ini.
  goto pause
)
set DBMON_AGENT_PORT=%PORT%
node dbmon-agent.mjs
goto pause

:pause
echo.
pause
goto menu
