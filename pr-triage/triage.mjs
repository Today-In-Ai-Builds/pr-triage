// Puts the pieces together: signals for every PR, Claude's judgement where it
// has one, one ranked list. Also guards where the report may be written.
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { signalsFor, duplicatesOf } from './signals.mjs';
import { combine } from './judge.mjs';

// Real PRs first, clearest first; then slop, worst first.
export function triage(prs, judgement, { cutAt = {} } = {}) {
  const dup = duplicatesOf(prs);
  const results = prs.map((pr) => {
    const sig = signalsFor(pr, { duplicateOf: dup.get(pr.number) });
    const model = judgement?.byNumber.get(pr.number) ?? null;
    return { pr, sig, model, cutAt: model ? cutAt[pr.number] : undefined, ...combine(sig, model) };
  });
  const real = results.filter((r) => r.verdict === 'real').sort((a, b) => a.total - b.total || a.pr.number - b.pr.number);
  const slop = results.filter((r) => r.verdict === 'likely-slop').sort((a, b) => b.total - a.total || a.pr.number - b.pr.number);
  return [...real, ...slop];
}

const inside = (root, p) => {
  const rel = relative(root, p);
  return rel !== '' && !rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel);
};

// The report may only be written as a .md file inside the current folder, and
// never through a symlink: --out cannot be used to overwrite anything else.
export function safeOutPath(out, cwd = process.cwd()) {
  const fail = (why) => { throw new Error(`--out ${JSON.stringify(String(out)).slice(0, 80)}: ${why}`); };
  if (typeof out !== 'string' || !out.trim()) fail('give a file name');
  // No ":" beyond a drive letter: on Windows "notes.txt:x.md" would write an
  // alternate data stream onto notes.txt.
  if (out.replace(/^[A-Za-z]:[\\/]/, '').includes(':')) fail('may not contain ":"');
  const root = realpathSync(cwd);
  const target = resolve(root, out);
  if (!inside(root, target)) fail('must be inside the current folder');
  if (extname(target).toLowerCase() !== '.md') fail('must end in .md');
  if (!existsSync(dirname(target))) fail('its folder does not exist');
  const realDir = realpathSync(dirname(target));
  if (realDir !== root && !inside(root, realDir)) fail('its folder links outside the current folder');
  // lstat, not exists: existsSync() is false for a dangling symlink, which a
  // write would still follow to wherever it points.
  let st = null;
  try { st = lstatSync(target); } catch { /* a new file */ }
  if (st?.isSymbolicLink()) fail('is a symlink');
  if (st && !st.isFile()) fail('is not a file');
  // Only overwrite an earlier PR Triage report, never e.g. README.md.
  if (st && !readFileSync(target, 'utf8').startsWith('# PR Triage: ')) fail('already exists and is not a PR Triage report');
  return target;
}
