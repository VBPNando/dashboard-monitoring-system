import { appendFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * Dimuat paling awal. Jika server crash, pesan error ditampilkan dengan jelas
 * dan disimpan ke data/error.log supaya tidak hilang saat jendela tertutup.
 */
const dataDir = resolve(process.env.DBMON_DATA_DIR || 'data');
export const ERROR_LOG = join(dataDir, 'error.log');

export function logError(title: string, err: unknown) {
  const detail = err instanceof Error ? err.stack || err.message : String(err);
  try {
    mkdirSync(dataDir, { recursive: true });
    appendFileSync(ERROR_LOG, `[${new Date().toISOString()}] ${title}\n${detail}\n\n`);
  } catch {
    /* abaikan: jangan sampai pencatatan error menimbulkan error baru */
  }
  return detail;
}

export function fatal(message: string, err?: unknown): never {
  if (err !== undefined) logError(message, err);
  console.error('\n  ============================================================');
  console.error(`  Dashboard Monitoring System berhenti: ${message}`);
  if (err !== undefined) {
    console.error('  ------------------------------------------------------------');
    console.error('  ' + (err instanceof Error ? err.stack || err.message : String(err)).split('\n').join('\n  '));
    console.error(`\n  Detail juga disimpan di: ${ERROR_LOG}`);
  }
  console.error('  ============================================================\n');
  process.exit(1);
}

process.on('uncaughtException', (err) => fatal('terjadi error yang tidak terduga', err));
process.on('unhandledRejection', (err) => {
  // Jangan matikan server hanya karena satu promise gagal; cukup catat.
  const detail = logError('unhandledRejection', err);
  console.error('[dbmon] unhandledRejection:', detail);
});
