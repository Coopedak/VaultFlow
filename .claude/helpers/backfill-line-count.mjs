/**
 * backfill-line-count.mjs — one-shot idempotent backfill for code_symbols.line_count
 *
 * WHY: The line_count column was added in migration v7. Existing rows have NULL
 * because indexFile() only writes the value on a live re-index. This script
 * reads the distinct file paths from code_symbols, reads each file from disk,
 * computes line count, and updates all rows for that file in one UPDATE.
 *
 * Idempotent: rows where line_count IS NOT NULL are skipped. Re-running is safe.
 *
 * Run:
 *   node .claude/helpers/backfill-line-count.mjs
 *   npm run backfill:line-count
 */

import { createRequire } from 'node:module';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require   = createRequire(import.meta.url);

const db   = require('./db.cjs');
const yaml = require('js-yaml');

function loadConfig() {
  const configPath = require('../../config/resolve.cjs');
  if (!existsSync(configPath)) return {};
  try { return yaml.load(readFileSync(configPath, 'utf8')) || {}; }
  catch (_) { return {}; }
}

async function run() {
  const cfg     = loadConfig();
  const metrics = (cfg.paths && cfg.paths.metrics_root)
    || path.join(process.env.USERPROFILE || os.homedir(), 'vault', 'methodology', '.metrics');
  const dbFile  = (cfg.storage && cfg.storage.db_file) || 'vaultflow.db';

  db.initialize(metrics, dbFile);
  const conn = db.raw();

  // Fetch all files whose rows still lack line_count. One row per file is
  // enough — we UPDATE all rows for the file in a single statement.
  const nullRows = conn.prepare(
    `SELECT DISTINCT file FROM code_symbols WHERE line_count IS NULL`
  ).all();

  if (nullRows.length === 0) {
    console.log('[backfill:line-count] all rows already populated — nothing to do');
    return;
  }

  console.log(`[backfill:line-count] ${nullRows.length} files to populate...`);

  const update = conn.prepare(
    `UPDATE code_symbols SET line_count = ? WHERE file = ?`
  );

  let populated = 0;
  let skipped   = 0;

  for (const { file } of nullRows) {
    // Normalize to forward slashes for reliable existsSync on Windows.
    const filePath = file.replace(/\\/g, '/');
    if (!existsSync(filePath)) {
      skipped++;
      continue;
    }
    try {
      const content   = readFileSync(filePath, 'utf8');
      const lineCount = content.split('\n').length;
      // Update both separator variants stored in the DB (\ and /).
      const wsep = file.replace(/\//g, '\\');
      const fsep = file.replace(/\\/g, '/');
      update.run(lineCount, wsep);
      update.run(lineCount, fsep);
      populated++;
    } catch (_) {
      skipped++;
    }
  }

  // Report final DB state.
  const total    = conn.prepare(`SELECT COUNT(*) AS n FROM code_symbols`).get().n;
  const withData = conn.prepare(`SELECT COUNT(*) AS n FROM code_symbols WHERE line_count IS NOT NULL`).get().n;

  console.log(
    `[backfill:line-count] done: ${populated} files populated, ${skipped} skipped (not found/unreadable)`
  );
  console.log(`[backfill:line-count] code_symbols: ${withData} / ${total} rows now have line_count`);
}

run().catch(err => {
  console.error('[backfill:line-count] fatal:', err.message);
  process.exit(1);
});
