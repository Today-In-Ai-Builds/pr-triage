// The agent skill PR Triage uses as Claude's review rules, loaded at the exact
// commit that was reviewed, and refused if its bytes ever differ from that
// review. Nothing from the repo is copied into this one or installed into your agent.
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const SKILLS = {
  review: {
    name: "Matt Pocock's code-review",
    repo: 'mattpocock/skills', license: 'MIT',
    commit: 'b0618bc436ad893b3c5e84e55fba86586d34a404',
    path: 'skills/engineering/code-review/SKILL.md',
    sha256: '09eb147f793e4647949edd32dbad278f0554dfb56e0d46b699cd4c2c55bf0357',
  },
};

const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex');

async function fetchRaw(skill) {
  const url = `https://raw.githubusercontent.com/${skill.repo}/${skill.commit}/${skill.path}`;
  const res = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`${skill.name}: ${url} returned ${res.status}`);
  return res.text();
}

export async function loadSkill(skill, { fetch = fetchRaw, cacheDir = '.pr-triage/skills' } = {}) {
  const cached = cacheDir && join(cacheDir, `${skill.sha256}.md`);
  let text;
  if (cached) text = await readFile(cached, 'utf8').catch(() => undefined);
  text ??= await fetch(skill);
  if (sha256(text) !== skill.sha256) {
    throw new Error(`${skill.name} at ${skill.commit.slice(0, 7)} does not match its pinned sha256; ` +
      'refusing to run it. Review the new version before updating the pin in pr-triage/skills.mjs.');
  }
  if (cached) {
    await mkdir(cacheDir, { recursive: true });
    await writeFile(cached, text, 'utf8');
  }
  return text;
}
