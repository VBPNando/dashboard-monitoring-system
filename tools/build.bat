@echo off
REM Build tampilan (frontend) dan server (backend). Dipanggil oleh menu.bat.
setlocal
cd /d "%~dp0.."
echo.
echo ==^> [1/2] Menyiapkan tampilan (frontend). Pertama kali bisa beberapa menit...
pushd frontend
call npm install --no-audit --no-fund || goto fail
call npm run build || goto fail
popd
echo.
echo ==^> [2/2] Menyiapkan server (backend)...
pushd backend
call npm install --no-audit --no-fund || goto fail
call npm run build || goto fail
popd
echo.
echo Build selesai.
exit /b 0
:fail
popd
echo.
echo Build GAGAL. Periksa pesan error di atas.
exit /b 1
