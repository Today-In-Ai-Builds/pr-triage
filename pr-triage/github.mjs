// Everything PR Triage asks of GitHub goes through the GitHub CLI, with
// arguments passed as arrays (no shell, so nothing in them is interpreted).
// Reading is the default; labels are only written with --label.
import { execFile } from 'node:child_process';

// owner/repo as GitHub allows them: no leading dash (it would read as a flag),
// no "." or ".." (paths), nothing a shell or gh could interpret.
const REPO = /^(?!-)[A-Za-z0-9-]{1,39}\/(?!\.\.?$)(?!-)[A-Za-z0-9._-]{1,100}$/;

export function checkRepo(repo) {
  if (typeof repo !== 'string' || !REPO.test(repo)) {
    throw new Error(`expected a GitHub repository as owner/repo, got ${JSON.stringify(String(repo ?? '')).slice(0, 80)}`);
  }
  return repo;
}

function prNumber(n) {
  const s = String(n);
  if (!/^[1-9]\d{0,9}$/.test(s)) throw new Error(`not a PR number: ${s.slice(0, 40)}`);
  return s;
}

const FIELDS = 'number,title,author,body,createdAt,additions,deletions,files,closingIssuesReferences,isDraft,url';
export const LABELS = { real: 'triage: real', 'likely-slop': 'triage: likely-slop' };

export const listArgs = (repo, limit) => ['pr', 'list', '--repo', checkRepo(repo), '--state', 'open',
  '--limit', String(limit), '--json', 'number'];
export const viewArgs = (repo, n) => ['pr', 'view', prNumber(n), '--repo', checkRepo(repo), '--json', FIELDS];
export const diffArgs = (repo, n) => ['pr', 'diff', prNumber(n), '--repo', checkRepo(repo), '--color', 'never'];
export const labelArgs = (repo, n, verdict) => {
  const other = verdict === 'real' ? 'likely-slop' : 'real';
  if (!(verdict in LABELS)) throw new Error(`unknown verdict ${verdict}`);
  return ['pr', 'edit', prNumber(n), '--repo', checkRepo(repo), '--add-label', LABELS[verdict], '--remove-label', LABELS[other]];
};

export function runGh(args) {
  return new Promise((resolve, reject) => {
    execFile(process.env.GH_BIN || 'gh', args, {
      shell: false, windowsHide: true, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 2 * 60 * 1000,
      env: { ...process.env, GH_PROMPT_DISABLED: '1', NO_COLOR: '1', GH_PAGER: '', PAGER: '' },
    }, (err, out, errOut) => (err ? reject(new Error(`gh ${args.slice(0, 2).join(' ')} failed: ${(errOut || err.message).trim()}`)) : resolve(out)));
  });
}

export async function fetchOpenPrs(repo, { limit = 30, gh = runGh } = {}) {
  const list = JSON.parse(await gh(listArgs(repo, limit)));
  const numbers = (Array.isArray(list) ? list : []).map((p) => p?.number).filter((n) => Number.isInteger(n) && n > 0);
  const prs = [];
  for (const n of numbers) {                         // one at a time: polite to the API
    const pr = JSON.parse(await gh(viewArgs(repo, n)));
    if (pr?.number !== n) throw new Error(`gh returned a different pull request for #${n}`);
    try {
      pr.diff = await gh(diffArgs(repo, n));
    } catch (e) {
      pr.diff = '';
      pr.diffError = e.message;                      // e.g. GitHub refuses diffs over 20,000 lines
    }
    prs.push(pr);
  }
  return prs;
}

// Only with --label. Creates whichever of the two labels is missing (never
// edits an existing one), then labels each PR. One failure does not stop the rest.
export async function applyLabels(repo, results, { gh = runGh } = {}) {
  if (!results.length) return [];                 // nothing to label: create nothing either
  // GitHub label names are case-insensitive, so compare them that way.
  const existing = new Set(JSON.parse(await gh(['label', 'list', '--repo', checkRepo(repo), '--limit', '1000', '--json', 'name']))
    .map((l) => String(l.name).toLowerCase()));
  const colour = { real: '2da44e', 'likely-slop': 'd1242f' };
  for (const [verdict, name] of Object.entries(LABELS)) {
    if (existing.has(name.toLowerCase())) continue;
    await gh(['label', 'create', name, '--repo', repo, '--color', colour[verdict],
      '--description', `Set by pr-triage: ${verdict === 'real' ? 'looks like a genuine contribution' : 'looks like low-value AI-generated work'}`]);
  }
  const done = [];
  for (const r of results) {
    try {
      await gh(labelArgs(repo, r.pr.number, r.verdict));
      done.push({ number: r.pr.number, verdict: r.verdict, ok: true });
    } catch (e) {
      done.push({ number: r.pr.number, verdict: r.verdict, ok: false, error: e.message });
    }
  }
  return done;
}
