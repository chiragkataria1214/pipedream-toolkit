#!/usr/bin/env node
/**
 * Helper: take a JSON spec of { folderName: [workflowUrl, ...], ... } and
 * emit `pipedream_workflows.txt` in the tree-format that refresh-exports.mjs
 * already parses.
 *
 * Why: Pipedream's REST API doesn't expose a workflow-listing endpoint
 * (https://github.com/PipedreamHQ/pipedream/issues/16720), so the
 * universal fallback is the UI's "Export tree as text". When you can't
 * use that (e.g. you only have inspect-page URLs), this builder produces
 * the same shape from a hand-curated JSON file.
 *
 * Input: ./tree.spec.json — a JSON object like
 *   {
 *     "1 Client Portal and Master Tracker": [
 *       "https://pipedream.com/.../1-project-launch...-p_V9Cobq6/inspect",
 *       ...
 *     ],
 *     "2 Slack": []
 *   }
 *
 * Output: ./pipedream_workflows.txt (overwritten).
 */
import fs from "fs/promises";

const SPEC_PATH = process.argv[2] || "tree.spec.json";

const slug2name = (slug) =>
    slug
        .replace(/-p_[A-Za-z0-9]+$/, "")     // shouldn't happen — defensive
        .replace(/[-_]+/g, " ")              // kebab/snake → spaces
        .trim();

const parseUrl = (url) => {
    // Match the LAST p_xxx in the URL — the workflow id always sits at the
    // end of the slug (`...-p_XXXX/inspect`) or as a trailing segment.
    const idMatch = url.match(/p_[A-Za-z0-9]+/g);
    if (!idMatch) return null;
    const id = idMatch[idMatch.length - 1];
    // Pull the slug = the path segment that contains this id.
    const slugMatch = url.match(new RegExp(`/([^/]*${id})/?(?:inspect)?/?$`));
    const slug = slugMatch
        ? slugMatch[1].replace(new RegExp(`[-_]?${id}$`), "")
        : id;
    return { id, name: slug2name(slug) || id };
};

const spec = JSON.parse(await fs.readFile(SPEC_PATH, "utf8"));

let out = "";
for (const [folder, urls] of Object.entries(spec)) {
    out += `[folder] ${folder}/\n`;
    for (const url of urls) {
        const wf = parseUrl(url);
        if (!wf) {
            console.warn(`⚠️  skipped: could not parse ${url}`);
            continue;
        }
        out += `├── [workflow] ${wf.name} (${wf.id})\n`;
    }
}

await fs.writeFile("pipedream_workflows.txt", out);
const folders = Object.keys(spec).length;
const workflows = (out.match(/\[workflow\]/g) || []).length;
console.log(`✓ Wrote pipedream_workflows.txt — ${folders} folders, ${workflows} workflows`);
