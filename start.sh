#!/usr/bin/env bash
# Menjalankan Dashboard Monitoring System tanpa Docker (Linux / macOS). Butuh Node.js 22.13+.
#   ./start.sh            build bila belum ada, lalu jalankan
#   ./start.sh --rebuild  paksa build ulang
set -euo pipefail
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js belum terpasang. Pasang Node.js 22.13 atau lebih baru: https://nodejs.org"; exit 1
fi
if ! node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>22||(a===22&&b>=13)?0:1)'; then
  echo "Butuh Node.js 22.13 atau lebih baru, terpasang $(node -v)"; exit 1
fi

rebuild=0
[ "${1:-}" = "--rebuild" ] && rebuild=1

if [ $rebuild -eq 1 ] || [ ! -f frontend/dist/index.html ]; then
  echo "==> [1/2] Build frontend"
  (cd frontend && npm install --no-audit --no-fund && npm run build)
fi
if [ $rebuild -eq 1 ] || [ ! -f backend/dist/index.js ]; then
  echo "==> [2/2] Build backend"
  (cd backend && npm install --no-audit --no-fund && npm run build)
fi

cd backend
export NODE_ENV=production
export DBMON_STATIC_DIR="${DBMON_STATIC_DIR:-../frontend/dist}"
exec node --disable-warning=ExperimentalWarning dist/index.js
