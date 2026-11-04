@echo off
REM Dijalankan oleh Task Scheduler (akun SYSTEM) saat Windows menyala. Pakai menu-agent.bat untuk memasang.
REM Agen dinyalakan ulang otomatis bila berhenti; log di agent.log (folder ini).
REM Opsional, hapus "REM " untuk membatasi IP yang boleh mengambil data:
REM set DBMON_AGENT_ALLOW=192.168.1.
setlocal
cd /d "%~dp0"
set "NODE=node"
if exist "%~dp0node-path.txt" set /p NODE=<"%~dp0node-path.txt"
if exist "%~dp0port.txt" set /p DBMON_AGENT_PORT=<"%~dp0port.txt"
if "%DBMON_AGENT_PORT%"=="" set DBMON_AGENT_PORT=9187

:loop
if exist agent.log for %%F in (agent.log) do if %%~zF GTR 5242880 move /y agent.log agent.old.log >nul
echo [%date% %time%] Menyalakan agen di port %DBMON_AGENT_PORT% >> agent.log
"%NODE%" dbmon-agent.mjs >> agent.log 2>&1
echo [%date% %time%] Agen berhenti (kode %errorlevel%), dinyalakan ulang dalam 10 detik >> agent.log
ping -n 11 127.0.0.1 >nul
goto loop
