"use strict";

const fs = require("fs");
const path = require("path");

function fail(msg) {
  console.error(`[STARTUP_GUARD] FAIL: ${msg}`);
  process.exitCode = 1;
}

function assertIncludes(haystack, needle, label) {
  if (!haystack.includes(needle)) {
    fail(`${label} missing required snippet: ${needle}`);
  }
}

function assertNotIncludes(haystack, needle, label) {
  if (haystack.includes(needle)) {
    fail(`${label} contains forbidden snippet: ${needle}`);
  }
}

function main() {
  const repoRoot = process.cwd();
  const pkgPath = path.join(repoRoot, "package.json");
  const indexPath = path.join(repoRoot, "src", "index.js");
  const dashboardFmtPath = path.join(repoRoot, "src", "lib", "dashboard-formatters.js");

  if (!fs.existsSync(pkgPath)) {
    fail("package.json not found");
    process.exit(1);
  }
  if (!fs.existsSync(indexPath)) {
    fail("src/index.js not found");
    process.exit(1);
  }
  if (!fs.existsSync(dashboardFmtPath)) {
    fail("src/lib/dashboard-formatters.js not found");
    process.exit(1);
  }

  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
  const indexCode = fs.readFileSync(indexPath, "utf8");
  const dashboardFmtCode = fs.readFileSync(dashboardFmtPath, "utf8");

  const startScript = pkg?.scripts?.start;
  if (startScript !== "node src/index.js") {
    fail(`scripts.start must be exactly \"node src/index.js\" (found: ${String(startScript)})`);
  }

  const requiredSnippets = [
    'const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;',
    'const TELEGRAM_BOT_ACTIVE = ENABLE_TELEGRAM_BOT && !!BOT_TOKEN;',
    'bot.start(safeCommand(async (ctx) => {',
    'bot.command("dashboard", safeCommand(async (ctx) => {',
    'if (!(await requireAdminOrNotify(ctx, "start"))) return;',
    'if (!(await requireAdminOrNotify(ctx, "dashboard_command"))) return;',
    'await bot.telegram.deleteWebhook({ drop_pending_updates: false }).catch(() => {});',
    'await bot.launch();',
    'startBotLaunchLoop().catch((err) => {',
    'console.log(`Telegram bot launch disabled (${TELEGRAM_BOT_DISABLED_REASON || "unknown reason"})`);'
  ];

  for (const snippet of requiredSnippets) {
    assertIncludes(indexCode, snippet, "src/index.js");
  }

  const startCount = (indexCode.match(/bot\.start\(/g) || []).length;
  const dashboardCmdCount = (indexCode.match(/bot\.command\("dashboard"/g) || []).length;
  if (startCount !== 1) {
    fail(`expected exactly 1 bot.start handler, found ${startCount}`);
  }
  if (dashboardCmdCount !== 1) {
    fail(`expected exactly 1 dashboard command handler, found ${dashboardCmdCount}`);
  }

  // Keep delivery health on the main dashboard formatter.
  assertIncludes(dashboardFmtCode, "function deriveDeliveryHealth(delivery = {})", "src/lib/dashboard-formatters.js");
  assertIncludes(dashboardFmtCode, "🚚 DELIVERY HEALTH", "src/lib/dashboard-formatters.js");
  assertIncludes(dashboardFmtCode, "Overall: ${health.emoji} ${health.label}", "src/lib/dashboard-formatters.js");

  // Keep Today card concise (no delivery-health detail rows in TODAY:open text).
  assertNotIncludes(indexCode, "📤 Email Pending:", "src/index.js");
  assertNotIncludes(indexCode, "📲 SMS Pending:", "src/index.js");
  assertNotIncludes(indexCode, "☠️ Dead Letter Events:", "src/index.js");
  assertNotIncludes(indexCode, "🎟 Open Support Tickets:", "src/index.js");

  if (process.exitCode) {
    process.exit(1);
  }

  console.log("[STARTUP_GUARD] PASS: startup contract is intact");
}

main();
