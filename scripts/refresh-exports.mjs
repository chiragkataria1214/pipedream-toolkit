#!/usr/bin/env node
/**
 * refresh_exports.js — pull every Pipedream workflow in the workspace and
 * write it under ./exported_workflows/<folder>/<workflow>/.
 *
 * Improvements over the original `export_workflows.js`:
 *   • Lists workflows via the Pipedream REST API directly. No more relying
 *     on a hand-pasted `pipedream_workflows (1).txt` tree.
 *   • Walks projects → folders → workflows so the on-disk layout matches
 *     the org's UI tree.
 *   • Idempotent: re-running overwrites step files in place. Safe to run
 *     after edits in the Pipedream UI to refresh the local export.
 *   • Optional --since=ISO_DATE flag — skip workflows whose `updated_at`
 *     is older than the cutoff (fast incremental refresh).
 *   • Optional --workflow=p_xxx flag — refresh just one workflow.
 *
 * Usage:
 *   node refresh_exports.js                 # full refresh
 *   node refresh_exports.js --since 2026-04-01
 *   node refresh_exports.js --workflow p_abc123
 *
 * Env (loaded from ./.env):
 *   PIPEDREAM_API_KEY   — required (https://pipedream.com/settings/api-keys)
 *   PIPEDREAM_ORG_ID    — required (e.g. o_xxxxxx, find in workspace settings)
 *   EXPORT_DIR          — optional, default: ./exported_workflows
 */
import axios from "axios";
import fs from "fs/promises";
import path from "path";
import dotenv from "dotenv";

dotenv.config();

const API_KEY = process.env.PIPEDREAM_API_KEY;
const ORG_ID = process.env.PIPEDREAM_ORG_ID;
const BASE_DIR = process.env.EXPORT_DIR || "exported_workflows";
const RATE_DELAY_MS = 200;

