#!/usr/bin/env node
/**
 * Build pipedream_workflows.txt from tree.spec.json.
 *
 * tree.spec.json schema:
 *   {
 *     "Folder name": [
 *       "https://pipedream.com/.../slug-p_xxx/inspect",   // URL
 *       "Pretty Workflow Name (p_yyy)"                    // name + id literal
 *     ],
 *     "Another folder": {
 *       "Subfolder": [
 *         "https://pipedream.com/.../slug-p_zzz/inspect"
 *       ],
 *       "Another sub": {
 *         "Even deeper": [ ... ]
 *       }
 *     }
 *   }
 *
 *   - Array values  → list of workflow entries
 *   - Object values → nested folder
 *   - Each entry can be either a Pipedream `/inspect` URL or a literal
 *     `"Display Name (p_xxx)"` string (useful for reusing names from a
 *     legacy tree dump where a URL isn't handy).
 */
import fs from "fs/promises";

const SPEC_PATH = process.argv[2] || "tree.spec.json";

const slug2name = (slug) =>
    slug.replace(/[-_]+/g, " ").trim();

function parseEntry(entry) {
    // Literal "Name (p_xxx)" form — preserve the display name as written.
    const lit = entry.match(/^(.+?)\s*\((p_[A-Za-z0-9]+)\)\s*$/);
    if (lit) return { id: lit[2], name: lit[1].trim() };

    // URL form — extract the LAST p_xxx id and derive a name from the slug.
    const ids = entry.match(/p_[A-Za-z0-9]+/g);
    if (!ids) return null;
    const id = ids[ids.length - 1];
    const slugMatch = entry.match(new RegExp(`/([^/]*${id})/?(?:inspect)?/?$`));
    const slug = slugMatch
        ? slugMatch[1].replace(new RegExp(`[-_]?${id}$`), "")
        : id;
    return { id, name: slug2name(slug) || id };
}

const TREE_CHARS = ["├──", "│   ", "└──"];

/**
 * Emit tree-format lines for a node. `node` is an array (workflow list)
 * or an object (subfolder map). `depth` is current nesting level.
 */
function emit(name, node, depth, lines) {
    const indent = "│   ".repeat(depth);
    lines.push(`${indent}[folder] ${name}/`);
    if (Array.isArray(node)) {
        for (const entry of node) {
            const wf = parseEntry(entry);
            if (!wf) {
                console.warn(`⚠️  skipped (no p_xxx id found): ${entry}`);
                continue;
            }
            lines.push(`${"│   ".repeat(depth + 1)}├── [workflow] ${wf.name} (${wf.id})`);
        }
    } else if (node && typeof node === "object") {
        for (const [child, val] of Object.entries(node)) {
            emit(child, val, depth + 1, lines);
        }
    }
}

const spec = JSON.parse(await fs.readFile(SPEC_PATH, "utf8"));

const lines = [];
for (const [folder, val] of Object.entries(spec)) {
    emit(folder, val, 0, lines);
}

const out = lines.join("\n") + "\n";
await fs.writeFile("pipedream_workflows.txt", out);

const wfCount = (out.match(/\[workflow\]/g) || []).length;
const folderCount = (out.match(/\[folder\]/g) || []).length;
console.log(`✓ Wrote pipedream_workflows.txt — ${folderCount} folders, ${wfCount} workflows`);
