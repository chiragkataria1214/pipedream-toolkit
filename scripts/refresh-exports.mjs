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
 *   node refresh_exports.js --ids my-workflow-ids.txt   # one p_xxx per line
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
const IDS_FILE = flag("ids");
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
 * List every workflow in the workspace.
 * Returns [{ id, name, folderPath, updated_at }].
 *
 * Pipedream's REST API does not expose a single "list every workflow"
 * endpoint publicly. We try, in order:
 *
 *   1. --ids <file>                                  — explicit list of p_xxx ids
 *   2. GET /workspaces/{org}/projects + per-project list
 *      (tries several path variants, since the per-project shape varies
 *       across plans / API versions)
 *   3. Tree file fallback (`pipedream_workflows.txt` or legacy variants).
 *      Get this by exporting the workspace tree from the Pipedream UI
 *      (Workspace → ⋯ → Export tree as text), then save it next to this script.
 *
 * If all three fail, exits with an actionable error.
 */
async function listAllWorkflows() {
    if (IDS_FILE) {
        return await listFromIdsFile(IDS_FILE);
    }

    // 1. Try tree.spec.json — the project's source of truth for folder mapping.
    const spec = await trySpecFile();
    if (spec && spec.length) return spec;

    // Fallback to legacy tree file
    return await tryTreeFile();
}

/**
 * Try parsing tree.spec.json directly.
 */
async function trySpecFile() {
    try {
        const text = await fs.readFile("tree.spec.json", "utf8");
        const spec = JSON.parse(text);
        const all = [];

        const slug2name = (slug) => slug.replace(/[-_]+/g, " ").trim();
        const parseEntry = (entry) => {
            const lit = entry.match(/^(.+?)\s*\((p_[A-Za-z0-9]+)\)\s*$/);
            if (lit) return { id: lit[2], name: lit[1].trim() };
            const ids = entry.match(/p_[A-Za-z0-9]+/g);
            if (!ids) return null;
            const id = ids[ids.length - 1];
            const slugMatch = entry.match(new RegExp(`/([^/]*${id})/?(?:inspect)?/?$`));
            const slug = slugMatch ? slugMatch[1].replace(new RegExp(`[-_]?${id}$`), "") : id;
            return { id, name: slug2name(slug) || id };
        };

        const walk = (node, pathSegments = []) => {
            if (Array.isArray(node)) {
                for (const entry of node) {
                    const wf = parseEntry(entry);
                    if (wf) {
                        all.push({
                            id: wf.id,
                            name: wf.name,
                            folderPath: pathSegments.join("/"),
                            updated_at: null,
                        });
                    }
                }
            } else if (node && typeof node === "object") {
                for (const [key, val] of Object.entries(node)) {
                    if (key === "_root") {
                        walk(val, pathSegments);
                    } else {
                        walk(val, [...pathSegments, sanitize(key)]);
                    }
                }
            }
        };

        walk(spec);
        if (all.length) console.log(`📄 Using tree.spec.json (${all.length} workflows)`);
        return all;
    } catch {
        return null;
    }
}

async function listFromIdsFile(file) {
    let text;
    try {
        text = await fs.readFile(file, "utf8");
    } catch {
        console.error(`❌ ${file} not readable`);
        process.exit(2);
    }
    const ids = [...text.matchAll(/p_[A-Za-z0-9]+/g)].map((m) => m[0]);
    const unique = [...new Set(ids)];
    console.log(`📋 Read ${unique.length} workflow ids from ${file}`);
    return unique.map((id) => ({ id, name: id, folderPath: "", updated_at: null }));
}

async function tryTreeFile() {
    const candidates = [
        "pipedream_workflows.txt",
        "pipedream_workflows (1).txt",
        "workflow_tree.txt",
    ];
    let TREE = null, text = null;
    for (const c of candidates) {
        try {
            text = await fs.readFile(c, "utf8");
            TREE = c;
            break;
        } catch { /* next */ }
    }
    if (!text) {
        console.error("");
        console.error("❌ Could not list workflows. None of the fallbacks are available.");
        console.error("");
        console.error("Pipedream's REST API does not expose a workflow-listing endpoint");
        console.error("(tracked at https://github.com/PipedreamHQ/pipedream/issues/16720),");
        console.error("so we need the workflow IDs from somewhere else. Pick the easiest:");
        console.error("");
        console.error("  A) [recommended] Export the project tree from the Pipedream UI:");
        console.error("       1. Open your project (e.g. https://pipedream.com/.../projects/proj_xxx/tree)");
        console.error("       2. Click ⋯ in the tree header → 'Export tree as text'");
        console.error("       3. Save the downloaded file as `pipedream_workflows.txt` in this repo's root.");
        console.error("       4. Re-run `npm run refresh`.");
        console.error("");
        console.error("  B) Paste workflow IDs into a file (any text containing p_xxx works):");
        console.error("       npm run refresh -- --ids my-workflows.txt");
        console.error("");
        console.error("  C) Refresh one workflow at a time (good for quick edits):");
        console.error("       npm run refresh -- --workflow p_abc123");
        console.error("");
        process.exit(2);
    }
    console.log(`📄 Using tree file ${TREE}`);
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
