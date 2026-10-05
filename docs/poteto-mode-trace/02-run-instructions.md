# 02. Running the traced task

The tracer is passive. Start the task in a fresh chat so its hook events land under one new `conversation_id`.

## Before you start

1. Make sure `main` is clean and pushed (`git status`).
2. Confirm hooks are loaded: Cursor Settings, Hooks tab should list `.cursor/hooks.json` with 18 events. If it does not, reload the window.
3. Optional: empty the log so the run is easy to isolate. `Remove-Item .poteto-trace\events.jsonl`.

## Start the run

Open a new chat in this workspace. Type `/poteto-mode`. If two entries appear, pick the one from the pstack plugin (crown icon). Press Alt+Enter so it becomes a Custom Mode and stays attached on every turn, then send:

```text
/poteto-mode new task. Build a single-page task tracker in this repo as one index.html with vanilla JS and localStorage, no build step and no dependencies. A user can add a task, edit its title, mark it done or not done, and delete it. Tasks survive a page reload. Done means you have driven add, edit, toggle, delete and reload in the real browser and shown the stored value. Open a PR on rdpatilds/rstackexp when done.
```

Why the prompt is shaped this way:

- "new task" forces a fresh playbook match instead of continuing a prior one.
- "single-page ... one index.html ... no dependencies" keeps the Feature small so the trace stays readable.
- "Done means ... in the real browser and shown the stored value" gives step 5 a surface and a check (the prove-it-works principle).
- "Open a PR" makes step 8 (Opening a PR) run, which pulls in `no-comments`, `technical-writing`, `unslop`, and `gh`.
- It does not list skills. The playbook sequences them.

Let it run. Answer in that chat if it asks something. If it stops before the PR, send `continue`.

## After the run

Come back to the tracing chat and say `run done`, with the PR link if you have it. Or build the report yourself:

```powershell
node tools/trace-report.mjs                      # lists root conversations with their first prompt
node tools/trace-report.mjs --conv <id-prefix>   # writes .poteto-trace/report/timeline.md
```
