const { execSync } = require('child_process');

const DEFAULT_CRON = '0 */6 * * *';
const cron = require('node-cron');

const runOnceMode = process.argv.includes('--once');
const scheduleExpr = String(process.env.SUPPORT_SYNC_CRON || DEFAULT_CRON).trim();
const runOnStart = String(process.env.SUPPORT_SYNC_RUN_ON_START || 'true').toLowerCase() !== 'false';

function nowIso() {
  return new Date().toISOString();
}

function hasPsql() {
  try {
    execSync('command -v psql', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function runCommand(label, command) {
  console.log(`[support-autosync] ${nowIso()} starting: ${label}`);
  execSync(command, { stdio: 'inherit' });
  console.log(`[support-autosync] ${nowIso()} finished: ${label}`);
}

function applySupabaseSeedsIfConfigured() {
  const dbUrl = String(process.env.SUPABASE_DB_URL || '').trim();
  if (!dbUrl) {
    console.log('[support-autosync] SUPABASE_DB_URL not set; skipping SQL seed apply.');
    return;
  }
  if (!hasPsql()) {
    console.warn('[support-autosync] SUPABASE_DB_URL is set but psql is unavailable; skipping SQL seed apply.');
    return;
  }

  runCommand(
    'apply support_knowledge_base_seed.sql',
    'psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f sql/support_knowledge_base_seed.sql'
  );
  runCommand(
    'apply support_knowledge_faq_seed.sql',
    'psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f sql/support_knowledge_faq_seed.sql'
  );
}

function runSync() {
  try {
    runCommand('publish WF02/WF03 support knowledge', 'node scripts/patch_wf02_wf03_support_knowledge_live.js');
    applySupabaseSeedsIfConfigured();
    console.log(`[support-autosync] ${nowIso()} cycle complete: ok=true`);
  } catch (error) {
    console.error(`[support-autosync] ${nowIso()} cycle failed:`, error.message || error);
  }
}

if (runOnceMode) {
  runSync();
  process.exit(0);
}

if (!cron.validate(scheduleExpr)) {
  console.error(`[support-autosync] Invalid SUPPORT_SYNC_CRON: ${scheduleExpr}`);
  process.exit(1);
}

console.log(`[support-autosync] booting with cron='${scheduleExpr}', runOnStart=${runOnStart}`);
if (runOnStart) runSync();

cron.schedule(scheduleExpr, () => {
  runSync();
});

process.on('SIGINT', () => {
  console.log('[support-autosync] shutting down (SIGINT).');
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('[support-autosync] shutting down (SIGTERM).');
  process.exit(0);
});
