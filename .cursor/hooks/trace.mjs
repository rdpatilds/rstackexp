import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const root = process.env.CURSOR_PROJECT_DIR || process.cwd();
const dir = join(root, ".poteto-trace");
const file = join(dir, "events.jsonl");

const PERMISSION_EVENTS = new Set([
  "preToolUse",
  "subagentStart",
  "beforeShellExecution",
  "beforeMCPExecution",
  "beforeReadFile",
  "beforeTabFileRead",
]);

const CAP = 4000;

function cap(s) {
  if (typeof s !== "string" || s.length <= CAP) return s;
  return s.slice(0, CAP) + ` ...[truncated ${s.length - CAP} chars]`;
}

function trim(ev) {
  const out = { ...ev };
  if (typeof out.content === "string") {
    out.content_length = out.content.length;
    delete out.content;
  }
  for (const k of ["output", "tool_output", "result_json", "text", "summary", "prompt", "task", "agent_message"]) {
    if (k in out) out[k] = cap(out[k]);
  }
  if (out.tool_input && typeof out.tool_input === "object") {
    const ti = { ...out.tool_input };
    for (const k of ["content", "contents", "new_string", "old_string", "prompt"]) {
      if (k in ti) ti[k] = cap(ti[k]);
    }
    out.tool_input = ti;
  } else if (typeof out.tool_input === "string") {
    out.tool_input = cap(out.tool_input);
  }
  if (Array.isArray(out.edits)) {
    out.edits = out.edits.map((e) => ({
      ...e,
      old_string: cap(e.old_string),
      new_string: cap(e.new_string),
    }));
  }
  return out;
}

function respond(eventName) {
  if (PERMISSION_EVENTS.has(eventName)) return { permission: "allow" };
  if (eventName === "beforeSubmitPrompt") return { continue: true };
  return {};
}

let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => (raw += c));
process.stdin.on("end", () => {
  let ev = {};
  try {
    ev = JSON.parse(raw.replace(/^\uFEFF/, "").trim());
  } catch {
    ev = { parse_error: true, raw: cap(raw) };
  }
  const name = ev.hook_event_name || "unknown";
  try {
    mkdirSync(dir, { recursive: true });
    appendFileSync(file, JSON.stringify({ ts: new Date().toISOString(), ...trim(ev) }) + "\n");
  } catch {}
  process.stdout.write(JSON.stringify(respond(name)));
  process.exit(0);
});
