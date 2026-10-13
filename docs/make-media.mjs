// Regenerates the README's images and demo video from a real `pr-triage --demo`
// run. From the repo root:   node docs/make-media.mjs
// Needs Chrome, Chromium or Edge (headless screenshots) and ffmpeg. No npm
// packages: the browser is driven through its own command line.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = resolve(import.meta.dirname, '..');
const media = join(root, 'docs', 'media');
const tmp = join(media, '.frames');
const ffmpeg = process.env.FFMPEG || 'ffmpeg';
const CHROME = process.env.CHROME || [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
].find(existsSync);
if (!CHROME) throw new Error('no Chrome, Chromium or Edge found; set CHROME to its path');
rmSync(tmp, { recursive: true, force: true });
mkdirSync(tmp, { recursive: true });

// --- headless browser, one process per page ---------------------------------

let profile = 0;
function chrome(args) {
  const dir = join(tmp, `profile-${profile += 1}`);
  return new Promise((ok, fail) => {
    const p = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run', '--hide-scrollbars',
      `--user-data-dir=${dir}`, ...args], { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.on('error', fail);
    p.on('close', (code) => (code === 0 ? ok(out) : fail(new Error(`chrome exited ${code}`))));
  });
}

// Screenshots an HTML page at 2x. Without a height, the page is measured first.
async function shot(html, out, width, height) {
  const file = join(tmp, `${out.replace(/\//g, '_')}.html`);
  writeFileSync(file, `${html}<script>document.body.dataset.h = document.documentElement.scrollHeight</script>`);
  const url = pathToFileURL(file).href;
  const h = height ?? Number((await chrome(['--dump-dom', url])).match(/data-h="(\d+)"/)?.[1] ?? 800);
  await chrome(['--force-device-scale-factor=2', `--window-size=${width},${h}`, `--screenshot=${join(out.includes('/') ? root : tmp, out)}`, url]);
  return h;
}

// --- just enough Markdown for PR Triage's own report --------------------------

