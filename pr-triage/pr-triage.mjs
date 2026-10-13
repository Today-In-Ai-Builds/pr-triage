#!/usr/bin/env node
// PR Triage: sorts a repository's open pull requests into real work and
// likely AI slop, with plain-English reasons for every call.
//
//   pr-triage owner/repo               # read-only; writes pr-triage-report.md
//   pr-triage owner/repo --label       # also labels each PR "triage: real" / "triage: likely-slop"
//   pr-triage --demo                   # five sample PRs, recorded Claude reply: offline, no login
//   pr-triage --demo --live            # the same five PRs, judged by Claude for real
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

import { checkRepo, fetchOpenPrs, applyLabels } from './github.mjs';
import { SKILLS, loadSkill } from './skills.mjs';
import { askClaude } from './claude.mjs';
import { buildPrompt, parseJudgement, diffBudget } from './judge.mjs';
import { renderReport } from './report.mjs';
import { triage, safeOutPath } from './triage.mjs';

const HELP = `Usage: pr-triage <owner/repo> [options]
       pr-triage --demo [--live]

Sorts a repository's open pull requests into REAL and LIKELY AI SLOP, with
reasons, and writes a ranked markdown report. Read-only unless --label.

Options:
  --out <file.md>   where to write the report (default pr-triage-report.md, inside this folder)
  --limit <n>       how many open pull requests to read, 1-100 (default 30)
  --no-ai           use the code signals only; do not call Claude
  --label           also apply "triage: real" / "triage: likely-slop" labels (writes to GitHub)
  --demo            triage five sample pull requests (no GitHub needed)
  --live            with --demo: ask Claude instead of using the recorded reply
  -h, --help        show this help
`;

const demoDir = join(import.meta.dirname, '..', 'demo');
const log = (msg) => process.stderr.write(`pr-triage: ${msg}\n`);

function options(argv) {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: {
    out: { type: 'string', default: 'pr-triage-report.md' },
    limit: { type: 'string', default: '30' },
    'no-ai': { type: 'boolean', default: false },
    label: { type: 'boolean', default: false },
    demo: { type: 'boolean', default: false },
    live: { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  } });
  if (values.help) return { help: true };
  const limit = Number(values.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('--limit must be a whole number from 1 to 100');
  if (values.demo && positionals.length) throw new Error('--demo takes no repository');
  if (values.demo && values.label) throw new Error('--label cannot be used with --demo: the demo PRs are not on GitHub');
  if (values.live && !values.demo) throw new Error('--live only applies to --demo (a real repository is always judged live)');
  if (values.live && values['no-ai']) throw new Error('--live and --no-ai contradict each other');
  if (!values.demo && positionals.length !== 1) throw new Error('give one repository as owner/repo, or --demo');
  return { ...values, limit, noAi: values['no-ai'], repo: values.demo ? null : checkRepo(positionals[0]) };
}

// Claude's judgement, or null with the reason it could not be had.
async function judge(prs, { mode }) {
  if (mode === 'none' || !prs.length) return { judgement: null };
  if (mode === 'recorded') {
    const text = JSON.parse(readFileSync(join(demoDir, 'model-reply.json'), 'utf8')).result;
    return settle(parseJudgement(text, prs.map((p) => p.number)));
  }
  let skill;
  try { skill = await loadSkill(SKILLS.review); } catch (e) { return { judgement: null, aiProblem: e.message }; }
  // One call per pull request, so text in one PR can never sway the verdict on
  // another. A few at a time.
  log(`asking Claude about ${prs.length} pull request(s), one at a time per PR (no tools, no network)`);
  const merged = { byNumber: new Map(), problems: [] };
  const errors = [];
  const queue = [...prs];
  const worker = async () => {
    for (let pr = queue.shift(); pr; pr = queue.shift()) {
      try {
        const one = parseJudgement(await askClaude(buildPrompt(skill, [pr])), [pr.number]);
        for (const [n, v] of one.byNumber) merged.byNumber.set(n, v);
        merged.problems.push(...one.problems);
      } catch (e) {
        errors.push(e.message);
        merged.problems.push(`#${pr.number}: Claude could not answer`);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(3, prs.length) }, worker));
  if (!merged.byNumber.size && errors.length) return { judgement: null, aiProblem: errors[0] };
  return settle(merged);
}

function settle(judgement) {
  if (!judgement.byNumber.size) return { judgement: null, aiProblem: judgement.problems.join('; ') };
  return { judgement, problems: judgement.problems };
}

export async function main(argv = process.argv.slice(2)) {
  const opts = options(argv);
  if (opts.help) { process.stdout.write(HELP); return; }
  const outPath = safeOutPath(opts.out);       // refuse a bad --out before any work
  let repo;
  let prs;
  if (opts.demo) {
    const fixture = JSON.parse(readFileSync(join(demoDir, 'prs.json'), 'utf8'));
    ({ repo, prs } = fixture);
    log(`demo: ${prs.length} sample pull requests to ${repo}`);
  } else {
    repo = opts.repo;
    log(`reading open pull requests in ${repo} (read-only)`);
    prs = await fetchOpenPrs(repo, { limit: opts.limit });
  }
  const mode = opts.noAi ? 'none' : opts.demo && !opts.live ? 'recorded' : 'live';
  const { judgement, aiProblem, problems = [] } = await judge(prs, { mode });
  if (aiProblem) log(`Claude's judgement is unusable (${aiProblem}); using the code signals alone`);
  const results = triage(prs, judgement, { cutAt: mode === 'live' ? Object.assign({}, ...prs.map((p) => diffBudget([p]))) : {} });

  let labels;
  let labelProblem;
  if (opts.label) {
    if (aiProblem) {
      labelProblem = 'Claude failed, and labels from a half-run would mislead. Re-run, or add --no-ai to label on the code signals alone.';
    } else {
      log(`labelling ${results.length} pull request(s)`);
      // A labelling failure (no write access, say) must not lose the report.
      try { labels = await applyLabels(repo, results); } catch (e) { labelProblem = e.message; }
    }
    if (labelProblem) log(`not labelled: ${labelProblem}`);
  }
  const body = renderReport({ repo, results, mode, aiProblem, problems, labels, labelProblem });
  writeFileSync(outPath, `${body}\n`);
  log(`wrote ${opts.out}`);
  process.stdout.write(`${body}\n`);
}

if (import.meta.main) {
  main().catch((err) => { log(err.message); process.exit(1); });
}
