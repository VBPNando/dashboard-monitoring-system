@echo off
REM ==================================================================
REM  Dashboard Monitoring System - MENU SERVER (Windows)
REM  Klik dua kali. Menu otomatis meminta izin administrator.
REM ==================================================================
setlocal EnableExtensions
cd /d "%~dp0"
title Dashboard Monitoring System - Menu Server

REM Minta hak administrator (dibutuhkan Task Scheduler & firewall)
net session >nul 2>&1
if errorlevel 1 (
  echo Meminta izin administrator...
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)

set "TASK=Dashboard Monitoring System"
set "PS=powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\autostart.ps1""

REM Port: tools\port.txt (bila pernah dipasang) > baris "set PORT=" di start.bat > 3000
set PORT=
if exist "tools\port.txt" set /p PORT=<"tools\port.txt"
if "%PORT%"=="" for /f "tokens=2 delims==" %%p in ('findstr /r /i /c:"^set PORT=[0-9]" start.bat 2^>nul') do set PORT=%%p
if "%PORT%"=="" set PORT=3000

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo Node.js belum terpasang. Pasang Node.js LTS dari https://nodejs.org lalu buka menu ini lagi.
  pause
  exit /b 1
)

:menu
cls
echo ==================================================================
echo   DASHBOARD MONITORING SYSTEM  -  MENU SERVER
echo ==================================================================
%PS% -Action status -Name "%TASK%" -Port %PORT%
echo ------------------------------------------------------------------
echo   1. Pasang JALAN OTOMATIS (menyala sendiri saat Windows hidup)
echo   2. Hapus jalan otomatis
echo   3. Nyalakan ulang server
echo   4. Hentikan server
echo   5. UPDATE: build ulang setelah menimpa file versi baru
echo   6. Buka dashboard di browser
echo   7. Lihat log server
echo   8. Ganti port (sekarang %PORT%)
echo   9. Reset password login (lupa password)
echo   T. Jalankan di jendela ini saja (untuk mencoba / melihat error)
echo   0. Keluar
echo ------------------------------------------------------------------
set "CH="
set /p CH=Pilih: 
if "%CH%"=="1" goto install
if "%CH%"=="2" goto remove
if "%CH%"=="3" goto restart
if "%CH%"=="4" goto stop
if "%CH%"=="5" goto update
if "%CH%"=="6" goto open
if "%CH%"=="7" goto log
if "%CH%"=="8" goto port
if "%CH%"=="9" goto resetpw
if /i "%CH%"=="T" goto try
if "%CH%"=="0" exit /b 0
goto menu

:needbuild
if exist "frontend\dist\index.html" if exist "backend\dist\index.js" exit /b 0
echo.
echo Aplikasi belum di-build. Build sekarang...
call tools\build.bat
exit /b %errorlevel%

:install
call :needbuild || goto pause
echo.
%PS% -Action install -Name "%TASK%" -Script "%~dp0tools\run-server.bat" -Port %PORT%
echo.
echo   Alamat dashboard:
echo     http://localhost:%PORT%
%PS% -Action ips -Name "%TASK%" -Port %PORT%
goto pause

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

:update
echo.
echo Menghentikan server latar (bila berjalan)...
%PS% -Action stop -Name "%TASK%" -Port %PORT%
call tools\build.bat
if errorlevel 1 goto pause
schtasks /query /tn "%TASK%" >nul 2>&1
if not errorlevel 1 (
  echo.
  echo Menyalakan kembali server latar...
  %PS% -Action start -Name "%TASK%" -Port %PORT%
)
goto pause

:open
start "" "http://localhost:%PORT%"
goto menu

:log
if exist "backend\data\server.log" (
  start "" notepad "backend\data\server.log"
) else (
  echo.
  echo Belum ada log. Log dibuat setelah jalan otomatis dipasang.
  if exist "backend\data\error.log" start "" notepad "backend\data\error.log"
  goto pause
)
goto menu

:port
echo.
set "NEWPORT="
set /p NEWPORT=Port baru (mis. 3001): 
echo %NEWPORT%| findstr /r "^[0-9][0-9]*$" >nul || (echo Port tidak valid. & goto pause)
set PORT=%NEWPORT%
> "tools\port.txt" (set /p "=%PORT%" <nul)
echo Port disimpan: %PORT%
schtasks /query /tn "%TASK%" >nul 2>&1
if not errorlevel 1 (
  echo Memasang ulang dengan port baru...
  %PS% -Action install -Name "%TASK%" -Script "%~dp0tools\run-server.bat" -Port %PORT%
)
goto pause

:resetpw
echo.
echo Password login akan diganti dengan password acak baru.
set "OK="
set /p OK=Lanjutkan? (Y/N): 
if /i not "%OK%"=="Y" goto menu
%PS% -Action stop -Name "%TASK%" -Port %PORT%
if exist "backend\data\admin-password.hash" del /q "backend\data\admin-password.hash"
if exist "backend\data\admin-password.txt" del /q "backend\data\admin-password.txt"
schtasks /query /tn "%TASK%" >nul 2>&1
if errorlevel 1 (
  echo Server latar tidak terpasang. Jalankan server ^(menu T atau 1^) untuk membuat password baru.
  goto pause
)
%PS% -Action start -Name "%TASK%" -Port %PORT%
if exist "backend\data\admin-password.txt" (
  echo.
  echo   Password login baru:
  type "backend\data\admin-password.txt"
  echo.
  echo   Setelah login, ganti dengan password Anda sendiri lewat tombol roda gigi di kanan atas.
)
goto pause

:try
call :needbuild || goto pause
%PS% -Action status -Name "%TASK%" -Port %PORT% | findstr /c:"BERJALAN" >nul
if not errorlevel 1 (
  echo.
  echo Server sudah berjalan di latar belakang. Hentikan dulu ^(menu 4^) bila ingin menjalankan di jendela ini.
  goto pause
)
cd backend
set NODE_ENV=production
set DBMON_OPEN_BROWSER=1
set "DBMON_STATIC_DIR=..\frontend\dist"
node --disable-warning=ExperimentalWarning dist\index.js
cd ..
goto pause

:pause
echo.
pause
goto menu
