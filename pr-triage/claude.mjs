// One locked-down Claude Code call. The prompt carries pull requests that
// anyone can write, so the model gets no tools at all: it cannot run
// commands, read or write files, or reach the network. It can only answer.
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export function claudeArgs(model = process.env.PR_TRIAGE_MODEL || 'sonnet') {
  return ['-p', '--model', model, '--output-format', 'json',
          '--tools', '',                       // no tools
          '--safe-mode',                       // no plugins, hooks, CLAUDE.md or skills of yours
          '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
          '--no-session-persistence'];         // nothing kept on disk
}

// The answer is the whole reply, or its ```json block. Only then fall back to
// scanning, so a stray "{}" in the model's prose is never taken for the answer.
// The scan is bounded: a reply full of braces must not hang the run.
const MAX_SCAN_ATTEMPTS = 400;

export function firstJson(text) {
  const whole = String(text).trim();
  // The LAST fenced block: if the reply quotes a block from a PR before giving
  // its own answer, the quote must not be taken for the answer.
  const fenced = [...whole.matchAll(/```(?:json)?\s*\n([\s\S]*?)\n```/g)].at(-1);
  for (const candidate of [whole, fenced?.[1]]) {
    if (!candidate) continue;
    try {
      const v = JSON.parse(candidate);
      if (v && typeof v === 'object' && !Array.isArray(v)) return v;
    } catch { /* not the whole answer */ }
  }
  let attempts = 0;
  for (let i = whole.indexOf('{'); i !== -1 && attempts < MAX_SCAN_ATTEMPTS; i = whole.indexOf('{', i + 1)) {
    for (let j = whole.lastIndexOf('}'); j > i && attempts < MAX_SCAN_ATTEMPTS; j = whole.lastIndexOf('}', j - 1)) {
      attempts += 1;
      try {
        const v = JSON.parse(whole.slice(i, j + 1));
        if (v && typeof v === 'object' && !Array.isArray(v)) return v;
      } catch { /* try a shorter span */ }
    }
  }
  throw new Error(`no JSON object in the reply: ${whole.slice(0, 200)}`);
}

// Without a shell, Windows can only start a real .exe: an npm-installed
// claude.cmd shim is not found. Say how to fix that instead of failing quietly.
const hint = (err) => (process.platform === 'win32' && err.code === 'ENOENT'
  ? ' (on Windows, set CLAUDE_BIN to the full path of claude.exe; a claude.cmd shim cannot be started without a shell)' : '');

// Returns the model's reply text. Parsing and validating it is the caller's
// job, so a malformed answer can fall back instead of crashing the run.
export async function askClaude(prompt) {
  const cwd = await mkdtemp(join(tmpdir(), 'pr-triage-'));   // empty: no project files to read
  try {
    const stdout = await new Promise((resolve, reject) => {
      const child = execFile(process.env.CLAUDE_BIN || 'claude', claudeArgs(),
        // No shell, on any platform: a shell drops the empty `--tools ""` value
        // (which is what disables every tool) and mangles the JSON argument.
        { cwd, maxBuffer: 16 * 1024 * 1024, timeout: 10 * 60 * 1000, shell: false, windowsHide: true },
        (err, out, errOut) => (err ? reject(new Error(`claude failed: ${err.message} ${errOut}${hint(err)}`)) : resolve(out)));
      // A missing or early-exiting claude errors the pipe: reject, don't crash.
      child.stdin.on('error', (e) => reject(new Error(`claude could not be started: ${e.message}`)));
      child.stdin.end(prompt);                  // stdin, not argv: diffs are long
    });
    let envelope;
    try { envelope = JSON.parse(stdout); } catch { throw new Error('claude did not return its JSON envelope'); }
    if (envelope.is_error) throw new Error(`claude error: ${envelope.result}`);
    if (typeof envelope.result !== 'string') throw new Error('claude returned no answer');
    return envelope.result;
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}