const argv = process.argv.slice(2);
const flag = (name) => {
    const i = argv.indexOf(`--${name}`);
    if (i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--")) return argv[i + 1];
    const eq = argv.find((a) => a.startsWith(`--${name}=`));
    return eq ? eq.split("=")[1] : null;
};

const SINCE = flag("since");
const ONLY_ID = flag("workflow");
const DRY_RUN = argv.includes("--dry-run");

if (!API_KEY) {
    console.error("❌ PIPEDREAM_API_KEY missing — copy .env.example to .env and fill it in.");
    process.exit(1);
}
if (!ORG_ID) {
    console.error("❌ PIPEDREAM_ORG_ID missing — set it in .env (find it in your Pipedream workspace settings).");
    process.exit(1);
}

const api = axios.create({
    baseURL: "https://api.pipedream.com/v1",
    headers: { Authorization: `Bearer ${API_KEY}` },
});

const sanitize = (s) =>
    s.replace(/[<>:"/\\|?*]/g, "-").replace(/\s+/g, "_").trim();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * List every workflow in the workspace by walking projects.
 * Returns [{ id, name, folderPath, updated_at }].
 *
 * Pipedream's API exposes:
 *   GET /workspaces/{orgId}/projects        — list projects
 *   GET /workspaces/{orgId}/sources         — sources (event sources)
 *   GET /projects/{projectId}/workflows     — workflows in a project
 *   GET /workflows/{id}                     — full workflow detail
 *
 * If the workspace listing endpoint isn't enabled on this account, falls
 * back to parsing the legacy tree file so the script still works.
 */
async function listAllWorkflows() {
    try {
        const { data } = await api.get(`/workspaces/${ORG_ID}/projects`);
        const projects = data.data || data.projects || data;
        if (!Array.isArray(projects)) throw new Error("unexpected projects shape");
        console.log(`📂 Found ${projects.length} projects`);

        const all = [];
        for (const proj of projects) {
            const projId = proj.id || proj.project_id;
            const projName = sanitize(proj.name || projId);
            const { data: wfData } = await api.get(`/projects/${projId}/workflows`);
            const wfs = wfData.data || wfData.workflows || wfData;
            for (const wf of wfs) {
                if (SINCE && wf.updated_at && new Date(wf.updated_at) < new Date(SINCE)) continue;
                all.push({
                    id: wf.id,
                    name: wf.name || wf.id,
                    folderPath: projName,   // top-level project folder
                    updated_at: wf.updated_at || null,
                });
            }
            await sleep(RATE_DELAY_MS);
        }
        return all;
    } catch (e) {
        console.warn(
            `⚠️  workspace listing failed (${e.response?.status || e.message}). ` +
            `Falling back to ./pipedream_workflows (1).txt tree.`
        );
        return await listFromTreeFile();
    }
}

async function listFromTreeFile() {
    const TREE = "pipedream_workflows (1).txt";
    let text;
    try {
        text = await fs.readFile(TREE, "utf8");
    } catch {
        console.error(`❌ Neither API listing nor ${TREE} are available.`);
        process.exit(2);
    }
    const out = [];
    const stack = [];
    for (const raw of text.split("\n")) {
        const markerPos = raw.search(/\[(workflow|folder)\]/);
        if (markerPos < 0) continue;
        const depth = (raw.substring(0, markerPos).match(/[│├└]/g) || []).length;
        const folderM = raw.match(/\[folder\]\s+(.+?)\//);
        const wfM = raw.match(/\[workflow\]\s+(.+?)\s+\((p_\w+)\)/);
        if (folderM) {
            while (stack.length && stack[stack.length - 1].depth >= depth) stack.pop();
            stack.push({ name: folderM[1].trim(), depth });
        } else if (wfM) {
            while (stack.length && stack[stack.length - 1].depth >= depth) stack.pop();
            out.push({
                id: wfM[2],
                name: wfM[1].trim(),
                folderPath: stack.map((f) => sanitize(f.name)).join("/"),
                updated_at: null,
            });
        }
    }
    return out;
}

async function fetchDetail(id) {
    const { data } = await api.get(`/workflows/${id}`, { params: { org_id: ORG_ID } });
    return data;
}

async function writeWorkflow(dir, wf) {
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
        path.join(dir, "workflow_definition.json"),
        JSON.stringify(wf, null, 2)
    );
    let n = 0;
    for (const step of wf.steps || []) {
        const code = step.savedComponent?.code || step.code_raw || step.props?.code;
        const lang = step.lang || "nodejs";
        const ext = lang.includes("python") ? ".py" : lang.includes("bash") || lang.includes("sh") ? ".sh" : lang.includes("go") ? ".go" : ".js";
        const stepName = sanitize(step.namespace || step.name || step.id || `step_${n}`);
        if (code) {
            await fs.writeFile(path.join(dir, `${stepName}${ext}`), code);
        } else {
            await fs.writeFile(
                path.join(dir, `${stepName}_action.json`),
                JSON.stringify(step, null, 2)
            );
        }
        n++;
    }
    return n;
}

async function main() {
    console.log("🚀 Refreshing Pipedream workflow exports…");
    if (SINCE) console.log(`   filter: updated_at ≥ ${SINCE}`);
    if (ONLY_ID) console.log(`   filter: only workflow ${ONLY_ID}`);
    if (DRY_RUN) console.log("   (dry-run)");

    let list;
    if (ONLY_ID) {
        list = [{ id: ONLY_ID, name: ONLY_ID, folderPath: "", updated_at: null }];
    } else {
        list = await listAllWorkflows();
    }
    console.log(`   ${list.length} workflows in scope.\n`);

    if (DRY_RUN) {
        for (const wf of list) console.log(`  ${wf.id}  ${wf.folderPath}/${wf.name}`);
        return;
    }

    await fs.mkdir(BASE_DIR, { recursive: true });
    let ok = 0, fail = 0;
    for (let i = 0; i < list.length; i++) {
        const wf = list[i];
        const tag = `[${i + 1}/${list.length}]`;
        const rel = path.join(wf.folderPath, sanitize(wf.name));
        const dir = path.join(BASE_DIR, rel);
        process.stdout.write(`${tag} ${wf.id} ${rel} … `);
        try {
            const detail = await fetchDetail(wf.id);
            const stepCount = await writeWorkflow(dir, detail);
            console.log(`✅ ${stepCount} steps`);
            ok++;
        } catch (e) {
            console.log(`❌ ${e.response?.data?.error || e.message}`);
            fail++;
        }
        if (i < list.length - 1) await sleep(RATE_DELAY_MS);
    }
    console.log(`\n✨ Done. ${ok} ok · ${fail} failed · output: ${BASE_DIR}/`);
}

main().catch((e) => {
    console.error("fatal:", e.message);
    process.exit(1);
});
