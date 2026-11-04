@echo off
REM Dijalankan oleh Task Scheduler (akun SYSTEM) saat Windows menyala. Jangan dijalankan manual:
REM pakai menu.bat. Server dinyalakan ulang otomatis bila berhenti; log di backend\data\server.log
setlocal
cd /d "%~dp0..\backend"
set "NODE=node"
if exist "%~dp0node-path.txt" set /p NODE=<"%~dp0node-path.txt"
if exist "%~dp0port.txt" set /p PORT=<"%~dp0port.txt"
if "%PORT%"=="" set PORT=3000
set NODE_ENV=production
set "DBMON_STATIC_DIR=..\frontend\dist"
if not exist data mkdir data

:loop
REM Log maksimal 10 MB, lalu digulir ke server.old.log
if exist data\server.log for %%F in (data\server.log) do if %%~zF GTR 10485760 move /y data\server.log data\server.old.log >nul
echo [%date% %time%] Menyalakan server di port %PORT% >> data\server.log
"%NODE%" --disable-warning=ExperimentalWarning dist\index.js >> data\server.log 2>&1
echo [%date% %time%] Server berhenti (kode %errorlevel%), dinyalakan ulang dalam 10 detik >> data\server.log
ping -n 11 127.0.0.1 >nul
goto loop
