#!/usr/bin/env node
// Usage:
//   node tools/trace-report.mjs [events.jsonl]                 list root conversations
//   node tools/trace-report.mjs [events.jsonl] --conv <id|prefix> [--also <id|prefix>]... [--out <dir>]
// Writes <out>/timeline.md and <out>/run-events.jsonl for one root conversation and
// every subagent conversation spawned under it (transitively).

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, basename } from "node:path";

const args = process.argv.slice(2);
const positional = args.filter((a, i) => !a.startsWith("--") && !(i > 0 && args[i - 1].startsWith("--")));
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const input = positional[0] || ".poteto-trace/events.jsonl";
const convArg = opt("--conv");
const outDir = opt("--out") || ".poteto-trace/report";

const events = readFileSync(input, "utf8")
  .split("\n")
  .filter(Boolean)
  .map((l) => {
    try {
      return JSON.parse(l);
    } catch {
      return null;
    }
  })
  .filter((e) => e && e.hook_event_name && e.conversation_id);

const childToParent = new Map();
const stopByChild = new Map();
for (const e of events) {
  if (e.hook_event_name === "subagentStop" && e.child_conversation_id) {
    childToParent.set(e.child_conversation_id, e.conversation_id);
    stopByChild.set(e.child_conversation_id, e);
  }
}

if (!convArg) {
  const roots = new Map();
  for (const e of events) {
    if (childToParent.has(e.conversation_id)) continue;
    const r = roots.get(e.conversation_id) || { id: e.conversation_id, n: 0, first: e.ts, last: e.ts, model: e.model, prompt: "" };
    r.n++;
    r.last = e.ts;
    if (e.hook_event_name === "beforeSubmitPrompt" && !r.prompt) r.prompt = (e.prompt || "").split("\n")[0].slice(0, 100);
    roots.set(e.conversation_id, r);
  }
  console.log("Root conversations in", input);
  for (const r of roots.values()) {
    console.log(`\n${r.id}\n  events=${r.n} model=${r.model} ${r.first} .. ${r.last}\n  first prompt: ${r.prompt || "(none captured)"}`);
  }
  console.log("\nRe-run with --conv <id>");
  process.exit(0);
}

const rootId = [...new Set(events.map((e) => e.conversation_id))].find((id) => id.startsWith(convArg));
if (!rootId) {
  console.error("no conversation starts with", convArg);
  process.exit(1);
}

// A subagent that never reached subagentStop (aborted mid-run) has no child_conversation_id
// link. Pass --also <id-prefix> to pull its conversation in by hand.
const members = new Set([rootId]);
for (const extra of args.flatMap((a, i) => (a === "--also" ? [args[i + 1]] : []))) {
  const id = [...new Set(events.map((e) => e.conversation_id))].find((c) => c.startsWith(extra));
  if (id) {
    members.add(id);
    childToParent.set(id, rootId);
  }
}
let grew = true;
while (grew) {
  grew = false;
  for (const [child, parent] of childToParent) {
    if (members.has(parent) && !members.has(child)) {
      members.add(child);
      grew = true;
    }
  }
}
const depthOf = (id) => {
  let d = 0;
  while (childToParent.has(id)) {
    id = childToParent.get(id);
    d++;
  }
  return d;
};
const label = (id) => {
  if (id === rootId) return "root";
  const stop = stopByChild.get(id);
  return `sub:${id.slice(0, 8)}${stop ? ` (${stop.subagent_type})` : ""}`;
};

const run = events.filter((e) => members.has(e.conversation_id));
const t0 = Date.parse(run[0].ts);
const rel = (ts) => ((Date.parse(ts) - t0) / 1000).toFixed(1).padStart(7) + "s";
const esc = (s) => String(s ?? "").replace(/\|/g, "\\|").replace(/\r?\n/g, " ").slice(0, 220);
const wsRoot = String((run.find((e) => e.workspace_roots?.length)?.workspace_roots || [""])[0])
  .replace(/^\/(?=[A-Za-z]:)/, "")
  .toLowerCase();
