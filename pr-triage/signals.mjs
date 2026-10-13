// Deterministic, explainable signals computed from a pull request's
// description and diff. Each one has a weight (positive leans "slop",
// negative leans "real") and a plain-English reason. No AI involved.
import { parseDiff, kindOf, logicChanges, whitespaceOnly } from './diff.mjs';

export const SLOP_AT = 3;     // a total score at or above this reads as likely slop

// A short quote of PR text for a reason. Backticks are removed so the quote
// can sit inside a code span; the report escapes everything else.
export const quote = (s, max = 80) => {
  const t = String(s ?? '').replace(/[`\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
};

const PLACEHOLDERS = [
  /Fixes #\s*\(issue\)/i, /\(issue number\)/i, /please include a summary/i,
  /describe (your|the) changes?( here| in detail)?/i, /^\s*- \[ \] I have /im, /<!--\s*(describe|please|explain|what|why|add)[\s\S]*?-->/i,
];

const PRAISE = [
  /\bcomprehensive\b/i, /\brobust\b/i, /\bseamless(ly)?\b/i, /\bleverag(e|es|ed|ing)\b/i, /\bdelv(e|es|ing)\b/i,
  /\belevat(e|es|ing)\b/i, /\bstreamlin(e|es|ed|ing)\b/i, /\bcutting[- ]edge\b/i, /\bstate[- ]of[- ]the[- ]art\b/i,
  /\b(industry |modern )?best practices\b/i, /\bempower(s|ing)?\b/i, /\beffortless(ly)?\b/i, /\bblazing(ly)?[- ]fast\b/i,
  /\bgame[- ]?chang(er|ing)\b/i, /\bworld[- ]class\b/i, /\bpowerful\b/i, /\bintuitive\b/i, /\bbattle[- ]tested\b/i,
  /\bdeveloper[- ]friendly\b/i, /\boverall (clarity|quality|readability|experience)\b/i,
  /\b(enhanc|improv)(e|es|ed|ing) (the )?(overall )?(code )?(readability|maintainability|clarity|user experience)\b/i,
];

// Text that addresses whoever (or whatever) reviews the PR. Narrow on purpose:
// a genuine PR that adds an "AI review" feature must not trip it.
// It runs on normalised text (see plain()), so spacing tricks and invisible
// characters inside the words do not get past it.
const BOT = '(ai|llm|gpt|claude|copilot|automated|bot|reviewer|review bot|triage bot)s?';
const INJECTION = new RegExp([
  'ignore (all |any )?(the )?(previous|prior|above|earlier|your) (instructions|rules|prompts?)',
  `\\b(note|message|instructions?|attention)( to| for) (any |all |the )?${BOT}\\b`,
  `\\b(dear|hey|hi|hello) ${BOT}\\b`,
  '\\bclassify (this|it)( pr| pull request| change)? as\\b',
  '\\bmark (this|it)( pr| pull request)? as (real|genuine|safe|approved)\\b',
  '\\bthis (pr|pull request|change) is (real|genuine|legit(imate)?|safe|not (ai )?slop)\\b',
  '\\bpre-?approved by\\b',
].join('|'), 'i');

// Characters that hide text from a human reader: bidi overrides ("Trojan
// Source") and Unicode tag characters (invisible "ASCII smuggling").
const HIDDEN = /[\u202a-\u202e\u2066-\u2069\u{e0000}-\u{e007f}]/u;
const INVISIBLE = /[\u00ad\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff\u{e0000}-\u{e007f}]/gu;
const plain = (s) => String(s).normalize('NFKC').replace(INVISIBLE, '').replace(/\s+/g, ' ');

const COSMETIC_TITLE = /\b(typos?|spelling|misspell(ed|ing|ings)?|grammar|wording|whitespace|formatting|cosmetic|lint(ing)?|comments?|docs?|documentation|readme)\b/i;

const LINKED = /\b(fix(e[sd])?|close[sd]?|resolve[sd]?|refs?|see|part of|related to|addresses)\b[\s:]*(#\d+|https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/issues\/\d+)/i;

// The words a description has once template scaffolding is removed.
function meaningfulWords(body) {
  return String(body ?? '')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .split(/\r?\n/)
    .filter((l) => !/^\s*(#{1,6}\s|[-*] \[[ xX]\]|>)/.test(l))
    .join(' ')
    .match(/[A-Za-z0-9][\w'-]*/g) ?? [];
}

const words = (s) => new Set((String(s).toLowerCase().match(/[a-z0-9]{3,}/g) ?? [])
  .filter((w) => !['the', 'and', 'for', 'fix', 'add', 'update', 'with', 'from', 'this', 'that'].includes(w)));
const jaccard = (a, b) => {
  if (!a.size && !b.size) return 0;
  let both = 0;
  for (const x of a) if (b.has(x)) both += 1;
  return both / (a.size + b.size - both);
};

// Open pull requests that repeat an older one: same files and the same title
// or the same added lines. Maps the newer PR's number to the older one's.
export function duplicatesOf(prs) {
  const info = prs.map((p) => {
    const files = parseDiff(p.diff);
    return { n: p.number, files: new Set(files.map((f) => f.path)), title: words(p.title),
             lines: new Set(files.flatMap((f) => f.added.map((l) => l.trim())).filter(Boolean)) };
  }).sort((a, b) => a.n - b.n);
  const dup = new Map();
  for (let i = 0; i < info.length; i += 1) {
    for (let j = i + 1; j < info.length; j += 1) {
      const [a, b] = [info[i], info[j]];
      if (dup.has(b.n) || !a.files.size) continue;
      if (jaccard(a.files, b.files) >= 0.5 && (jaccard(a.title, b.title) >= 0.5 || jaccard(a.lines, b.lines) >= 0.6)) {
        dup.set(b.n, a.n);
      }
    }
  }
  return dup;
}

export function signalsFor(pr, { duplicateOf } = {}) {
  const out = [];
  const add = (id, weight, reason) => out.push({ id, weight, reason });
  const body = String(pr.body ?? '').slice(0, 20_000);     // GitHub allows 65,536; plenty to judge from
  const files = parseDiff(pr.diff);
  const kinds = files.map((f) => ({ f, kind: kindOf(f.path) }));
  const of = (k) => kinds.filter((x) => x.kind === k).map((x) => x.f);
  const code = of('code');
  // A test file only counts if it gains real lines: a one-line comment dropped
  // into tests/ must not buy a PR the "has tests" credit.
  const substantive = (f) => f.status !== 'deleted' &&
    f.added.filter((l) => l.trim() && !/^\s*(\/\/|#|\/?\*|<!--)/.test(l)).length >= 2;
  const tests = of('test').filter(substantive);
  const docs = of('docs');
  const deps = of('deps');
  const changed = files.reduce((n, f) => n + f.added.length + f.removed.length, 0);

  if (pr.diffError) add('no-diff', 0, `GitHub would not send the diff (${quote(pr.diffError, 120)}), so only the description was checked.`);

  // The description.
  const placeholder = PLACEHOLDERS.map((re) => body.match(re)?.[0]).find(Boolean);
  const wordCount = meaningfulWords(body).length;
  if (placeholder) add('template', 2, `The description still has the pull request template's placeholder text: \`${quote(placeholder, 60)}\`.`);
  else if (wordCount < 5) add('template', 2, 'The description is empty or only a few words, so it does not say what changed or why.');
  else if (wordCount >= 25) add('described', -1, 'The description explains the change in its own words.');

  const linked = (pr.closingIssuesReferences?.length ?? 0) > 0 || LINKED.test(body.replace(/<!--[\s\S]*?-->/g, ''));
  if (linked) add('linked-issue', -1, 'It links the issue it addresses.');
  else add('no-issue', 1, 'It does not link an issue, so there is no record that anyone asked for this.');

  // Tests.
  if (tests.length) add('tests', -2, `It adds or updates tests (${tests.map((f) => `\`${quote(f.path, 60)}\``).join(', ')}).`);
  else if (code.length) add('untested-code', 2, `It changes code (${code.slice(0, 3).map((f) => `\`${quote(f.path, 60)}\``).join(', ')}) without adding or updating a single test.`);

  // Scope.
  if (docs.length && !code.length && !tests.length && !deps.length && changed < 40 && !linked) {
    add('readme-only', 2, `It only rewords documentation (${changed} changed lines) and fixes no reported problem.`);
  }
  if (deps.length && code.length) {
    add('mixed', 2, `It bundles a dependency change (\`${quote(deps[0].path, 60)}\`) with source changes (${code.slice(0, 3).map((f) => `\`${quote(f.path, 60)}\``).join(', ')}); those are unrelated and should be separate pull requests.`);
  }
  const dirs = new Set(code.map((f) => f.path.split('/').slice(0, -1).join('/') || '.'));
  if (dirs.size >= 4) add('scattered', 1, `Its code changes are scattered across ${dirs.size} unrelated folders.`);

  // Churn.
  const ws = files.reduce((n, f) => n + whitespaceOnly(f), 0);
  if (ws >= 6 && ws / Math.max(changed, 1) >= 0.3) {
    add('whitespace', 2, `${ws} of its ${changed} changed lines only change whitespace or indentation.`);
  }
  const pureRenames = files.filter((f) => f.status === 'renamed' && !f.added.length && !f.removed.length).length;
  if (pureRenames >= 3) add('renames', 1, `It renames ${pureRenames} files without changing what is in them.`);

  // Wording.
  const docText = docs.flatMap((f) => f.added).join('\n');
  const praise = [...new Set(PRAISE.map((re) => `${pr.title}\n${body}\n${docText}`.match(re)?.[0]?.toLowerCase()).filter(Boolean))];
  if (praise.length >= 2) {
    add('praise', 2, `It leans on generic praise wording: ${praise.slice(0, 5).map((w) => `“${quote(w, 40)}”`).join(', ')}.`);
  }

  // A cosmetic title over a logic change.
  if (COSMETIC_TITLE.test(pr.title ?? '')) {
    const change = code.map((f) => ({ f, c: logicChanges(f)[0] })).find((x) => x.c);
    if (change) {
      const { f, c } = change;
      const what = c.before && c.after ? `\`${quote(c.before)}\` became \`${quote(c.after)}\``
        : c.after ? `it adds \`${quote(c.after)}\`` : `it removes \`${quote(c.before)}\``;
      add('hidden-logic', 3, `The title “${quote(pr.title, 60)}” sounds cosmetic, but it changes behaviour in \`${quote(f.path, 60)}\`: ${what}.`);
    }
  }

  // Text aimed at whatever reviews it (including us).
  // Title, description, added lines and file paths, with invisible characters
  // removed and all whitespace (newlines too) collapsed, so "ignore\n  previous"
  // or a zero-width space inside a word does not slip past.
  const added = files.flatMap((f) => f.added.slice(0, 5000)).join('\n');
  const raw = `${pr.title}\n${body}\n${files.map((f) => f.path).join('\n')}\n${added}`;
  const text = plain(raw);
  const inj = text.match(INJECTION);
  if (inj) {
    const instruction = text.slice(inj.index, inj.index + 200).split('-->')[0];
    add('injection', 3, `It contains text addressed to AI reviewers (\`${quote(instruction, 90)}\`), an attempt to steer automated triage.`);
  }
  if (HIDDEN.test(raw)) {
    add('hidden-text', 3, 'It contains invisible or direction-reversing Unicode characters, which can show a human reader different text from what tools and models read.');
  }

  if (duplicateOf) add('duplicate', 2, `It looks like a duplicate of the older open pull request #${duplicateOf}: same files, same change.`);

  return { score: out.reduce((n, s) => n + s.weight, 0), signals: out };
}
