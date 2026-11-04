@echo off
REM Menjalankan Dashboard Monitoring System tanpa Docker (Windows). Butuh Node.js 22.13 atau lebih baru.
REM   start.bat            build bila belum ada, lalu jalankan
REM   start.bat --rebuild  paksa build ulang
setlocal
title Dashboard Monitoring System
cd /d "%~dp0"

REM Ganti port di sini bila 3000 sudah dipakai program lain, mis.: set PORT=3001
if "%PORT%"=="" set PORT=3000

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo Node.js belum terpasang. Pasang Node.js versi LTS dari https://nodejs.org
  goto stop
)
node -e "const [a,b]=process.versions.node.split('.').map(Number); process.exit(a>22||(a===22&&b>=13)?0:1)"
if errorlevel 1 (
  echo.
  echo Butuh Node.js 22.13 atau lebih baru. Versi terpasang:
  node -v
  goto stop
)

set REBUILD=0
if /i "%~1"=="--rebuild" set REBUILD=1

if "%REBUILD%"=="1" goto build_front
if not exist "frontend\dist\index.html" goto build_front
goto check_back

:build_front
echo.
echo ==^> [1/2] Menyiapkan tampilan (frontend). Pertama kali bisa beberapa menit...
pushd frontend
call npm install --no-audit --no-fund
if errorlevel 1 goto fail_popd
call npm run build
if errorlevel 1 goto fail_popd
popd

:check_back
if "%REBUILD%"=="1" goto build_back
if not exist "backend\dist\index.js" goto build_back
goto run

:build_back
echo.
echo ==^> [2/2] Menyiapkan server (backend)...
pushd backend
call npm install --no-audit --no-fund
if errorlevel 1 goto fail_popd
call npm run build
if errorlevel 1 goto fail_popd
popd

:run
echo.
echo ==^> Menyalakan Dashboard Monitoring System...
cd backend
set NODE_ENV=production
set DBMON_OPEN_BROWSER=1
if "%DBMON_STATIC_DIR%"=="" set "DBMON_STATIC_DIR=..\frontend\dist"
node --disable-warning=ExperimentalWarning dist\index.js
set EXITCODE=%errorlevel%
echo.
echo Dashboard Monitoring System berhenti (kode %EXITCODE%).
if exist "data\error.log" echo Catatan error tersimpan di: %cd%\data\error.log
goto stop

:fail_popd
popd
echo.
echo Build gagal. Periksa pesan error di atas.
echo Setelah masalahnya diperbaiki, jalankan: start.bat --rebuild

:stop
echo.
pause
exit /b 1
