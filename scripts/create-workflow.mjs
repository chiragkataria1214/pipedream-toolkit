#!/usr/bin/env node
/**
 * create_workflow.js — scaffold a new Pipedream workflow on disk and
 * (optionally) deploy it to the workspace via the REST API.
 *
 * Usage:
 *   node create_workflow.js \
 *     --project Notion \
 *     --name SyncMonthlyChangelog \
 *     --trigger timer --cron "0 9 * * 1" \
 *     --steps fetchChangelog,formatPage,createNotionPage
 *
 *   # HTTP-triggered:
 *   node create_workflow.js --project HR --name InboundResume --trigger http \
 *     --steps parseResume,scoreCandidate,notifySlack
 *
 *   # Push to Pipedream after scaffolding:
 *   node create_workflow.js ... --deploy
 *
 * Flags:
 *   --project   <string>    Top-level folder under exported_workflows/.
 *   --name      <string>    Workflow name (sanitised for filesystem).
 *   --trigger   timer|http  Trigger kind. Defaults to http.
 *   --cron      <string>    Required when --trigger=timer.
 *   --steps     <csv>       Comma-separated step names (declared in order).
 *   --deploy                POST the workflow to /v1/workflows in the workspace.
 *   --workflow  <id>        Optional: update an existing workflow instead of creating a new one.
 *   --base      <dir>       Output base dir (default: ./exported_workflows).
 *   --force                 Overwrite an existing workflow folder.
 *
 * Env (loaded from ./.env when --deploy is set):
 *   PIPEDREAM_API_KEY     — required for --deploy
 *   PIPEDREAM_ORG_ID      — required for --deploy (e.g. o_xxxxxx)
 *   PIPEDREAM_PROJECT_ID  — optional, falls back to the org's default project
 *   EXPORT_DIR            — optional, default: ./exported_workflows
 */
import fs from "fs/promises";
import path from "path";
import dotenv from "dotenv";
import axios from "axios";

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
const DEPLOY = has("deploy");
const WORKFLOW_ID = flag("workflow");
const FORCE = has("force");

if (!PROJECT || !NAME || !STEPS.length) {
    console.error("usage: node create_workflow.js --project P --name N --steps a,b,c [--trigger http|timer --cron '* * * * *'] [--deploy]");
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
            // savedComponent.code is filled in at deploy time from the .js file.
        })),
        // Free-form metadata so we know how this was generated.
        _generated: {
            tool: "create_workflow.js",
            at: new Date().toISOString(),
            project: PROJECT,
        },
    };
};

async function exists(p) {
    try { await fs.access(p); return true; } catch { return false; }
}

async function scaffold() {
    if (await exists(projDir)) {
        console.log(`ℹ️  Directory ${projDir} already exists. Syncing definition and deploying…`);
    } else {
        await fs.mkdir(projDir, { recursive: true });
    }

    const def = buildDefinition();
    await fs.writeFile(
        path.join(projDir, "workflow_definition.json"),
        JSON.stringify(def, null, 2)
    );
    for (let i = 0; i < STEPS.length; i++) {
        const filePath = path.join(projDir, `${STEPS[i]}.js`);
        if (!(await exists(filePath)) || FORCE) {
            await fs.writeFile(filePath, FIRST_STEP_TEMPLATE(STEPS[i], i === 0, TRIGGER));
        } else {
            console.log(`  - Skipping ${STEPS[i]}.js (already exists)`);
        }
    }

    console.log(`✓ Scaffolded ${projDir}`);
    console.log(`  ${STEPS.length} step(s): ${STEPS.join(", ")}`);
    console.log(`  trigger: ${TRIGGER}${TRIGGER === "timer" ? ` (cron: ${CRON})` : ""}`);
    console.log("\nNext:");
    console.log("  • Open the .js files and fill in props + logic.");
    console.log("  • To push to Pipedream: re-run with --deploy.");
    console.log("  • Or import workflow_definition.json via Pipedream UI → 'Import from JSON'.");
    return def;
}

/**
 * Deploy the scaffold to Pipedream via REST API.
 *
 * The Pipedream workspace API exposes:
 *   POST /v1/workflows
 *     {
 *       "org_id": "<org>",
 *       "project_id": "<project>",
 *       "workflow": { name, triggers, steps: [{ name, lang, code, ... }] }
 *     }
 *
 * The exact shape isn't fully published — this is what the v1 export shape
 * round-trips. Treat 4xx responses as a hint to either:
 *   1. Use the UI's "Import from JSON" feature (paste workflow_definition.json), or
 *   2. Adjust the payload shape based on what Pipedream returns.
 */
async function deploy(def) {
    const API_KEY = process.env.PIPEDREAM_API_KEY;
    const ORG_ID = process.env.PIPEDREAM_ORG_ID;
    const PROJECT_ID = process.env.PIPEDREAM_PROJECT_ID || null;
    if (!API_KEY || !ORG_ID) {
        console.error("\nerror: --deploy requires PIPEDREAM_API_KEY and PIPEDREAM_ORG_ID in ./.env");
        process.exit(1);
    }

    // Inline each step's source code into the definition.
    const stepsWithCode = await Promise.all(
        def.steps.map(async (s) => ({
            ...s,
            code_raw: await fs.readFile(path.join(projDir, `${s.name}.js`), "utf8"),
        }))
    );

    const payload = {
        org_id: ORG_ID,
        ...(PROJECT_ID && { project_id: PROJECT_ID }),
        workflow: { name: def.name, triggers: def.triggers, steps: stepsWithCode },
    };

    console.log(`\n⬆️  Deploying to Pipedream${WORKFLOW_ID ? ` (updating ${WORKFLOW_ID})` : ""}…`);
    try {
        let r;
        if (WORKFLOW_ID) {
            r = await axios.put(`https://api.pipedream.com/v1/workflows/${WORKFLOW_ID}?org_id=${ORG_ID}`, payload, {
                headers: { Authorization: `Bearer ${API_KEY}` },
            });
        } else {
            r = await axios.post("https://api.pipedream.com/v1/workflows", payload, {
                headers: { Authorization: `Bearer ${API_KEY}` },
            });
        }
        const wf = r.data?.workflow || r.data;
        console.log(`✓ ${WORKFLOW_ID ? "Updated" : "Created"} workflow ${wf.id || WORKFLOW_ID || "(no id returned)"}`);
        if (wf.id || WORKFLOW_ID) console.log(`  https://pipedream.com/@/${wf.id || WORKFLOW_ID}`);
    } catch (e) {
        const status = e.response?.status;
        const body = e.response?.data;
        console.error(`✗ Deploy failed (HTTP ${status || "?"}):`);
        console.error("  " + JSON.stringify(body || e.message));
        console.error("\nFallback: open Pipedream UI → New workflow → ⋯ → Import from JSON");
        console.error(`         and paste ${path.join(projDir, "workflow_definition.json")}`);
        process.exit(1);
    }
}

const def = await scaffold();
if (DEPLOY) await deploy(def);
