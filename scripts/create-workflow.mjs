#!/usr/bin/env node
/**
 * create-workflow.mjs — scaffold a new Pipedream workflow on disk.
 *
 * This script ONLY creates local files. Pipedream's public REST API does
 * not let you populate a workflow's triggers/steps/code, so the deploy
 * step is manual: you build the workflow once in the Pipedream UI and
 * paste the generated .js bodies into the code cells.
 *
 * Usage:
 *   node scripts/create-workflow.mjs \
 *     --project Notion \
 *     --name SyncMonthlyChangelog \
 *     --trigger timer --cron "0 9 * * 1" \
 *     --steps fetchChangelog,formatPage,createNotionPage
 *
 *   # HTTP-triggered:
 *   node scripts/create-workflow.mjs --project HR --name InboundResume --trigger http \
 *     --steps parseResume,scoreCandidate,notifySlack
 *
 * Flags:
 *   --project   <string>    Top-level folder under exported_workflows/.
 *   --name      <string>    Workflow name (sanitised for filesystem).
 *   --trigger   timer|http  Trigger kind. Defaults to http.
 *   --cron      <string>    Required when --trigger=timer.
 *   --steps     <csv>       Comma-separated step names (declared in order).
 *   --base      <dir>       Output base dir (default: ./exported_workflows).
 *   --force                 Overwrite existing step .js files (definition is
 *                           always rewritten; .js files are preserved by default).
 *
 * Env (loaded from ./.env if present):
 *   EXPORT_DIR              Optional override for the output base dir.
 */
import fs from "fs/promises";
import path from "path";
import dotenv from "dotenv";

dotenv.config();

const argv = process.argv.slice(2);
const flag = (n, fallback = null) => {
    const i = argv.indexOf(`--${n}`);
    if (i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--")) return argv[i + 1];
    const eq = argv.find((a) => a.startsWith(`--${n}=`));
    return eq ? eq.split("=")[1] : fallback;
};
const has = (n) => argv.includes(`--${n}`);

const PROJECT = flag("project");
const NAME = flag("name");
const TRIGGER = (flag("trigger") || "http").toLowerCase();
const CRON = flag("cron");
const STEPS = (flag("steps") || "").split(",").map((s) => s.trim()).filter(Boolean);
const BASE = flag("base") || process.env.EXPORT_DIR || "exported_workflows";
const FORCE = has("force");

if (!PROJECT || !NAME || !STEPS.length) {
    console.error("usage: node scripts/create-workflow.mjs --project P --name N --steps a,b,c [--trigger http|timer --cron '* * * * *'] [--force]");
    process.exit(2);
}
if (TRIGGER === "timer" && !CRON) {
    console.error("error: --trigger=timer requires --cron");
    process.exit(2);
}
if (!["timer", "http"].includes(TRIGGER)) {
    console.error("error: --trigger must be 'http' or 'timer'");
    process.exit(2);
}

const sanitize = (s) => s.replace(/[<>:"/\\|?*]/g, "-").replace(/\s+/g, "_").trim();
const projDir = path.join(BASE, sanitize(PROJECT), sanitize(NAME));

const FIRST_STEP_TEMPLATE = (stepName, isFirst, trigger) => {
    const triggerHint = isFirst && trigger === "http"
        ? `    // Trigger payload: steps.trigger.event.body / .headers / .query`
        : isFirst && trigger === "timer"
            ? `    // Trigger fires on cron: ${CRON}. steps.trigger.event has the timestamp.`
            : `    // Upstream output: steps.<previousStep>.$return_value`;
    return `export default defineComponent({
  // Declare every external dependency this step needs as a prop.
  // Examples:
  //   notion: { type: "app", app: "notion" },
  //   apiKey: { type: "string", secret: true },
  props: {},

  async run({ steps, $ }) {
${triggerHint}
    // TODO: implement ${stepName}
    return { ok: true };
  },
});
`;
};

const buildDefinition = () => {
    const triggers = TRIGGER === "timer"
        ? [{ type: "Timer", cron_string: CRON }]
        : [{ type: "HttpInterface" }];
    return {
        name: NAME,
        triggers,
        steps: STEPS.map((s, i) => ({
            name: s,
            namespace: s,
            type: "CodeCell",
            lang: "nodejs20.x",
            order: i,
        })),
        _generated: {
            tool: "create-workflow.mjs",
            at: new Date().toISOString(),
            project: PROJECT,
        },
    };
};

async function exists(p) {
    try { await fs.access(p); return true; } catch { return false; }
}

async function scaffold() {
    const dirExists = await exists(projDir);
    if (!dirExists) await fs.mkdir(projDir, { recursive: true });

    const def = buildDefinition();
    await fs.writeFile(
        path.join(projDir, "workflow_definition.json"),
        JSON.stringify(def, null, 2)
    );

    const written = [];
    const skipped = [];
    for (let i = 0; i < STEPS.length; i++) {
        const filePath = path.join(projDir, `${STEPS[i]}.js`);
        if (!(await exists(filePath)) || FORCE) {
            await fs.writeFile(filePath, FIRST_STEP_TEMPLATE(STEPS[i], i === 0, TRIGGER));
            written.push(STEPS[i]);
        } else {
            skipped.push(STEPS[i]);
        }
    }

    console.log(`✓ ${dirExists ? "Updated" : "Scaffolded"} ${projDir}`);
    console.log(`  trigger: ${TRIGGER}${TRIGGER === "timer" ? ` (cron: ${CRON})` : ""}`);
    if (written.length) console.log(`  wrote .js stubs: ${written.join(", ")}`);
    if (skipped.length) console.log(`  preserved (use --force to overwrite): ${skipped.join(", ")}`);

    console.log("\nNext — open the .js files and fill in props + logic.");
    console.log("\nThen, to get the workflow into Pipedream (manual; the public");
    console.log("REST API can't populate workflow content):");
    console.log("  1. Open https://pipedream.com → New workflow (in your project).");
    console.log(`  2. Add a ${TRIGGER === "timer" ? "Schedule (Cron)" : "HTTP / Webhook"} trigger.`);
    console.log("  3. For each step below, click '+' → 'Run custom code' (Node.js)");
    console.log("     and copy-paste the contents of the matching file:");
    for (const s of STEPS) {
        console.log(`       • ${s}  ←  ${path.join(projDir, `${s}.js`)}`);
    }
    console.log("  4. Click Deploy in the Pipedream UI when done.");
}

await scaffold();
