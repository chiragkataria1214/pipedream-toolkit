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

The easiest way to get started is to **get the `.env` file from Chirag**.

If you have it, simply drop it into the repo root. If not, copy the example:

```bash
cp .env.example .env
```

Open `.env` in Cursor and fill in (if you didn't get one from Chirag):

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

## 7. Create a new workflow (AI-assisted)

The fastest way to build a new workflow is to **ask Cursor (or Claude Code)** to do it for you. Since the AI has access to the `pipedream-workflows` rule/skill, it can scaffold the whole structure in seconds.

**Try asking Cursor:**
> "Create a new HTTP-triggered workflow in the 'Ops' project called 'SheetToSlack' with steps to fetchNewRows and postToSlack."

The AI will:
1. Run the `npm run create` script to generate the folder and JSON definition.
2. Inspect existing workflows to match the project's style and patterns.
3. Write the logic for the generated `.js` files.

---

## 8. Deployment

Once the workflow is created locally, you have two ways to push it to Pipedream:

### Method A: Manual Import (Recommended for fine-tuning)
1. Open Pipedream UI → **New workflow**
2. Click the `⋯` menu → **Import from JSON**
3. Paste the contents of `workflow_definition.json` (found in the new workflow folder).
4. Pipedream provisions the trigger and you can then paste your `.js` code into the cells.

### Method B: Automated Push (API)
Ask Cursor to deploy it for you:
> "Deploy this workflow to Pipedream."

The AI will ask you for the **Pipedream workflow link** (e.g., from your browser). Once you provide it, the AI will extract the ID and run the deployment script for you.

---

## 9. Day-to-day

| Situation | Command |
|---|---|
| Started the day, want to pick up overnight UI edits | `npm run refresh` |
| Only refreshed yesterday, fast incremental | `npm run refresh -- --since $(date -v -1d +%Y-%m-%d)` |
| Pull a single workflow you're touching right now | `npm run refresh -- --workflow p_abc123` |
| New workflow, AI-assisted | Ask Cursor: "Create a new workflow..." |
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

## What's NOT in this toolkit (yet)

- A "push edits" command — currently you re-paste `.js` changes into Pipedream UI. Coming soon.
- Tests — no harness yet.
- Linting — workflows aren't run through ESLint. Pipedream tolerates a wide range of styles.

PRs welcome.
