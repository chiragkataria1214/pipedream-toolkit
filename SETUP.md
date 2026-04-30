# Setup guide

A 10-minute walkthrough for getting `pipedream-toolkit` running on your laptop. Written for **Cursor** users; Claude Code instructions are inline at the end.

---

## 1. Prerequisites

- **Node.js 18+** — check with `node -v`. Install from [nodejs.org](https://nodejs.org) if missing.
- **git** — `git --version`.
- A **Pipedream account** with access to the workspace whose workflows you want to manage.

---

## 2. Clone the repo

```bash
git clone https://github.com/chiragkataria1214/pipedream-toolkit.git
cd pipedream-toolkit
npm install
```

---

## 3. Get your Pipedream credentials

You need two things:

### a) API key

1. Go to [pipedream.com/settings/api-keys](https://pipedream.com/settings/api-keys)
2. Click **Create API key**
3. Copy the key (starts with `apn_...`).

### b) Workspace / org id

1. Open Pipedream → click your workspace name (top-left) → **Settings**.
2. Look for **Organization ID** — it looks like `o_AbCdEf1`.
3. Copy it.

### c) (Optional) Project id

Only needed if you want `npm run create -- --deploy` to drop new workflows into a specific project rather than the workspace's default. Find it by opening any project in the UI and copying the `proj_xxxxxx` from the URL.

---

## 4. Configure `.env`

```bash
cp .env.example .env
```

Open `.env` in Cursor and fill in:

```env
PIPEDREAM_API_KEY=apn_...
PIPEDREAM_ORG_ID=o_...
# PIPEDREAM_PROJECT_ID=proj_...   # uncomment if you want a default project
```

`.env` is gitignored — it will not be committed.

---

## 5. First refresh

Pull every workflow in the workspace into `./exported_workflows/`:

```bash
npm run refresh
```

You'll see something like:

```
🚀 Refreshing Pipedream workflow exports…
📂 Found 12 projects
   212 workflows in scope.

[1/212] p_abc123 Notion/SyncMonthlyChangelog … ✅ 4 steps
[2/212] p_def456 HR/InboundResume … ✅ 7 steps
...
✨ Done. 212 ok · 0 failed · output: exported_workflows/
```

Each workflow ends up at `exported_workflows/<Project>/<WorkflowName>/` containing:
- `workflow_definition.json` — the full API payload (triggers, steps, props, secrets)
- one `.js` (or `.py` / `.sh`) file per code-cell step
- `<step>_action.json` for prebuilt component steps

---

## 6. Cursor — verify the rule is active

Open any file under `exported_workflows/**`. Cursor's chat sidebar should show **"Rules attached: pipedream-workflows"** (or similar — depends on your Cursor version).

Try asking Cursor:

> Add a step to this workflow that posts a Slack message after `buildEmailContent`.

It should produce code that:
- uses `export default defineComponent({ props, async run({steps, $}) { ... } })`
- declares the Slack app in `props`
- references upstream output via `steps.buildEmailContent.$return_value`

If Cursor produces generic Node.js code instead, the rule isn't being picked up — see **Troubleshooting** below.

---

## 7. Create a new workflow from the laptop

```bash
npm run create -- \
  --project Ops \
  --name SheetToSlack \
  --trigger timer --cron "*/5 * * * *" \
  --steps fetchNewRows,postToSlack
```

This writes:
```
exported_workflows/Ops/SheetToSlack/
  workflow_definition.json
  fetchNewRows.js
  postToSlack.js
```

Open the `.js` files and fill in the logic (Cursor's pipedream-workflows rule will help). Then deploy one of two ways:

**Hands-on (recommended for the first one):**
1. Open Pipedream UI → **New workflow**
2. Click the `⋯` menu → **Import from JSON**
3. Paste the contents of `workflow_definition.json`
4. Pipedream provisions the trigger URL/cron and you can fine-tune in the UI.

**Hands-off (after you trust the toolkit):**
```bash
npm run create -- \
  --project Ops --name SheetToSlack \
  --trigger timer --cron "*/5 * * * *" \
  --steps fetchNewRows,postToSlack \
  --deploy
```

This POSTs to `/v1/workflows` directly. If the API rejects the payload (4xx), the script tells you to fall back to the import-from-JSON path.

---

## 8. Day-to-day

| Situation | Command |
|---|---|
| Started the day, want to pick up overnight UI edits | `npm run refresh` |
| Only refreshed yesterday, fast incremental | `npm run refresh -- --since $(date -v -1d +%Y-%m-%d)` |
| Pull a single workflow you're touching right now | `npm run refresh -- --workflow p_abc123` |
| New workflow, AI-assisted | Ask Cursor → `npm run create -- ... --deploy` |
| Edit existing workflow code | Edit the `.js` file in `exported_workflows/<Project>/<Name>/`, then either paste back into Pipedream UI or wait for an automated push (TODO — not built yet) |

---

## Claude Code users

Same setup steps 1–5. Skip step 6 — Claude Code picks up the skill automatically from `claude/skills/pipedream-workflows/SKILL.md` when it's in the workspace.

Optional: install it globally so the skill works in any project, not just this repo:

```bash
mkdir -p ~/.claude/skills/pipedream-workflows
cp claude/skills/pipedream-workflows/SKILL.md ~/.claude/skills/pipedream-workflows/SKILL.md
```

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| `❌ PIPEDREAM_API_KEY missing` | You didn't copy `.env.example` to `.env`, or the key line is blank. |
| `❌ PIPEDREAM_ORG_ID missing` | Same — set it in `.env`. |
| `⚠️ workspace listing failed (404)` | Your API key may not have workspace-list scope. Either regenerate the key with full access, or drop a `pipedream_workflows.txt` tree-export into the repo root and the script will fall back to parsing it. |
| `Deploy failed (HTTP 4xx)` on `--deploy` | Pipedream's API shape for workflow creation is undocumented in places. Use the **Import from JSON** UI path instead — it always works. |
| Cursor doesn't pick up the rule | Cursor → Settings → Rules — confirm "Auto-attach" is enabled. Reload the window. Check `.cursor/rules/pipedream-workflows.mdc` exists in the repo root. |
| Want to start over | `rm -rf exported_workflows && npm run refresh` |

---

## What's NOT in this toolkit (yet)

- A "push edits" command — currently you re-paste `.js` changes into Pipedream UI. Coming soon.
- Tests — no harness yet.
- Linting — workflows aren't run through ESLint. Pipedream tolerates a wide range of styles.

PRs welcome.