const html = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
function inline(s) {
  return s.split(/(`[^`]+`)/).map((part) => {
    if (/^`[^`]+`$/.test(part)) return `<code>${html(part.slice(1, -1))}</code>`;
    const kept = [];
    const t = part.replace(/\\([\\`*_{}[\]<>|~&#+!-])/g, (_, c) => `\u0000${kept.push(c) - 1}\u0000`);
    return html(t)
      .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
      .replace(/\*(.+?)\*/g, '<i>$1</i>')
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a>$1</a>')
      .replace(/&lt;\/?sub&gt;/g, '')
      .replace(/\u0000(\d+)\u0000/g, (_, i) => html(kept[i]));
  }).join('');
}
const cells = (l) => l.split(/(?<!\\)\|/).slice(1, -1).map((c) => c.trim());

function reportHtml(md) {
  const out = [];
  let list = false;
  let table = null;
  const close = () => {
    if (list) { out.push('</ul>'); list = false; }
    if (table) { out.push(`<table><tr>${table[0].map((c) => `<th>${inline(c)}</th>`).join('')}</tr>${table.slice(2).map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`).join('')}</table>`); table = null; }
  };
  for (const l of md.split('\n')) {
    if (l.startsWith('|')) { (table ??= []).push(cells(l)); continue; }
    if (l.startsWith('- ')) { if (!list) { close(); out.push('<ul>'); list = true; } out.push(`<li>${inline(l.slice(2))}</li>`); continue; }
    close();
    if (l.startsWith('# ')) out.push(`<h1>${inline(l.slice(2))}</h1>`);
    else if (l.startsWith('## ')) out.push(`<h2>${inline(l.slice(3))}</h2>`);
    else if (l.startsWith('### ')) out.push(`<h3>${inline(l.slice(4))}</h3>`);
    else if (l.startsWith('> ')) out.push(`<blockquote>${inline(l.slice(2))}</blockquote>`);
    else if (l.startsWith('<sub>')) out.push(`<p class="sub">${inline(l)}</p>`);
    else if (l === '---') out.push('<hr>');
    else if (l.trim()) out.push(`<p>${inline(l)}</p>`);
  }
  close();
  return `<!doctype html><meta charset="utf-8"><style>
    body { margin: 0; padding: 28px; background: #f6f8fa; font: 15px/1.55 "Segoe UI", system-ui, sans-serif; color: #1f2328; width: 1040px; }
    .card { background: #fff; border: 1px solid #d0d7de; border-radius: 8px; }
    .head { padding: 10px 16px; background: #f6f8fa; border-bottom: 1px solid #d0d7de; border-radius: 8px 8px 0 0; color: #59636e; font: 13px "Cascadia Mono", Consolas, monospace; }
    .body { padding: 4px 24px 16px; }
    h1 { font-size: 26px; margin: 16px 0 8px; padding-bottom: 6px; border-bottom: 1px solid #d8dee4; }
    h2 { font-size: 21px; margin: 26px 0 6px; padding-bottom: 5px; border-bottom: 1px solid #d8dee4; } h3 { font-size: 16px; margin: 20px 0 4px; }
    ul { margin: 4px 0 10px; padding-left: 22px; } li { margin: 3px 0; } p { margin: 6px 0; }
    table { border-collapse: collapse; margin: 10px 0 4px; font-size: 13.5px; } th, td { border: 1px solid #d0d7de; padding: 6px 10px; text-align: left; vertical-align: top; }
    th { background: #f6f8fa; } tr:nth-child(odd) td { background: #fbfcfd; }
    code { font: 12.5px "Cascadia Mono", Consolas, monospace; background: #eff1f3; padding: 2px 5px; border-radius: 5px; }
    blockquote { margin: 8px 0; padding: 4px 14px; border-left: 4px solid #d0d7de; color: #59636e; }
    a { color: #0969da; } hr { border: 0; border-top: 1px solid #d0d7de; margin: 16px 0 8px; } .sub { font-size: 12px; color: #59636e; }
  </style><div class="card"><div class="head">pr-triage-report.md</div><div class="body">${out.join('\n')}</div></div>`;
}

// --- a terminal window -------------------------------------------------------

function terminalHtml(lines, { cursor = false } = {}) {
  const row = (l) => {
    const cls = l.startsWith('$') ? 'cmd' : l.startsWith('pr-triage:') ? 'err' : /✅/.test(l) ? 'real' : /🗑️/.test(l) ? 'slop' : l.startsWith('#') || l.startsWith('**') ? 'head' : '';
    return `<div class="${cls}">${html(l) || '&nbsp;'}</div>`;
  };
  return `<!doctype html><meta charset="utf-8"><style>
    body { margin: 0; width: 1280px; height: 720px; background: #1b1914; display: flex; align-items: center; justify-content: center; }
    .win { width: 1200px; height: 652px; background: #0f0e0b; border-radius: 12px; box-shadow: 0 20px 60px #0008; border: 1px solid #332d22; overflow: hidden; }
    .bar { height: 38px; background: #24211b; display: flex; align-items: center; gap: 8px; padding: 0 16px; color: #8d8473; font: 13px "Segoe UI", sans-serif; }
    .bar i { width: 12px; height: 12px; border-radius: 50%; background: #4a4337; display: inline-block; } .bar span { margin-left: 12px; }
    .term { padding: 18px 22px; font: 16px/1.6 "Cascadia Mono", Consolas, monospace; color: #d9d2c3; }
    .term div { white-space: pre; overflow: hidden; text-overflow: ellipsis; }
    .cmd { color: #f4efe4; } .cmd::first-letter { color: #f2b84b; } .err { color: #8d8473; }
    .head { color: #f2b84b; font-weight: 700; } .real { color: #7ddc9a; } .slop { color: #f39a8e; }
    .cursor { display: inline-block; width: 10px; height: 19px; background: #f2b84b; vertical-align: -3px; }
  </style><div class="win"><div class="bar"><i></i><i></i><i></i><span>tiny-invoice — pr-triage</span></div><div class="term">${
    lines.map(row).join('')}${cursor ? '<span class="cursor"></span>' : ''}</div></div>`;
}

// --- run the real demo, then render ---------------------------------------------

const run = spawnSync(process.execPath, ['pr-triage/pr-triage.mjs', '--demo', '--out', 'docs/media/.frames/report.md'],
  { cwd: root, encoding: 'utf8' });
if (run.status !== 0) throw new Error(`pr-triage --demo failed: ${run.stderr}`);
// Shown as a plain run prints it (this run writes its copy of the report elsewhere).
const stderr = run.stderr.trim().split('\n').map((l) => l.replace('docs/media/.frames/report.md', 'pr-triage-report.md'));
const stdout = run.stdout.split('\n');
const report = readFileSync(join(tmp, 'report.md'), 'utf8');
const head = stdout.slice(0, 13).map((l) => l.replace(/<\/?sub>/g, ''));

const typed = ['', 'pr-tri', 'pr-triage --de', 'pr-triage --demo'];
const frames = [
  ...typed.map((t) => ({ lines: [`$ ${t}`], cursor: true, secs: 0.45 })),
  { lines: ['$ pr-triage --demo', stderr[0]], secs: 0.9 },
  { lines: ['$ pr-triage --demo', ...stderr, '', ...head], secs: 4.5 },
];

const jobs = [
  shot(readFileSync(join(root, 'docs', 'src', 'banner.html'), 'utf8'), 'docs/media/banner.png', 1280, 420),
  shot(reportHtml(report), 'docs/media/report.png', 1096),
  shot(terminalHtml(frames.at(-1).lines), 'docs/media/terminal.png', 1280, 720),
  ...frames.map((f, i) => shot(terminalHtml(f.lines, f), `frame-${i}.png`, 1280, 720)),
];
const [, reportHeight] = await Promise.all(jobs);

// --- the video: typing, the output, then a scroll through the report ----------------

const ff = (args, what) => {
  const r = spawnSync(ffmpeg, ['-y', '-loglevel', 'error', ...args], { cwd: tmp, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`ffmpeg failed making ${what}: ${r.stderr}`);
};
const H264 = ['-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-r', '30', '-crf', '20'];
const list = frames.map((f, i) => `file 'frame-${i}.png'\nduration ${f.secs}`).join('\n') + `\nfile 'frame-${frames.length - 1}.png'\n`;
writeFileSync(join(tmp, 'frames.txt'), list);
ff(['-f', 'concat', '-i', 'frames.txt', '-vf', 'scale=1280:720,fps=30', ...H264, 'a.mp4'], 'the terminal clip');

// The report image is 2x; at 1280 wide it scrolls from the top to the bottom.
const scrollable = Math.max(0, Math.round((reportHeight * 1280) / 1096) - 720);
const scrollSecs = 12;
ff(['-loop', '1', '-t', String(scrollSecs + 2), '-i', join(media, 'report.png'), '-vf',
  `scale=1280:-2,crop=1280:720:0:'min(${scrollable},max(0,(t-1)*${(scrollable / scrollSecs).toFixed(2)}))',fps=30`, ...H264, 'b.mp4'], 'the report scroll');
ff(['-loop', '1', '-t', '2.5', '-i', join(media, 'banner.png'), '-vf',
  'scale=1280:-2,pad=1280:720:0:(oh-ih)/2:color=0x15130f,fps=30', ...H264, 'c.mp4'], 'the end card');
writeFileSync(join(tmp, 'parts.txt'), "file 'a.mp4'\nfile 'b.mp4'\nfile 'c.mp4'\n");
ff(['-f', 'concat', '-i', 'parts.txt', '-c', 'copy', '-movflags', '+faststart', join(media, 'demo.mp4')], 'demo.mp4');
// The README GIF is the terminal part only, to stay small; demo.mp4 has the full scroll.
ff(['-i', 'a.mp4', '-vf',
  'fps=10,scale=760:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=96:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle',
  join(media, 'demo.gif')], 'demo.gif');

rmSync(tmp, { recursive: true, force: true });
console.log('wrote docs/media/banner.png, report.png, terminal.png, demo.mp4, demo.gif');
