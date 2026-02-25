/**
 * NIL Wealth Ops Bot
 * Index.js v5.4 (Modularization scaffold)
 *
 * IMPORTANT:
 * - This file intentionally preserves ALL V5.3 behavior by loading the legacy monolith.
 * - Do NOT enable modular bootstrap until all blocks are implemented.
 */

const CODE_VERSION = "Index.js v5.4 (scaffold; loads legacy v5.3)";
const BUILD = process.env.RENDER_GIT_COMMIT?.slice?.(0, 8) || process.env.BUILD || "local";

function logBoot() {
  try {
    console.log(`\n📌 NIL Wealth Ops Dashboard\n${CODE_VERSION} · Build: ${BUILD}\n`);
  } catch (_) {}
}

logBoot();

// Safety switch:
// - Default: loads legacy V5.3 (no behavior change)
// - Later: set NIL_USE_MODULAR=1 to load modular bootstrap
const useModular = process.env.NIL_USE_MODULAR === "1";

if (useModular) {
  require("./bootstrap/bootstrap.v5.4");
} else {
  require("./legacy/index.v5.3");
}