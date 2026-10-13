// Reads a unified diff (as `gh pr diff` prints it) into files with their added
// and removed lines. The diff is only ever parsed as text: nothing in it runs.

export function parseDiff(text) {
  const files = [];
  let file = null;
  let inHunk = false;
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const head = line.match(/^diff --git a\/(.*) b\/(.*)$/);
    if (head) {
      file = { path: head[2], oldPath: head[1], status: 'modified', added: [], removed: [] };
      files.push(file);
      inHunk = false;
      continue;
    }
    if (!file) continue;
    if (!inHunk) {
      if (line.startsWith('new file mode')) file.status = 'added';
      else if (line.startsWith('deleted file mode')) file.status = 'deleted';
      else if (line.startsWith('rename from ')) { file.status = 'renamed'; file.oldPath = line.slice(12); }
      else if (line.startsWith('rename to ')) file.path = line.slice(10);
      else if (line.startsWith('+++ ') && line !== '+++ /dev/null') file.path = line.slice(4).replace(/^b\//, '');
      else if (line.startsWith('@@')) inHunk = true;
      continue;
    }
    if (line.startsWith('@@')) continue;
    if (line.startsWith('+')) file.added.push(line.slice(1));
    else if (line.startsWith('-')) file.removed.push(line.slice(1));
  }
  return files;
}

const DEPS = /(^|\/)(package(-lock)?\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|requirements[^/]*\.txt|Pipfile(\.lock)?|poetry\.lock|pyproject\.toml|uv\.lock|go\.(mod|sum)|Cargo\.(toml|lock)|Gemfile(\.lock)?|composer\.(json|lock)|pom\.xml|build\.gradle(\.kts)?|gradle\.lockfile|packages\.lock\.json|[^/]+\.csproj)$/i;
const TEST = /(^|\/)(tests?|__tests__|spec|specs|e2e)\/|\.(test|spec|e2e)\.[a-z]+$|_test\.(go|py|rb|exs?)$|(^|\/)test_[^/]+\.py$|Tests?\.(cs|java|kt|swift)$/i;
const DOCS = /\.(md|mdx|markdown|rst|txt|adoc)$|(^|\/)(docs?|documentation)\/|(^|\/)(LICENSE|CHANGELOG|AUTHORS|CONTRIBUTORS)[^/]*$/i;
const CODE = /\.(m?[jt]sx?|cjs|cts|py|go|rb|rs|java|kt|kts|scala|c|cc|cpp|cxx|h|hpp|cs|fs|php|swift|m|mm|sh|bash|ps1|lua|dart|ex|exs|erl|clj|vue|svelte|sql|r|jl|zig|nim|hs|ml)$/i;

// What a changed file is, for the signals: code, test, docs, deps or config.
export function kindOf(path) {
  if (DEPS.test(path)) return 'deps';
  if (TEST.test(path)) return 'test';
  if (DOCS.test(path)) return 'docs';
  if (CODE.test(path)) return 'code';
  return 'config';
}

// A line's logic with the cosmetic parts removed: string contents, comments
// and all whitespace. Two lines with the same skeleton differ only cosmetically.
// The string pattern must not let a backslash match two ways ([^\\] below, not
// "."): that ambiguity backtracks exponentially on a run of backslashes.
function skeleton(line) {
  return line
    .replace(/(["'`])(?:\\.|(?!\1)[^\\])*\1/g, '""')    // string contents
    .replace(/\/\/.*$|\/\*.*?\*\/|^\s*#.*$|^\s*\*.*$|^\s*<!--.*-->\s*$/g, '')   // comments
    .replace(/\s+/g, '');
}

// Lines in a code file whose logic changed (not just spelling in comments or
// strings, or indentation). Pairs each removed line with the added line at the
// same position so the report can show "before" and "after".
// Signals look at most this many changed lines per file: enough to judge, and
// it keeps the work linear however large a hostile diff is.
const MAX_LINES = 5000;
const count = (keys) => {
  const m = new Map();
  for (const k of keys) m.set(k, (m.get(k) ?? 0) + 1);
  return m;
};

export function logicChanges(file) {
  const before = file.removed.slice(0, MAX_LINES).map((l) => ({ line: l, key: skeleton(l) })).filter((x) => x.key);
  const after = file.added.slice(0, MAX_LINES).map((l) => ({ line: l, key: skeleton(l) })).filter((x) => x.key);
  const unmatched = (side, other) => {
    const left = count(other.map((x) => x.key));
    return side.filter((x) => {
      const n = left.get(x.key) ?? 0;
      if (n > 0) { left.set(x.key, n - 1); return false; }
      return true;
    });
  };
  const gone = unmatched(before, after);
  const fresh = unmatched(after, before);
  const out = [];
  for (let i = 0; i < Math.max(gone.length, fresh.length); i += 1) {
    out.push({ before: gone[i]?.line.trim() ?? '', after: fresh[i]?.line.trim() ?? '' });
  }
  return out;
}

// Changed lines whose only difference from a line on the other side is whitespace.
export function whitespaceOnly(file) {
  const norm = (l) => l.replace(/\s+/g, '');
  // For each whitespace-free form, how many added lines have each exact spelling.
  const added = new Map();
  for (const l of file.added.slice(0, MAX_LINES)) {
    const k = norm(l);
    if (!k) continue;
    if (!added.has(k)) added.set(k, new Map());
    added.get(k).set(l, (added.get(k).get(l) ?? 0) + 1);
  }
  let n = 0;
  for (const r of file.removed.slice(0, MAX_LINES)) {
    const spellings = added.get(norm(r));
    if (!spellings) continue;
    for (const [l, c] of spellings) {
      if (l === r) continue;
      if (c === 1) spellings.delete(l); else spellings.set(l, c - 1);
      n += 2;                     // the removed line and its re-spaced twin
      break;
    }
  }
  return n;
}
