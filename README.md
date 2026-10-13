<p align="center"><img src="docs/media/banner.png" alt="PR Triage: sorts your open pull requests into real work and likely AI slop, with a plain-English reason for every call" width="100%"></p>

**PR Triage** reads a repository's open pull requests and sorts them into the ones worth a maintainer's time and the ones that look like AI slop. Every call comes with plain-English reasons.

1. **Signals computed in code.** Unfilled template, no linked issue, code changed with no tests, a dependency bump bundled with a refactor, whitespace churn, README-only rewording, generic praise ("robust", "seamless", "best practices"), a "Fix typos" title over a logic change, near-duplicates of another open PR, and text aimed at AI reviewers. Each signal adds or subtracts points, and the report shows which ones fired.
2. **A judgement from Claude.** Claude applies [Matt Pocock's `code-review` skill](https://github.com/mattpocock/skills) and treats each PR's description as its spec: does the diff do what it says, and nothing else? Its answer has to be strict JSON. If it is malformed or Claude can't run, PR Triage uses the signals alone and says so in the report.

Out of the box it only reads. `--label` is opt-in and is the only thing that writes to GitHub.

<p align="center"><img src="docs/media/demo.gif" alt="A terminal runs pr-triage --demo: two pull requests are marked real and three likely slop, each with its main reason" width="760"></p>

## What it caught

`pr-triage --demo` runs on five pull requests to [`demo/tiny-invoice`](demo/tiny-invoice), a small invoice library inside this repo. The PR diffs are real `git diff` output against that folder ([`demo/prs.json`](demo/prs.json)). Two are genuine and three are slop:

| PR | What it really is | Verdict |
| --- | --- | --- |
| #12 Clamp discounts so a total can never go negative | A bug fix with two tests, linked to its issue | ✅ real |
| #14 Add `toCsv()` | A small feature, documented and tested | ✅ real |
| #16 chore: bump prettier and refactor | A dependency bump, a reformat, and a "refactor" that changes `formatMoney`'s output. The description also hides a note telling AI reviewers to approve it | 🗑️ slop |
| #15 Improve README | Marketing copy in place of one accurate sentence, with the PR template left unfilled | 🗑️ slop |
| #17 Fix typos | Two real typo fixes, plus `daysLate > 30` quietly changed to `>= 30` | 🗑️ slop |

The signals flagged #17's `>` to `>=` change and #16's note to AI reviewers without any AI involved. Applying #16 or #17 to the sample project breaks one of its existing tests. The full report:

<p align="center"><img src="docs/media/report.png" alt="The PR Triage report: a ranked table, then each pull request with Claude's reasons and the code signals with their points" width="820"></p>

A 30-second video of the run is at [`docs/media/demo.mp4`](docs/media/demo.mp4).

## How it works

```mermaid
flowchart LR
  GH[gh pr list / view / diff<br>read-only] --> S[Signals in code<br>points + reasons]
  GH --> C[Claude, no tools<br>code-review skill]
  C -- strict JSON, validated --> M[Combine]
  C -. bad JSON or failure .-> M
  S --> M
  M --> R[Ranked report<br>stdout + .md file]
  M -. only with --label .-> L[triage: real /<br>triage: likely-slop]
```

Each signal has a weight shown next to it in the report. Claude adds up to 4 points for "likely slop" or subtracts up to 4 for "real", depending on its confidence. A total of 3 or more reads as likely slop. When Claude and the signals disagree, the report marks that PR as worth a closer look.

## Try it

You need Node.js 24.2 or newer. There is nothing to install, because PR Triage has no dependencies.

```bash
git clone https://github.com/Today-In-Ai-Builds/pr-triage && cd pr-triage
node pr-triage/pr-triage.mjs --demo           # offline, no login, writes pr-triage-report.md
```

The demo uses a recorded Claude reply by default, so it gives the same result every time. That reply goes through the same JSON validation as a live one. To have Claude judge the five PRs for real, sign in to [Claude Code](https://claude.com/claude-code) (it runs on your own plan) and add `--live`.

On a real repository you also need the [GitHub CLI](https://cli.github.com), signed in:

```bash
node pr-triage/pr-triage.mjs owner/repo               # read-only
node pr-triage/pr-triage.mjs owner/repo --no-ai       # signals only, no Claude
node pr-triage/pr-triage.mjs owner/repo --label       # also label each PR (writes to GitHub)
```

| Option | |
| --- | --- |
| `--out <file.md>` | Where to write the report (default `pr-triage-report.md`). It must be a `.md` file inside the current folder, and it will only overwrite an earlier report. |
| `--limit <n>` | How many open PRs to read, 1 to 100 (default 30). |
| `--no-ai` | Signals only. |
| `--label` | Adds `triage: real` or `triage: likely-slop` to each PR and removes the other. If either label is missing from the repo, it is created; existing labels are never edited. If Claude fails, nothing is labelled. |
| `--demo` / `--live` | The sample PRs, with the recorded reply or a live one. |

`npm test` runs the test suite (`node:test`, no dependencies).

## Security

PR Triage feeds text that anyone can write into an AI model. It treats that text as hostile:

- **The model gets no tools.** Claude Code runs with `--tools ""`, `--safe-mode`, an empty MCP config and no session saved, in an empty temporary folder. It can't run commands, read or write files, reach the network, or load your plugins, hooks or settings. It only reads the prompt and answers. It is launched without a shell, so those flags arrive intact.
- **PR text is fenced and can't take over.** Each PR gets its own Claude call, so one PR's text can't sway the verdict on another. Each PR is wrapped in tags with a random nonce, and any copy of that tag inside the PR is removed. Bidi overrides and invisible Unicode tag characters are shown to the model as visible markers, and they also count as a slop signal. Text addressed to AI reviewers ("ignore previous instructions", "note for AI reviewers: …") is detected even after spacing and invisible-character tricks. Any PR containing it is marked likely slop, whatever its other signals or Claude say.
- **The answer is validated.** Claude must return JSON for PRs it was actually shown, using known verdicts. Reasons are limited in number and length. A PR answered twice gets neither answer.
- **The output is inert.** Every title, login and reason is escaped before it goes into the report. That means no HTML, links or images, no @mentions, no `#123` cross-references, no table breakouts, and no terminal escape codes or bidi tricks. Code quoted from a PR appears only inside code spans.
- **GitHub is read through argument arrays.** `gh` is never run through a shell. The repository must match `owner/repo`, and PR numbers must be plain integers. PR code is parsed as text and never checked out or run.
- **The skill is pinned.** `code-review` is fetched at a fixed commit and checked against the SHA-256 of the version we reviewed. If it changes upstream, PR Triage refuses to use it until someone reviews the new version and updates [`pr-triage/skills.mjs`](pr-triage/skills.mjs).
- **`--out` can't escape.** The report can only be written as a `.md` file inside the current folder, never through a symlink, and never over an existing file unless that file is an earlier PR Triage report.
- **It fails safe.** If Claude's reply is malformed, or Claude can't run, the report says so and falls back to the signals. With `--label`, nothing is labelled in that case. A labelling error never loses the report.
- **Labels are judgements, not facts.** A `triage: likely-slop` label is visible to the PR's author. Read the report before you use `--label` on a repository where that matters.

## Credits

| Project | What it does here | License |
| --- | --- | --- |
| [mattpocock/skills](https://github.com/mattpocock/skills) (`code-review`) | The review rules Claude applies | MIT |
| [Claude Code](https://claude.com/claude-code) | Runs the model, headless and with no tools | Anthropic's terms |
| [GitHub CLI](https://cli.github.com) | Reads PRs and, with `--label`, labels them | MIT |

PR Triage's own code is [MIT](LICENSE). The README images and video are made by [`docs/make-media.mjs`](docs/make-media.mjs) from a real `--demo` run, using headless Chrome and ffmpeg.

---

Built for a *Today in AI* episode as a working example. It is a demo, not a maintained product, so issues and pull requests may not get answers.
