// The ranked markdown report. Every piece of text that came from a pull
// request or from the model passes through esc() or rich() on its way in.
import { SKILLS } from './skills.mjs';

// Control characters (terminal escape codes), bidi overrides and zero-width
// characters: none belong in a report that is printed to a terminal and posted.
const INVISIBLE = /[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u180e\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff\u{e0000}-\u{e007f}]/gu;
const ZWSP = '\u200b';

function flatten(text, max) {
  const s = String(text ?? '')
    .replace(INVISIBLE, ' ')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')                      // links and images -> their words
    .replace(/\b(?:https?|ftp|file):\/\/\S+|\bwww\.\S+/gi, '(link removed)')
    .replace(/\s+/g, ' ')
    .trim();
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

function neutralise(s) {
  return s
    .replace(/[\\`*_{}[\]<>|~&]/g, '\\$&')                 // markdown, HTML, tables, entities
    .replace(/(^|[^A-Za-z0-9])@(?=[\w-])/g, `$1@${ZWSP}`)   // @mentions (GitHub accepts any non-alphanumeric before @); lodash@4 stays copyable
    .replace(/#(?=\d)/g, `#${ZWSP}`)                        // #123 cross-references
    .replace(/\bGH-(?=\d)/gi, (m) => `${m}${ZWSP}`);        // GH-123 cross-references
}

// Untrusted text as one inert line of markdown.
export function esc(text, max = 300) {
  return neutralise(flatten(text, max));
}

// In a table cell even a code span ends at "|", so there it is escaped
// (GitHub renders "\|" inside a table's code span as a plain "|").
function codeSpan(s, { table = false } = {}) {
  let t = String(s).replace(INVISIBLE, ' ').replace(/`/g, "'").replace(/\s+/g, ' ').trim().slice(0, 160);
  if (table) t = t.replace(/\|/g, '\\|');
  return t ? `\`${t}\`` : '';
}

// Like esc(), but `code` stays a code span (nothing inside one is a link,
// a mention or HTML on GitHub). Used for reasons, ours and the model's.
export function rich(text, max = 300, { table = false } = {}) {
  const parts = flatten(text, 4000).split(/`([^`]{1,160})`/);
  // Clip by visible length, part by part, so a cut never leaves a code span open.
  let left = max;
  const out = [];
  for (let i = 0; i < parts.length && left > 0; i += 1) {
    const part = parts[i].length > left ? `${parts[i].slice(0, left)}…` : parts[i];
    left -= parts[i].length;
    out.push(i % 2 ? codeSpan(part, { table }) : neutralise(part));
  }
  return out.join('');
}

const PR_URL = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+$/;
const ref = (pr) => (PR_URL.test(pr.url ?? '') ? `[#${pr.number}](${pr.url})` : `#${pr.number}`);
const signed = (w) => (w > 0 ? `+${w}` : w < 0 ? `−${-w}` : '±0');
const VERDICT = { real: '✅ real', 'likely-slop': '🗑️ likely slop' };

function mainReason(r) {
  if (r.model && !r.modelIgnored) return r.model.reasons[0];
  const sorted = [...r.sig.signals].sort((a, b) => (r.verdict === 'real' ? a.weight - b.weight : b.weight - a.weight));
  return sorted[0]?.reason ?? '';
}

function section(r) {
  const p = r.pr;
  const files = p.files?.length ?? 0;
  const lines = [
    `### ${ref(p)} · ${esc(p.title, 120)}`,
    '',
    `by ${esc(p.author?.login ?? 'unknown', 40)} · ${files} file${files === 1 ? '' : 's'} · +${Number(p.additions) || 0} −${Number(p.deletions) || 0}` +
      `${p.isDraft ? ' · draft' : ''} · **${VERDICT[r.verdict]}** (score ${signed(r.total)})`,
    '',
  ];
  if (r.disagree) lines.push('> ⚖️ Claude and the code signals disagree on this one. Worth a closer look.', '');
  if (r.modelIgnored) lines.push('> 🛡️ Claude called this real, but that was set aside: the pull request contains text aimed at AI reviewers.', '');
  if (r.model) {
    lines.push(`**Claude** (${r.model.verdict === 'real' ? 'real' : 'likely slop'}, ${r.model.confidence} confidence):`);
    for (const reason of r.model.reasons) lines.push(`- ${rich(reason)}`);
    if (r.cutAt) lines.push(`- *Claude saw only the first ${r.cutAt.toLocaleString('en-US')} characters of this diff.*`);
    lines.push('');
  }
  lines.push(`**Signals** (${signed(r.sig.score)}):`);
  for (const s of r.sig.signals) lines.push(`- ${signed(s.weight)} · ${rich(s.reason)}`);
  lines.push('');
  return lines;
}

export function renderReport({ repo, results, mode, aiProblem, problems = [], labels, labelProblem }) {
  const real = results.filter((r) => r.verdict === 'real');
  const slop = results.filter((r) => r.verdict === 'likely-slop');
  const skill = SKILLS.review;
  const how = {
    recorded: `Code signals + Claude (a recorded reply, so the demo needs no login), applying ${skill.name} skill`,
    live: `Code signals + Claude, applying ${skill.name} skill`,
    none: 'Code signals only (`--no-ai`)',
  }[mode] ?? 'Code signals';
  const out = [
    `# PR Triage: ${esc(repo, 120)}`,
    '',
    `**${results.length} open pull request${results.length === 1 ? '' : 's'}: ${real.length} look${real.length === 1 ? 's' : ''} real · ${slop.length} look${slop.length === 1 ? 's' : ''} like AI slop**`,
    '',
    `<sub>${how}. ${labels ? 'Labels were applied (see the end).' : labelProblem ? 'Labelling was asked for but failed (see below).' : 'Read-only: nothing was changed on GitHub.'}</sub>`,
    '',
  ];
  if (labelProblem) out.push(`> ⚠️ No labels were applied: ${esc(labelProblem, 300)}`, '');
  if (aiProblem) {
    out.push(`> ⚠️ Claude's judgement could not be used (${esc(aiProblem, 200)}). The verdicts below come from the code signals alone.`, '');
  } else if (problems.length) {
    out.push(`> ⚠️ Parts of Claude's answer were unusable (${esc(problems.join('; '), 400)}). Those pull requests use the code signals alone.`, '');
  }
  if (!results.length) {
    out.push('No open pull requests.');
    return out.join('\n');
  }
  out.push('| Rank | Pull request | Verdict | Main reason |', '| --- | --- | --- | --- |');
  results.forEach((r, i) => {
    out.push(`| ${i + 1} | #${r.pr.number} ${esc(r.pr.title, 60)} | ${VERDICT[r.verdict]} | ${rich(mainReason(r), 110, { table: true })} |`);
  });
  out.push('');
  if (real.length) out.push('## ✅ Worth a review', '', ...real.flatMap(section));
  if (slop.length) out.push('## 🗑️ Likely AI slop', '', ...slop.flatMap(section));
  if (labels) {
    out.push('## Labels', '');
    for (const l of labels) {
      out.push(`- #${l.number}: ${l.ok ? `labelled \`triage: ${l.verdict}\`` : `not labelled (${esc(l.error, 160)})`}`);
    }
    out.push('');
  }
  out.push('---',
    '<sub>Scores: each code signal adds or subtracts points (shown beside it); Claude adds up to 4 for "likely slop" or subtracts up to 4 for "real", by confidence. ' +
    `A total of 3 or more reads as likely slop. Claude's rules are [${skill.name}](https://github.com/${skill.repo}/blob/${skill.commit}/${skill.path}) skill (${skill.license}), ` +
    'pinned by commit and SHA-256. Pull request code is read as text and never run.</sub>');
  return out.join('\n');
}
