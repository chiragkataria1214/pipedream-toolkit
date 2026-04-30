# pipedream-toolkit

> Manage Pipedream workflows from your laptop — pull every workflow into git, scaffold new ones with one command, deploy via API. Includes editor rules so **Cursor** and **Claude Code** know how to author Pipedream workflows correctly.

```
pipedream-toolkit/
├── scripts/
│   ├── refresh-exports.mjs    # `npm run refresh` — pull every workflow from Pipedream → ./exported_workflows
│   └── create-workflow.mjs    # `npm run create -- ...` — scaffold + (optional) deploy a new workflow
├── .cursor/rules/
│   └── pipedream-workflows.mdc  # Cursor auto-attached rule (activates when editing exported_workflows/**)
├── claude/skills/
│   └── pipedream-workflows/SKILL.md  # Claude Code skill (same content, different format)
├── .env.example
└── SETUP.md                   # Step-by-step setup for new contributors (Cursor users especially)
```

## What it does

| Command | What it does |
|---|---|
| `npm run refresh` | Lists every workflow in your Pipedream workspace via REST API and writes each one to `./exported_workflows/<Project>/<Workflow>/` as `workflow_definition.json` plus one file per step. Idempotent — re-run anytime to pick up UI edits. |
| `npm run refresh -- --since 2026-04-01` | Incremental refresh — only workflows updated after the cutoff. |
| `npm run refresh -- --workflow p_abc123` | Refresh one workflow. |
| `npm run create -- --project P --name N --steps a,b,c [--trigger http\|timer --cron "..."] [--deploy]` | Scaffold a new workflow folder with `defineComponent` stubs. Add `--deploy` to push to Pipedream via API. |

## Editor integration

When your editor opens a file under `exported_workflows/**` or one of the scripts, the **pipedream-workflows** rule/skill auto-activates and gives the assistant:

- the exact on-disk layout
- the `defineComponent({props, run})` contract
- the full `$` helper surface (`$.export`, `$.respond`, `$.flow.delay/suspend/exit`, `$.service.db`, `$.send.*`)
- trigger types (`HttpInterface`, `Timer`, `EventSource`, `Email`)
- worked patterns (Notion-query → conditional → action; HTTP-respond; idempotent polling)
- an authoring checklist + "don't" list

Works in **Cursor** (via `.cursor/rules/pipedream-workflows.mdc`) and **Claude Code** (via `claude/skills/pipedream-workflows/SKILL.md`).

## Setup

See [SETUP.md](./SETUP.md) — step-by-step for new contributors, written for Cursor users.

## License

MIT