const short = (p) => {
  if (!p) return "";
  let s = String(p).replace(/\\/g, "/");
  if (wsRoot && s.toLowerCase().startsWith(wsRoot)) return "./" + s.slice(wsRoot.length).replace(/^\//, "");
  return s.replace(/^.*\/plugins\/cache\//, "plugins/").replace(/^.*\/Users\/[^/]+\/\.cursor\//i, "~/.cursor/").replace(/^.*\/Users\/[^/]+\/\.claude\//i, "~/.claude/");
};

function detail(e) {
  switch (e.hook_event_name) {
    case "beforeSubmitPrompt":
      return `prompt: ${esc(e.prompt)}  attachments: ${(e.attachments || []).map((a) => `${a.type}:${basename(a.file_path)}`).join(", ")}`;
    case "beforeReadFile":
      return `${short(e.file_path)} (${e.content_length ?? "?"} chars)`;
    case "afterFileEdit":
      return `${short(e.file_path)} (${(e.edits || []).length} edit${(e.edits || []).length === 1 ? "" : "s"})`;
    case "beforeShellExecution":
      return `$ ${esc(e.command)}`;
    case "afterShellExecution":
      return `done in ${e.duration}ms`;
    case "beforeMCPExecution":
      return `${e.mcp_server_name}.${e.tool_name} ${esc(e.tool_input)}`;
    case "afterMCPExecution":
      return `${e.mcp_server_name}.${e.tool_name} done in ${e.duration}ms`;
    case "subagentStart":
      return `type=${e.subagent_type} model=${e.subagent_model} task: ${esc((e.task || "").split("\n")[0])}`;
    case "subagentStop":
      return `type=${e.subagent_type} status=${e.status} ${e.duration_ms}ms tools=${e.tool_call_count} child=${(e.child_conversation_id || "").slice(0, 8)} "${esc(e.description)}"`;
    case "preToolUse": {
      const ti = e.tool_input || {};
      if (e.tool_name === "Task") return `Task type=${ti.subagent_type} model=${ti.model ?? "(inherit)"} bg=${ti.run_in_background} "${esc(ti.description)}"`;
      if (e.tool_name === "TodoWrite") return `TodoWrite merge=${ti.merge} ${(ti.todos || []).length} items`;
      if (ti.path || ti.file_path) return `${e.tool_name} ${short(ti.path || ti.file_path)}`;
      if (ti.pattern) return `${e.tool_name} /${esc(ti.pattern)}/ ${short(ti.path || "")}`;
      if (ti.glob_pattern) return `${e.tool_name} ${esc(ti.glob_pattern)}`;
      if (ti.command) return `${e.tool_name} ${esc(ti.command)}`;
      return `${e.tool_name}`;
    }
    case "postToolUseFailure":
      return `${e.tool_name} ${e.failure_type}: ${esc(e.error_message)}`;
    case "afterAgentResponse":
      return esc(e.text);
    case "afterAgentThought":
      return `${e.duration_ms ?? "?"}ms`;
    case "stop":
      return `status=${e.status} loop=${e.loop_count}`;
    case "preCompact":
      return `${e.trigger} ${e.context_usage_percent}% msgs=${e.message_count}`;
    case "sessionStart":
      return `mode=${e.composer_mode} background=${e.is_background_agent}`;
    default:
      return "";
  }
}

// Timeline rows. Read/Shell/MCP already have dedicated events, so preToolUse is kept
// only for tools that have no other event.
const TIMELINE_PRETOOL = new Set(["Task", "TodoWrite", "Write", "StrReplace", "Grep", "Glob", "Delete"]);
const SKIP = new Set(["postToolUse", "afterAgentThought"]);
const rows = run.filter((e) => {
  if (SKIP.has(e.hook_event_name)) return false;
  if (e.hook_event_name === "preToolUse") return TIMELINE_PRETOOL.has(e.tool_name);
  return true;
});

const counts = {};
for (const e of run) counts[e.hook_event_name] = (counts[e.hook_event_name] || 0) + 1;

const skillRe = /SKILL\.md$|\/playbooks\/|\/references\/|\.mdc$|\/agents\/.*\.md$/;
const skillReads = run.filter((e) => e.hook_event_name === "beforeReadFile" && skillRe.test(String(e.file_path).replace(/\\/g, "/")));
const otherReads = run.filter((e) => e.hook_event_name === "beforeReadFile" && !skillRe.test(String(e.file_path).replace(/\\/g, "/")));

const starts = run.filter((e) => e.hook_event_name === "subagentStart");
const stops = run.filter((e) => e.hook_event_name === "subagentStop");
const stopByToolCall = new Map(stops.map((s) => [s.subagent_id, s]));

const md = [];
md.push(`# Trace timeline for ${rootId}`);
md.push("");
md.push(`Source: \`${input}\`. ${run.length} events across ${members.size} conversation(s) (1 root + ${members.size - 1} subagent). Window ${run[0].ts} .. ${run[run.length - 1].ts}. Root model: \`${run.find((e) => e.conversation_id === rootId)?.model}\`.`);
md.push("");
md.push("## Event counts");
md.push("");
md.push("| event | count |");
md.push("|---|---:|");
for (const [k, v] of Object.entries(counts).sort((a, b) => b[1] - a[1])) md.push(`| ${k} | ${v} |`);
md.push("");

md.push("## Prompts submitted");
md.push("");
for (const e of run.filter((e) => e.hook_event_name === "beforeSubmitPrompt")) {
  md.push(`- ${rel(e.ts)} [${label(e.conversation_id)}] attachments: ${(e.attachments || []).map((a) => `${a.type} \`${short(a.file_path)}\``).join(", ") || "none"}`);
  md.push("");
  md.push("  ```text");
  for (const line of String(e.prompt || "").split("\n")) md.push("  " + line);
  md.push("  ```");
}
md.push("");

md.push("## Skill, playbook, principle and rule files read (in order)");
md.push("");
md.push("| t | agent | file | chars |");
md.push("|---|---|---|---:|");
for (const e of skillReads) md.push(`| ${rel(e.ts)} | ${label(e.conversation_id)} | \`${short(e.file_path)}\` | ${e.content_length ?? ""} |`);
md.push("");
const principleFiles = [...new Set(skillReads.map((e) => short(e.file_path)).filter((p) => /principle-/.test(p)))];
md.push(`Distinct principle leaf files read: ${principleFiles.length}`);
for (const p of principleFiles) md.push(`- \`${p}\``);
md.push("");

md.push("## Subagent tree");
md.push("");
md.push("| t | parent | type | model requested (Task) | model (hook) | status | duration | tools | child conv | description | first line of brief |");
md.push("|---|---|---|---|---|---|---:|---:|---|---|---|");
const taskCalls = run.filter((e) => e.hook_event_name === "preToolUse" && e.tool_name === "Task");
for (const s of starts) {
  const stop = stopByToolCall.get(s.subagent_id);
  const task = taskCalls.find((t) => t.tool_use_id === s.tool_call_id);
  md.push(
    `| ${rel(s.ts)} | ${label(s.conversation_id)} | ${s.subagent_type} | ${task?.tool_input?.model ?? "(inherit)"} | ${s.subagent_model} | ${stop?.status ?? "?"} | ${stop?.duration_ms ?? ""} | ${stop?.tool_call_count ?? ""} | ${(stop?.child_conversation_id || "").slice(0, 8)} | ${esc(stop?.description ?? task?.tool_input?.description ?? "")} | ${esc((s.task || "").split("\n")[0])} |`
  );
}
md.push("");
for (const s of stops) {
  if (s.agent_transcript_path) md.push(`- child ${s.child_conversation_id?.slice(0, 8)} transcript: \`${s.agent_transcript_path}\``);
}
md.push("");

md.push("## Todo list writes");
md.push("");
for (const e of run.filter((e) => e.hook_event_name === "preToolUse" && e.tool_name === "TodoWrite")) {
  md.push(`- ${rel(e.ts)} [${label(e.conversation_id)}] merge=${e.tool_input?.merge}`);
  for (const t of e.tool_input?.todos || []) md.push(`  - [${t.status}] ${esc(t.content)}`);
}
md.push("");

md.push("## Shell commands");
md.push("");
md.push("| t | agent | command | ms |");
md.push("|---|---|---|---:|");
const afterShell = run.filter((e) => e.hook_event_name === "afterShellExecution");
for (const e of run.filter((e) => e.hook_event_name === "beforeShellExecution")) {
  const after = afterShell.find((a) => a.conversation_id === e.conversation_id && a.command === e.command && Date.parse(a.ts) >= Date.parse(e.ts));
  md.push(`| ${rel(e.ts)} | ${label(e.conversation_id)} | \`${esc(e.command)}\` | ${after?.duration ? Math.round(after.duration) : ""} |`);
}
md.push("");

md.push("## MCP calls");
md.push("");
for (const e of run.filter((e) => e.hook_event_name === "beforeMCPExecution")) md.push(`- ${rel(e.ts)} [${label(e.conversation_id)}] ${e.mcp_server_name}.${e.tool_name} ${esc(e.tool_input)}`);
md.push("");

md.push("## File edits");
md.push("");
const editsByFile = new Map();
for (const e of run.filter((e) => e.hook_event_name === "afterFileEdit")) {
  const k = short(e.file_path);
  const v = editsByFile.get(k) || { n: 0, agents: new Set(), first: e.ts };
  v.n += (e.edits || []).length || 1;
  v.agents.add(label(e.conversation_id));
  editsByFile.set(k, v);
}
md.push("| file | edits | by | first at |");
md.push("|---|---:|---|---|");
for (const [f, v] of editsByFile) md.push(`| \`${f}\` | ${v.n} | ${[...v.agents].join(", ")} | ${rel(v.first)} |`);
md.push("");

md.push("## Other files read");
md.push("");
for (const e of otherReads) md.push(`- ${rel(e.ts)} [${label(e.conversation_id)}] \`${short(e.file_path)}\` (${e.content_length ?? "?"} chars)`);
md.push("");

md.push("## Tool failures");
md.push("");
for (const e of run.filter((e) => e.hook_event_name === "postToolUseFailure")) md.push(`- ${rel(e.ts)} [${label(e.conversation_id)}] ${detail(e)}`);
md.push("");

md.push("## Agent responses");
md.push("");
for (const e of run.filter((e) => e.hook_event_name === "afterAgentResponse")) {
  md.push(`### ${rel(e.ts)} [${label(e.conversation_id)}]`);
  md.push("");
  md.push(String(e.text || ""));
  md.push("");
}

md.push("## Full timeline");
md.push("");
md.push("| t | depth | agent | event | detail |");
md.push("|---|---:|---|---|---|");
for (const e of rows) md.push(`| ${rel(e.ts)} | ${depthOf(e.conversation_id)} | ${label(e.conversation_id)} | ${e.hook_event_name} | ${detail(e).replace(/\r?\n/g, " ")} |`);
md.push("");

mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, "timeline.md"), md.join("\n"));
writeFileSync(join(outDir, "run-events.jsonl"), run.map((e) => JSON.stringify(e)).join("\n") + "\n");
console.log(`root ${rootId}: ${run.length} events, ${members.size - 1} subagent conversation(s), ${skillReads.length} skill/rule reads, ${starts.length} subagent starts`);
console.log(`wrote ${join(outDir, "timeline.md")} and ${join(outDir, "run-events.jsonl")}`);
