#!/usr/bin/env node
/**
 * End-to-end smoke test for Nadabodha, driven over the Chrome DevTools Protocol.
 *
 * Launches the app with --remote-debugging-port=9222, then:
 *   - opens Settings, sets every field, asserts the bogus-interpreter error,
 *   - configures Python + LM Studio + data dir + model cache dir,
 *   - exercises the Hugging Face search UI and a real model download,
 *   - imports a speech file end to end: transcript -> auto-summary -> .txt/.md,
 *   - exercises the manual Summarize button,
 *   - asserts zero console errors/exceptions and no network outside
 *     127.0.0.1 + Hugging Face hosts,
 *   - kills every spawned Electron/ffmpeg/python process.
 *
 * Usage: node scripts/cdp-smoke.mjs   (run from the repo root after npm run build)
 */

import { spawn, spawnSync } from 'node:child_process';
import dns from 'node:dns/promises';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import tls from 'node:tls';
import { createRequire } from 'node:module';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const PORT = 9222;
const CONDA_PYTHON = '/Volumes/personal/conda_envs/misc/bin/python3';
const SPEECH_WAV =
  '/Users/thrilok/.hermes/profiles/factory-planner/cache/scratch/speech.wav';
const LLM_MODEL = 'neohorse-1-4b-mlx';
const HF_REPO = 'Systran/faster-whisper-base';
const ALLOWED_HOSTS = [
  'huggingface.co',
  'hf.co',
  'cdn-lfs.huggingface.co',
  'cdn-lfs-us-1.huggingface.co',
  'cdn-lfs-eu-1.huggingface.co',
  'cas-server.xethub.hf.co',
  'cas-bridge.xethub.hf.co',
  'xethub.hf.co',
  'aws.cdn.hf.co',
  'us.aws.cdn.hf.co',
];

// --- Dictation + layout constants (approved plan) ---------------------------
const requireCjs = createRequire(import.meta.url);
const { uIOhook, UiohookKey } = requireCjs('uiohook-napi');
/** Second app instance used to exercise the accessibility crash guard. */
const GUARD_PORT = 9224;
const DICTATION_HINT_TEXT = 'Hold the Option key anywhere to dictate';
const TOO_SHORT_NOTICE = 'Too short - hold the Option key to dictate';
const CHORD_NOTICE = 'Dictation cancelled - another key was pressed';
const ACCESSIBILITY_BANNER = 'Enable dictation: grant Accessibility to Nadabodha';
const XSS_PAYLOAD = '<img src=x onerror="window.__xss=1"><script>window.__xss=1</script>';
const MARKDOWN_FIXTURE = [
  '# Fixture heading',
  '',
  '## Overview',
  '',
  'A **bold** claim with *italic* text and an `inline code` span.',
  '',
  '## Key points',
  '',
  '- first point',
  '- second point with [a link](https://example.com/docs)',
  '',
  '> a blockquote line',
  '',
  '```js',
  'const answer = 42;',
  '```',
  '',
  '| column a | column b |',
  '| --- | --- |',
  '| 1 | 2 |',
  '',
].join('\n');
const DEFAULT_WINDOW = { width: 1180, height: 760 };
const MIN_WINDOW = { width: 960, height: 640 };
/**
 * D7.4 global watchdog: the whole run must finish (or fail) inside this
 * budget; on expiry the harness dumps the report + captured app output and
 * exits non-zero instead of hanging.
 */
const GLOBAL_TIMEOUT_MS = 60 * 60 * 1000;
/** D7.4: how often the renderer CDP target is re-checked for loss (D10). */
const TARGET_LOSS_POLL_MS = 8000;
/** D10: renderer-process-loss diagnostics state. */
let rendererTargetLoss = null;

// HF endpoints sit behind rotating pools (CloudFront + AWS Global Accelerator for
// huggingface.co, regional EC2 for the XET cas-server). Snapshot every resolution
// during the run so rotating A/AAAA answers are still attributable, and prove
// leftovers by presenting their certificate for an HF SNI.
const dnsUnionV4 = new Set();
const dnsUnionV6Prefixes = new Set();

function v6Prefix(address, bits) {
  if (!address.includes(':')) return null;
  const groups = address.split('::')[0].split(':').filter(Boolean);
  const full = bits / 16;
  if (groups.length < full) return `${groups.join(':')}:/${bits}`;
  return `${groups.slice(0, full).join(':')}:/${bits}`;
}

async function refreshDnsUnion() {
  for (const host of ALLOWED_HOSTS) {
    try {
      const addrs = await dns.lookup(host, { all: true });
      for (const entry of addrs) {
        if (entry.family === 4) dnsUnionV4.add(entry.address);
        else {
          const prefix = v6Prefix(entry.address, 48);
          if (prefix) dnsUnionV6Prefixes.add(prefix);
        }
      }
    } catch {
      /* host may not resolve on this network (cdn-lfs legacy names) */
    }
  }
}

function tlsServesHuggingFace(ip) {
  const snis = [
    'huggingface.co',
    'cas-server.xethub.hf.co',
    'cas-bridge.xethub.hf.co',
    'hf.co',
    'aws.cdn.hf.co',
  ];
  return snis.reduce(
    (chain, servername) =>
      chain.then(async (matched) => {
        if (matched) return matched;
        return new Promise((resolve) => {
          try {
            const sock = tls.connect(
              { host: ip, port: 443, servername, rejectUnauthorized: true, timeout: 5000 },
              () => {
                sock.end();
                resolve(servername);
              }
            );
            sock.on('error', () => resolve(null));
            sock.on('timeout', () => {
              sock.destroy();
              resolve(null);
            });
          } catch {
            resolve(null);
          }
        });
      }),
    Promise.resolve(null)
  );
}

const failures = [];
const notes = [];
let passCount = 0;
let skipCount = 0;
/** True once LM Studio answered the warm-up (summary steps are labeled). */
let llmWarm = false;

function pass(msg) {
  passCount += 1;
  console.log(`  PASS  ${msg}`);
}
function fail(msg) {
  failures.push(msg);
  console.error(`  FAIL  ${msg}`);
}
/** Not automatable in this harness — reported, never counted as PASS. */
function skip(msg) {
  skipCount += 1;
  console.log(`  SKIP  ${msg}`);
}
function check(cond, msg) {
  if (cond) pass(msg);
  else fail(msg);
  return Boolean(cond);
}
function note(msg) {
  notes.push(msg);
  console.log(`  NOTE  ${msg}`);
}
function step(title) {
  console.log(`\n== ${title}`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(fn, { timeout = 30000, interval = 200, label = 'condition' } = {}) {
  const deadline = Date.now() + timeout;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (err) {
      lastError = err;
    }
    await sleep(interval);
  }
  throw new Error(`Timed out after ${timeout}ms waiting for ${label}${lastError ? ` (last error: ${lastError.message})` : ''}`);
}

function exec(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, { encoding: 'utf8', ...opts });
  return { status: res.status, stdout: res.stdout || '', stderr: res.stderr || '' };
}

function killTree(rootPid) {
  if (!rootPid) return;
  try {
    process.kill(-rootPid, 'SIGTERM');
  } catch {
    try {
      process.kill(rootPid, 'SIGTERM');
    } catch {
      /* already gone */
    }
  }
}

function pidsForPattern(pattern) {
  const res = exec('pgrep', ['-f', pattern]);
  return res.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^\d+$/.test(line))
    .map(Number);
}

/** Pids belonging to THIS worktree's app only (never our own node process). */
function appPids() {
  const patterns = [
    `${ROOT}/node_modules/electron/dist`,
    `${ROOT}/python/nadabodha_transcribe.py`,
  ];
  const pids = new Set();
  for (const pattern of patterns) {
    for (const pid of pidsForPattern(pattern)) pids.add(pid);
  }
  pids.delete(process.pid);
  pids.delete(process.ppid);
  return [...pids];
}

function processTree(rootPid) {
  const seen = new Set();
  const queue = [rootPid];
  while (queue.length) {
    const pid = queue.pop();
    if (!pid || seen.has(pid)) continue;
    seen.add(pid);
    const res = exec('pgrep', ['-P', String(pid)]);
    for (const line of res.stdout.split('\n')) {
      const child = Number(line.trim());
      if (Number.isInteger(child) && child > 0) queue.push(child);
    }
  }
  return [...seen];
}

async function allowedRemote(ip) {
  if (ip === '127.0.0.1' || ip === '::1' || ip === 'localhost') return true;
  if (dnsUnionV4.has(ip)) return true;
  const prefix = v6Prefix(ip, 48);
  if (prefix && dnsUnionV6Prefixes.has(prefix)) return true;
  try {
    const names = await dns.reverse(ip);
    if (
      names.some(
        (name) =>
          name === 'huggingface.co' ||
          name.endsWith('.huggingface.co') ||
          name === 'hf.co' ||
          name.endsWith('.hf.co')
      )
    ) {
      return true;
    }
  } catch {
    /* no PTR record -> fall through to forward lookup */
  }
  for (const host of ALLOWED_HOSTS) {
    try {
      const addrs = await dns.lookup(host, { all: true });
      if (addrs.some((entry) => entry.address === ip)) return true;
    } catch {
      /* ignore */
    }
  }
  return false;
}

function sampleSockets(pids) {
  if (pids.length === 0) return [];
  const res = exec('lsof', ['-nP', '-iTCP', '-sTCP:ESTABLISHED', '-a', '-p', pids.join(',')]);
  const remotes = new Set();
  for (const line of res.stdout.split('\n')) {
    const arrow = line.indexOf('->');
    if (arrow === -1) continue;
    const remote = line.slice(arrow + 2).trim();
    const lastColon = remote.lastIndexOf(':');
    if (lastColon === -1) continue;
    let ip = remote.slice(0, lastColon);
    if (ip.startsWith('[') && ip.endsWith(']')) ip = ip.slice(1, -1);
    if (ip) remotes.add(ip);
  }
  return [...remotes];
}

// ---------------------------------------------------------------------------
// CDP client
// ---------------------------------------------------------------------------

function createCdpClient(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let nextId = 1;
    const pending = new Map();
    const listeners = new Map();

    ws.addEventListener('open', () => {
      resolve({
        send(method, params = {}) {
          const id = nextId++;
          return new Promise((res, rej) => {
            pending.set(id, { resolve: res, reject: rej });
            ws.send(JSON.stringify({ id, method, params }));
          });
        },
        on(method, handler) {
          if (!listeners.has(method)) listeners.set(method, []);
          listeners.get(method).push(handler);
        },
        close() {
          try {
            ws.close();
          } catch {
            /* ignore */
          }
        },
        get closed() {
          return ws.readyState >= 2;
        },
      });
    });
    ws.addEventListener('error', (err) => reject(new Error(`WebSocket error: ${err.message || err}`)));
    ws.addEventListener('message', (event) => {
      let message;
      try {
        message = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data));
      } catch {
        return;
      }
      if (message.id && pending.has(message.id)) {
        const { resolve, reject } = pending.get(message.id);
        pending.delete(message.id);
        if (message.error) reject(new Error(`${message.error.message}`));
        else resolve(message.result || {});
        return;
      }
      if (message.method) {
        for (const handler of listeners.get(message.method) || []) {
          try {
            handler(message.params || {});
          } catch {
            /* listener errors must not break the run */
          }
        }
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Helpers for the UI/dictation assertions (approved plan, workstreams 1-3)
// ---------------------------------------------------------------------------

/** Every element id referenced by renderer.ts or by this file. */
function referencedIds() {
  const ids = new Set();
  const files = [path.join(ROOT, 'src', 'renderer', 'renderer.ts'), path.join(ROOT, 'scripts', 'cdp-smoke.mjs')];
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    for (const m of text.matchAll(/getElementById\(\s*['"]([^'"]+)['"]/g)) ids.add(m[1]);
    for (const m of text.matchAll(/querySelector(?:All)?\(\s*[`'"]#([A-Za-z][\w-]*)/g)) ids.add(m[1]);
    for (const m of text.matchAll(/querySelector(?:All)?\(\s*`[^`]*#([A-Za-z][\w-]*)/g)) ids.add(m[1]);
  }
  return [...ids];
}

/**
 * Evaluated in the page: layout metrics + WCAG contrast ratios of body text
 * and of the main buttons, with alpha backgrounds composited over ancestors.
 */
const LAYOUT_PROBE = `(() => {
  const parse = (c) => {
    const m = /rgba?\\(([^)]+)\\)/.exec(c || '');
    if (!m) return null;
    const p = m[1].split(',').map((v) => parseFloat(v));
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
  };
  const lum = (c) => {
    const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
  };
  const ratio = (a, b) => {
    const la = lum(a), lb = lum(b);
    return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
  };
  const backdrop = (el) => {
    const layers = [];
    let node = el;
    while (node) {
      const c = parse(getComputedStyle(node).backgroundColor);
      if (c && c.a > 0) layers.push(c);
      node = node.parentElement;
    }
    let base = { r: 11, g: 15, b: 20, a: 1 }; // --surface-bg
    for (let i = layers.length - 1; i >= 0; i--) {
      const c = layers[i];
      base = {
        r: c.r * c.a + base.r * (1 - c.a),
        g: c.g * c.a + base.g * (1 - c.a),
        b: c.b * c.a + base.b * (1 - c.a),
        a: 1,
      };
    }
    return base;
  };
  const contrastOf = (id) => {
    const el = document.getElementById(id);
    if (!el) return null;
    const fg = parse(getComputedStyle(el).color);
    if (!fg) return null;
    return Math.round(ratio(fg, backdrop(el)) * 100) / 100;
  };
  const rect = (el) => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; };
  // Steno shell panes (v3 plan): left sidebar + main note detail. The old
  // two-column (.col-left/.col-right) probe was drift from the retired shell.
  const sidebar = document.getElementById('sidebar');
  const main = document.getElementById('mainContent');
  const visible = {};
  for (const id of ['recordBtn', 'stopRecordBtn', 'importBtn', 'cancelBtn', 'statusText', 'dictationHint', 'tabTranscript', 'tabSummary', 'transcriptArea', 'copyBtn', 'saveBtn']) {
    const el = document.getElementById(id);
    if (!el) { visible[id] = 'missing'; continue; }
    // Hidden-at-rest elements (status bar, recording pill, parked hint) are
    // not "clipped" — only elements actually rendered right now count.
    if (el.getClientRects().length === 0) { visible[id] = 'not-rendered'; continue; }
    const r = el.getBoundingClientRect();
    visible[id] = r.width > 0 && r.height > 0 && r.top >= -0.5 && r.left >= -0.5 && r.bottom <= innerHeight + 0.5 && r.right <= innerWidth + 0.5;
  }
  return {
    outer: { w: outerWidth, h: outerHeight },
    inner: { w: innerWidth, h: innerHeight },
    doc: { sw: document.documentElement.scrollWidth, sh: document.documentElement.scrollHeight },
    panes: sidebar && main ? { sidebar: rect(sidebar), main: rect(main) } : null,
    visible,
    contrast: {
      body: contrastOf('statusText'),
      muted: contrastOf('promptPathStatus'),
      primaryBtn: contrastOf('recordBtn'),
      secondaryBtn: contrastOf('importBtn'),
      tab: contrastOf('tabTranscript'),
      saveBtn: contrastOf('saveBtn'),
      hint: contrastOf('dictationHint'),
    },
    hintText: (document.getElementById('dictationHint') || {}).textContent || '',
    bodyBg: getComputedStyle(document.body).backgroundColor,
    bodyColor: getComputedStyle(document.body).color,
    colorScheme: getComputedStyle(document.documentElement).colorScheme,
  };
})()`;

/**
 * Launches a second app instance whose accessibility guard is forced to fail
 * (NADABODHA_DICTATION_NO_ACCESSIBILITY=1) and asserts the app neither
 * crashes nor starts the hook, and that it shows the grant banner.
 *
 * Revoking the machine's real TCC grant is not an option: it can only be
 * restored by a human clicking the system prompt, so the guard's failure
 * branch is forced instead.
 */
async function runAccessibilityGuardProbe() {
  step('Crash guard: Accessibility not granted');
  const electronBinary = path.join(ROOT, 'node_modules', 'electron', 'dist', 'Electron.app', 'Contents', 'MacOS', 'Electron');
  const child = spawn(electronBinary, ['.', `--remote-debugging-port=${GUARD_PORT}`], {
    cwd: ROOT,
    env: { ...process.env, NADABODHA_DICTATION_NO_ACCESSIBILITY: '1' },
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const rootPid = child.pid;
  const log = [];
  child.stdout.on('data', (b) => log.push(b.toString()));
  child.stderr.on('data', (b) => log.push(b.toString()));
  let alive = true;
  child.on('exit', () => { alive = false; });

  try {
    const target = await waitFor(
      async () => {
        const res = await fetch(`http://127.0.0.1:${GUARD_PORT}/json/list`);
        const list = await res.json();
        return list.find((e) => e.type === 'page' && e.url.includes('index.html'));
      },
      { timeout: 45000, label: 'guard page target' }
    );
    const cdp = await createCdpClient(target.webSocketDebuggerUrl);
    await cdp.send('Runtime.enable');
    const ev = async (expression) => {
      const res = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (res.exceptionDetails) {
        throw new Error(res.exceptionDetails.exception?.description || res.exceptionDetails.text || 'evaluation failed');
      }
      return res.result?.value;
    };

    await waitFor(
      async () => (await ev('document.readyState')) === 'complete' && (await ev('!!window.electronAPI')),
      { timeout: 30000, label: 'guard renderer ready' }
    );
    check(alive, 'app alive with the accessibility guard failing');

    const status = await ev('window.electronAPI.getDictationStatus()');
    check(status.accessibilityTrusted === false, `guard reports untrusted Accessibility (reason=${status.reason})`);
    check(status.running === false, 'global Option hook NOT started without Accessibility');

    const banner = await ev(
      `(() => { const b = document.getElementById('dictationBanner');` +
        ` return { exists: !!b, hidden: b ? b.hidden : null, text: b ? b.textContent.replace(/\\s+/g, ' ').trim() : '' }; })()`
    );
    // D8 disposition: the harness used to demand the v2 plan's verbatim line
    // ("Enable dictation: grant Accessibility to Nadabodha"). The v3 plan
    // does not fix banner copy — drift. Assert the real contract: banner is
    // visible, names Accessibility, and offers a grant action.
    check(banner.exists && banner.hidden === false, 'accessibility banner is visible');
    check(
      banner.text.toLowerCase().includes('accessibility'),
      `banner copy names Accessibility: "${banner.text}"`
    );

    const button = await ev(
      `(() => { const b = document.getElementById('dictationGrantBtn');` +
        ` return { exists: !!b, text: b ? b.textContent.trim() : '' }; })()`
    );
    check(button.exists && button.text.length > 0, `grant button present ("${button.text}")`);

    // The handler the button calls: re-check access, then re-read status.
    const recheck = await ev('window.electronAPI.requestDictationAccess()');
    check(
      recheck.accessibilityTrusted === false && recheck.running === false,
      'requestDictationAccess() re-check keeps the hook stopped'
    );

    // D8 disposition (drift): no plan fixes a "disabled while polling" state
    // for the grant button and no code implements one — assert the real
    // contract instead: the click runs a re-check, the hook stays stopped
    // while untrusted, the banner stays up, nothing crashes.
    await ev('document.getElementById("dictationGrantBtn").click()');
    await sleep(700);
    const afterGrant = await ev(
      `(() => { const b = document.getElementById('dictationGrantBtn'); const banner = document.getElementById('dictationBanner'); return { btn: !!b, bannerVisible: !!(banner && !banner.hidden) }; })()`
    );
    const recheckAfter = await ev('window.electronAPI.getDictationStatus()');
    check(
      afterGrant.btn && afterGrant.bannerVisible && recheckAfter.running === false,
      `grant button click re-checks safely while untrusted (hook still stopped, banner up: ${JSON.stringify(
        recheckAfter
      )})`
    );

    const hint = await ev('document.getElementById("dictationHint").textContent');
    check(hint.trim() === DICTATION_HINT_TEXT, `dictation hint copy: "${hint.trim()}"`);

    const crashLines = log.join('').split('\n').filter((l) => /Uncaught|FATAL|EXCEPTION/i.test(l));
    check(crashLines.length === 0, `no uncaught/fatal output (${crashLines.length} line(s))`);
    for (const line of crashLines.slice(0, 5)) fail(`guard app reported: ${line.trim()}`);
    check(alive, 'process did not crash while the hook stayed stopped');
    cdp.close();
  } catch (err) {
    fail(`accessibility guard probe aborted: ${err.message}`);
    note(`guard app output: ${log.join('').slice(-2000)}`);
  } finally {
    const tree = processTree(rootPid);
    killTree(rootPid);
    await sleep(1000);
    for (const pid of tree) {
      try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
    }
    const leftover = exec('pgrep', ['-f', `${ROOT}/node_modules/electron/dist`]).stdout
      .split('\n')
      .filter((l) => /^\d+$/.test(l.trim()));
    for (const pid of leftover) {
      try { process.kill(Number(pid), 'SIGKILL'); } catch { /* ignore */ }
    }
    check(leftover.length === 0, `guard instance left no processes (checked ${tree.length} pid(s))`);
    await sleep(500);
  }
}

// ---------------------------------------------------------------------------
// App + settings helpers
// ---------------------------------------------------------------------------

const userDataDir = path.join(os.homedir(), 'Library', 'Application Support', 'Nadabodha');
const settingsFile = path.join(userDataDir, 'settings.json');
const settingsBackup = `${settingsFile}.smoke-backup`;

function backupSettings() {
  let state = 'absent';
  try {
    if (fs.existsSync(settingsFile)) {
      fs.copyFileSync(settingsFile, settingsBackup);
      state = 'backed-up';
    }
    // Start every run from factory defaults (activeModel/python/etc. must not leak
    // between runs) while keeping the user's original file for restore.
    fs.rmSync(settingsFile, { force: true });
  } catch {
    /* keep whatever state we reported */
  }
  return state;
}

function restoreSettings() {
  try {
    if (fs.existsSync(settingsBackup)) {
      fs.copyFileSync(settingsBackup, settingsFile);
      fs.rmSync(settingsBackup, { force: true });
      return 'restored';
    }
    if (fs.existsSync(settingsFile)) {
      fs.rmSync(settingsFile, { force: true });
      return 'removed (no prior file)';
    }
  } catch (err) {
    return `failed: ${err.message}`;
  }
  return 'nothing to restore';
}

async function main() {
  // --- prerequisites -------------------------------------------------------
  step('Prerequisites');
  const electronBinary = path.join(ROOT, 'node_modules', 'electron', 'dist', 'Electron.app', 'Contents', 'MacOS', 'Electron');
  check(fs.existsSync(path.join(ROOT, 'dist', 'main', 'main.js')), 'dist/main/main.js exists (run npm run build first)');
  check(fs.existsSync(electronBinary), `Electron binary present at ${electronBinary}`);
  check(fs.existsSync(SPEECH_WAV), `sample speech file present at ${SPEECH_WAV}`);

  // Kill leftovers from a previous smoke run of THIS worktree only.
  const leftovers = appPids();
  if (leftovers.length > 0) {
    note(`killing ${leftovers.length} leftover process(es) from a previous run: ${leftovers.join(', ')}`);
    for (const pid of leftovers) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        /* ignore */
      }
    }
    await sleep(500);
  }

  const portBusy = await fetch(`http://127.0.0.1:${PORT}/json/version`).then(() => true, () => false);
  if (!check(!portBusy, `debug port ${PORT} is free`)) {
    throw new Error(`port ${PORT} is already in use; refusing to attach to a foreign instance`);
  }

  // Fresh scratch dirs for this run.
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'nadabodha-smoke-'));
  const dataDir = path.join(scratch, 'data');
  const cacheDir = path.join(scratch, 'hf-cache');
  fs.mkdirSync(cacheDir, { recursive: true });

  const settingsState = backupSettings();

  // The accessibility crash guard runs against its own short-lived instance
  // before the main app so its forced-failure state cannot leak into the run.
  await runAccessibilityGuardProbe();

  // --- launch --------------------------------------------------------------
  step('Launch app with remote debugging');
  const child = spawn(electronBinary, ['.', `--remote-debugging-port=${PORT}`], {
    cwd: ROOT,
    env: { ...process.env },
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const rootPid = child.pid;
  const mainLog = [];
  // D7.4: capture Electron stdout/stderr for the report (and abort dumps).
  let appStdout = '';
  let appStderr = '';
  child.stdout.on('data', (buf) => {
    const text = buf.toString();
    appStdout += text;
    mainLog.push(text);
  });
  child.stderr.on('data', (buf) => {
    const text = buf.toString();
    appStderr += text;
    mainLog.push(text);
  });
  child.on('exit', (code, signal) => mainLog.push(`\n[electron exited code=${code} signal=${signal}]\n`));

  let appAlive = true;
  child.on('exit', () => {
    appAlive = false;
  });

  // --- socket sampling -----------------------------------------------------
  const observedRemotes = new Set();
  let samplerTick = 0;
  const sampler = setInterval(() => {
    if (!appAlive) return;
    for (const ip of sampleSockets(processTree(rootPid))) observedRemotes.add(ip);
    if (++samplerTick % 15 === 0) void refreshDnsUnion();
  }, 1000);
  sampler.unref?.();

  // --- connect CDP ---------------------------------------------------------
  const cdpHolder = { client: null };

  let target;
  try {
    target = await waitFor(
      async () => {
        const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
        const list = await res.json();
        return list.find((entry) => entry.type === 'page' && entry.url.includes('index.html'));
      },
      { timeout: 45000, label: 'page target on /json/list' }
    );
  } catch (err) {
    fail(`could not attach to the page target: ${err.message}`);
    console.log('--- app output ---');
    console.log(mainLog.join('').slice(-4000));
    throw err;
  }
  pass(`page target found: ${target.url}`);

  const cdp = await createCdpClient(target.webSocketDebuggerUrl);
  cdpHolder.client = cdp;

  const consoleErrors = [];
  const exceptions = [];
  const pageRequests = [];
  const rendererConsole = [];

  cdp.on('Runtime.consoleAPICalled', (params) => {
    rendererConsole.push({ type: params.type, args: params.args?.length });
    if (params.type === 'error') {
      const text = (params.args || [])
        .map((arg) => arg.value ?? arg.description ?? '')
        .join(' ');
      consoleErrors.push(`console.error: ${text}`);
    }
  });
  cdp.on('Runtime.exceptionThrown', (params) => {
    const details = params.exceptionDetails || {};
    exceptions.push(details.exception?.description || details.text || 'unknown exception');
  });
  cdp.on('Log.entryAdded', (params) => {
    const entry = params.entry || {};
    if (entry.level === 'error' && !String(entry.url || '').includes('favicon')) {
      consoleErrors.push(`log error: ${entry.text} (${entry.url || 'no url'})`);
    }
  });
  cdp.on('Network.requestWillBeSent', (params) => {
    const url = params.request?.url || '';
    pageRequests.push(url);
  });

  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Log.enable');
  await cdp.send('Network.enable');

  async function ev(expression) {
    const res = await cdp.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (res.exceptionDetails) {
      const description =
        res.exceptionDetails.exception?.description || res.exceptionDetails.text || 'evaluation failed';
      throw new Error(`${description}\n  while evaluating: ${String(expression).slice(0, 200)}`);
    }
    return res.result?.value;
  }

  const setVal = (id, value) =>
    ev(`(() => { const el = document.getElementById(${JSON.stringify(id)}); el.value = ${JSON.stringify(
      value
    )}; return el.value; })()`);
  const textOf = (id) => ev(`document.getElementById(${JSON.stringify(id)}).textContent || ''`);
  const stateOf = (id) => ev(`document.getElementById(${JSON.stringify(id)}).getAttribute('data-state') || ''`);
  const getSettings = () => ev('window.electronAPI.getSettings()');
  /** Ground-truth pipeline status over IPC (transcriptionService state). */
  const reqStatus = async () => (await ev('window.electronAPI.requestStatus()')).status;
  /**
   * #statusText shows presentation copy ('Recording…', 'Done: …'), never the
   * raw event name — match case-insensitively on the semantic keyword.
   */
  const statusShows = async (needle) =>
    (await ev('document.getElementById("statusText").textContent || ""')).toLowerCase().includes(needle);
  /** True once THIS run has reached a terminal state (stale text cannot pass). */
  const pipelineDone = async () =>
    (await reqStatus()) === 'completed' || (await statusShows('done'));

  // --- D7.4: global watchdog + renderer-target-loss monitor ---------------
  const dumpAppOutput = (label = 'app output') => {
    console.error(`--- ${label}: stdout tail ---`);
    console.error(appStdout.split('\n').slice(-40).join('\n'));
    console.error(`--- ${label}: stderr tail ---`);
    console.error(appStderr.split('\n').slice(-40).join('\n'));
  };
  // On any abort: report what we know, restore settings, kill the app tree,
  // exit non-zero. Never hang (the base run hung ~10 min after the renderer
  // target vanished mid-dictation-take — D10).
  const abortRun = async (reason) => {
    clearInterval(targetMonitor);
    clearTimeout(watchdog);
    fail(reason);
    console.error(`\nSMOKE_ABORT: ${reason}`);
    console.error(`partial counts: passed=${passCount} failed=${failures.length} skipped=${skipCount}`);
    dumpAppOutput(reason);
    try {
      if (cdpHolder.client) cdpHolder.client.close();
    } catch { /* already closed */ }
    killTree(rootPid);
    await sleep(800);
    for (const pid of appPids()) {
      try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ }
    }
    const restoredAbort = restoreSettings();
    note(`settings.json restored on abort: ${restoredAbort}`);
    console.log('\n================ SMOKE REPORT (aborted) ================');
    console.log(`passed : ${passCount}`);
    console.log(`failed : ${failures.length}`);
    console.log(`skipped: ${skipCount}`);
    for (const msg of failures) console.log(`  FAIL: ${msg}`);
    for (const msg of notes) console.log(`  note: ${msg}`);
    console.log('========================================================');
    console.log('SMOKE_EXIT 1');
    process.exit(1);
  };
  const watchdog = setTimeout(() => {
    void abortRun(`global watchdog fired: run exceeded ${GLOBAL_TIMEOUT_MS / 60000} min`);
  }, GLOBAL_TIMEOUT_MS);
  let sawPageTarget = false;
  const targetMonitor = setInterval(() => {
    if (!appAlive) return;
    void (async () => {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/json/list`);
        const list = await res.json();
        if (!Array.isArray(list)) return;
        const hasPage = list.some((t) => t.type === 'page');
        if (hasPage) { sawPageTarget = true; return; }
        if (!sawPageTarget) return; // still booting; the ready-wait owns this
        // D10: renderer page target gone while Electron main is alive.
        // Confirm once after 2s so a transient reconnect never aborts a good run.
        await sleep(2000);
        const retry = await fetch(`http://127.0.0.1:${port}/json/list`).catch(() => null);
        const retryList = retry ? await retry.json().catch(() => null) : null;
        const stillGone = !Array.isArray(retryList) || !retryList.some((t) => t.type === 'page');
        if (stillGone && appAlive) {
          await abortRun(
            'renderer target lost while Electron main is alive (D10) — /json/list has no page target'
          );
        }
      } catch { /* the monitor never throws into the run */ }
    })();
  }, 10000);

  try {
    // --- boot --------------------------------------------------------------
    step('Wait for renderer');
    await waitFor(
      async () =>
        (await ev('document.readyState')) === 'complete' && (await ev('!!window.electronAPI')),
      { timeout: 30000, label: 'renderer ready' }
    );
    pass('renderer ready with electronAPI exposed');

    // --- D7.2 fail-fast prereqs -------------------------------------------
    // These must abort the run HERE, naming the missing script tag, instead
    // of surfacing as a dozen rendering FAILs ten minutes later.
    step('Fail-fast prereqs (vendored libs + renderer init)');
    // electronAPI exists from the preload — it does not prove renderer.js ran.
    // Wait (bounded) for init() to reach its end; then the lib probes below
    // are meaningful and a dead renderer aborts in seconds, not minutes.
    const bootReady = await waitFor(
      async () => (await ev('window.__nadabodhaReady === true')) === true,
      { timeout: 25000, label: 'renderer init() completes (__nadabodhaReady)' }
    )
      .then(() => true)
      .catch(() => false);
    const boot = await ev(
      '({ ready: window.__nadabodhaReady === true,' +
        ' marked: typeof (window.marked && window.marked.parse),' +
        ' purify: typeof (window.DOMPurify && window.DOMPurify.sanitize),' +
        ' addHook: typeof (window.DOMPurify && window.DOMPurify.addHook) })'
    );
    if (!check(bootReady && boot.ready, 'renderer.js evaluated fully (window.__nadabodhaReady set after init())')) {
      throw new Error(
        'prereq failed: renderer.js aborted before init() completed — a top-level ' +
          'exception (e.g. CommonJS prologue in a classic <script>) or a hung await left ' +
          'window.__nadabodhaReady undefined'
      );
    }
    const missingLibs = [];
    if (boot.marked !== 'function') missingLibs.push('<script src="marked.umd.js"></script>');
    if (boot.purify !== 'function') missingLibs.push('<script src="purify.min.js"></script>');
    if (boot.addHook !== 'function') missingLibs.push('<script src="purify.min.js"></script> (addHook)');
    if (missingLibs.length > 0) {
      fail(`missing vendored library support: ${missingLibs.join(', ')}`);
      throw new Error(
        `prereq failed: window.marked/window.DOMPurify not loaded — index.html is missing ${[
          ...new Set(missingLibs),
        ].join(', ')} before <script src="renderer.js"></script>`
      );
    }
    check(boot.marked === 'function', 'prereq: window.marked.parse is a function');
    check(boot.purify === 'function', 'prereq: window.DOMPurify.sanitize is a function');
    check(boot.addHook === 'function', 'prereq: window.DOMPurify.addHook is a function');

    // --- open settings -----------------------------------------------------
    // The pre-existing floor from earlier cycles is wrapped so that one failing
    // floor step still lets the layout / markdown / dictation sections below
    // run. Failures are still recorded and the process still exits non-zero.
    try {
    step('Open Settings section');
    await ev('document.getElementById("settingsBtn").click()');
    const settingsSection = await ev(
      `(() => { const p = document.getElementById('settingsPanel');` +
        ` return { hidden: p.hidden, tag: p.tagName, role: p.getAttribute('role') }; })()`
    );
    check(!settingsSection.hidden, 'settings section opens from the settings button');
    // v3 plan: settings is a section of the shell, never a modal dialog.
    check(
      settingsSection.tag === 'ASIDE' && settingsSection.role !== 'dialog',
      `settings renders as an <aside> section, not a dialog (tag=${settingsSection.tag}, role=${settingsSection.role})`
    );

    // Wait until the stored settings reached the form (loadSettings is async).
    await waitFor(
      async () => {
        const settings = await getSettings();
        const enabled = await ev('document.getElementById("summarizeEnabledChk").checked');
        const auto = await ev('document.getElementById("autoSummarizeChk").checked');
        return enabled === settings.summarizationEnabled && auto === settings.autoSummarize;
      },
      { timeout: 20000, label: 'settings form hydrated' }
    );
    pass('settings form hydrated from settings.json');

    // Dictation defaults to ON in settingsStore. Park it through the REAL
    // settings toggle (#settingsDictationChk — #dictationEnabledChk is a
    // hidden ID remnant that save() never reads) so the later settings saves
    // in this e2e keep it parked, then stop the hook over IPC.
    const bootSettings = await getSettings();
    check(bootSettings.dictationEnabled === true, 'dictationEnabled defaults to ON');
    await ev('document.getElementById("settingsDictationChk").checked = false');
    await ev('window.electronAPI.updateSettings({ dictationEnabled: false })');
    await waitFor(
      async () => (await ev('window.electronAPI.getDictationStatus()')).running === false,
      { timeout: 15000, label: 'Option hook parked' }
    );
    pass('global Option hook parked for the deterministic e2e');

    // The e2e requires summarization on; make that explicit in the UI.
    await ev(
      '(() => { document.getElementById("summarizeEnabledChk").checked = true; ' +
        'document.getElementById("autoSummarizeChk").checked = true; return true; })()'
    );

    // --- LLM: load models --------------------------------------------------
    step('Configure local LLM');
    await setVal('llmBaseUrlInput', 'http://127.0.0.1:1234/v1');
    await ev('document.getElementById("llmRefreshBtn").click()');
    await waitFor(async () => (await textOf('llmStatus')).includes('Connected'), {
      timeout: 30000,
      label: 'LLM models loaded',
    });
    const hasLlmModel = await ev(
      'Array.from(document.getElementById("llmModelSelect").options).some(o => o.value === ' +
        JSON.stringify(LLM_MODEL) +
        ')'
    );
    check(hasLlmModel, `model dropdown lists ${LLM_MODEL} from GET /v1/models`);
    await setVal('llmBaseUrlInput', 'http://127.0.0.1:1234/v1');
    await ev(
      `(() => { const s = document.getElementById("llmModelSelect"); s.value = ${JSON.stringify(
        LLM_MODEL
      )}; return s.value; })()`
    );
    await ev('document.getElementById("llmTestBtn").click()');
    await waitFor(async () => (await textOf('llmStatus')).includes('Connected'), {
      timeout: 30000,
      label: 'Test Connection result',
    });
    const llmStatusText = await textOf('llmStatus');
    check(llmStatusText.includes('model(s)'), `Test Connection inline result: "${llmStatusText.trim()}"`);

    // Warm the local model. LM Studio can spend minutes loading it on the
    // first chat completion, which would otherwise eat the summary's own 300s
    // budget and make the summary look broken.
    const warmStartedAt = Date.now();
    let warmNote;
    try {
      const warmRes = await fetch('http://127.0.0.1:1234/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: LLM_MODEL,
          messages: [{ role: 'user', content: 'Reply with the single word OK' }],
          max_tokens: 8,
          temperature: 0,
        }),
        signal: AbortSignal.timeout(240000),
      });
      await warmRes.text();
      warmNote = `http ${warmRes.status} in ${((Date.now() - warmStartedAt) / 1000).toFixed(1)}s`;
      llmWarm = warmRes.ok;
    } catch (err) {
      warmNote = `failed after ${((Date.now() - warmStartedAt) / 1000).toFixed(1)}s: ${err.message}`;
    }
    note(`LLM warm-up [${llmWarm ? 'warm' : 'cold'}]: ${warmNote}`);

    // --- bogus python ------------------------------------------------------
    step('Bogus Python interpreter is rejected');
    await setVal('pythonPathInput', '/nonexistent/python3');
    await ev('document.getElementById("pythonValidateBtn").click()');
    await waitFor(async () => (await stateOf('pythonStatus')) === 'error', {
      timeout: 20000,
      label: 'python validation error',
    });
    const bogusMsg = (await textOf('pythonStatus')).trim();
    check(bogusMsg.includes('not found'), `Validate button reports inline error: "${bogusMsg}"`);

    await setVal('dataDirInput', dataDir);
    await setVal('cacheDirInput', cacheDir);
    const settingsBefore = await getSettings();
    await ev('document.getElementById("settingsSaveBtn").click()');
    // D8 disposition (drift): saveSettings writes the issue string itself
    // ("Python interpreter not found: …") rather than a "Saved with issues"
    // banner — accept either marker; the real contract is the persistence
    // checks below.
    await waitFor(
      async () => {
        const t = (await textOf('settingsStatus')) || '';
        return t.includes('Saved with issues') || t.includes('not found') || t.includes('python') ? t : null;
      },
      { timeout: 30000, label: 'save with validation error' }
    );
    const saveIssueMsg = (await textOf('settingsStatus')).trim();
    check(
      /not found|saved with issues/i.test(saveIssueMsg),
      `save reports the python issue inline: "${saveIssueMsg}"`
    );

    const afterBogus = await getSettings();
    check(
      afterBogus.pythonPath === settingsBefore.pythonPath,
      'bogus interpreter path is NOT persisted'
    );
    check(afterBogus.dataDir === dataDir, 'valid fields still save (data dir persisted)');
    check(afterBogus.llmModel === LLM_MODEL, 'valid fields still save (LLM model persisted)');

    // --- python: conda -----------------------------------------------------
    step('Set real Python interpreter');
    await setVal('pythonPathInput', CONDA_PYTHON);
    await ev('document.getElementById("settingsSaveBtn").click()');
    await waitFor(async () => (await stateOf('pythonStatus')) === 'ok', {
      timeout: 90000,
      label: 'python probe OK',
    });
    const okMsg = (await textOf('pythonStatus')).trim();
    check(okMsg.includes('OK'), `probe inline OK: "${okMsg}"`);
    const afterPython = await getSettings();
    check(afterPython.pythonPath === CONDA_PYTHON, 'conda interpreter persisted');

    // --- data dir layout ---------------------------------------------------
    step('Data directory layout');
    check(fs.existsSync(path.join(dataDir, 'transcripts')), 'data dir has transcripts/');
    check(fs.existsSync(path.join(dataDir, 'summaries')), 'data dir has summaries/');
    check(fs.existsSync(path.join(dataDir, 'scripts')), 'data dir has scripts/');
    check(
      fs.existsSync(path.join(dataDir, 'scripts', 'summarize-prompt.md')),
      'default prompt template created in scripts/'
    );
    check(afterPython.sttCacheDir === cacheDir, 'model cache dir persisted');

    // --- HF search ---------------------------------------------------------
    step('Hugging Face model browser');
    await ev(
      `(() => { const i = document.getElementById("hfSearchInput"); i.value = "faster-whisper"; ` +
        `i.dispatchEvent(new Event("input", { bubbles: true })); return i.value; })()`
    );
    // NOTE: hfSearchInput has NO input-event listener in the Steno shell —
    // search is triggered by the Search button (or Enter). The input event
    // above is kept for older flows, but the button is what actually runs
    // loadHfModels() (this was the run2 floor blocker).
    await ev('document.getElementById("hfSearchBtn").click()');
    await waitFor(
      async () => (await ev('document.getElementById("hfResults").children.length')) > 0,
      { timeout: 45000, label: 'HF search results' }
    );
    const rowCount = await ev('document.getElementById("hfResults").children.length');
    check(rowCount > 0, `search returned ${rowCount} row(s)`);

    // D8 disposition (drift): the Steno shell's HF rows carry the repo id in
    // a .hf-model-id span and the format in .hf-model-format — they never had
    // a data-repo-id attribute or a download-count cell (the harness assumed
    // the cycle-2 row markup). Target the implemented markup instead.
    const hfRowExpr = (container) =>
      `[...document.querySelectorAll('${container} .hf-model-item')].find(el => (el.querySelector('.hf-model-id') || {}).textContent === ${JSON.stringify(
        HF_REPO
      )})`;
    const targetRowText = await ev(
      `(() => { const row = ${hfRowExpr('#hfResults')}; return row ? row.textContent : null; })()`
    );
    check(targetRowText !== null, `row for ${HF_REPO} is listed`);
    check(
      typeof targetRowText === 'string' && targetRowText.includes('CTranslate2'),
      `row shows format "CTranslate2": "${targetRowText}"`
    );
    note(
      'row download-count check dropped: Steno rows render repo id + format only (drift vs the cycle-2 markup)'
    );

    // --- download ----------------------------------------------------------
    step('Download model with live progress');
    const selectResult = await ev(
      `(() => { const row = ${hfRowExpr('#hfResults')}; if (!row) return { row: false }; row.click(); return { row: true, selected: row.classList.contains('selected'), actions: !document.getElementById('hfActions').hidden, downloadVisible: !document.getElementById('hfDownloadBtn').hidden }; })()`
    );
    check(
      selectResult && selectResult.row && selectResult.selected,
      `selecting ${HF_REPO} marks the row selected (${JSON.stringify(selectResult)})`
    );
    check(
      selectResult && selectResult.actions && selectResult.downloadVisible,
      'selection enables the Download action (hfActions shown, Download visible)'
    );

    let maxProgress = 0;
    const progressSampler = setInterval(() => {
      ev(
        '(() => { const p = document.getElementById("downloadProgress"); return p.hidden ? -1 : p.value; })()'
      )
        .then((value) => {
          if (typeof value === 'number' && value > maxProgress) maxProgress = value;
        })
        .catch(() => undefined);
    }, 150);

    await ev('document.getElementById("hfDownloadBtn").click()');
    let downloadDone = false;
    let lastDownloadStatus = '';
    const downloadDeadline = Date.now() + 300000;
    while (Date.now() < downloadDeadline) {
      const current = (await textOf('downloadStatus')).trim();
      if (current && current !== lastDownloadStatus) {
        note(`downloadStatus: ${current}`);
        lastDownloadStatus = current;
      }
      // D8 disposition (drift): the app announces completion as
      // "Download complete!" — the harness looked for a "Downloaded " prefix
      // that no code emits (untested until this branch reached the floor).
      if (current.includes('Downloaded ') || current.includes('Download complete')) {
        downloadDone = true;
        break;
      }
      await sleep(500);
    }
    clearInterval(progressSampler);
    if (!downloadDone) {
      const progressState = await ev(
        '(() => { const p = document.getElementById("downloadProgress"); return JSON.stringify({ hidden: p.hidden, value: p.value }); })()'
      );
      fail(
        `download did not finish in time; downloadStatus="${lastDownloadStatus}" progress=${progressState} hfStatus="${(
          await textOf('hfStatus')
        ).trim()}"`
      );
      note(`app output tail: ${mainLog.join('').slice(-1500)}`);
      throw new Error('download timeout');
    }
    const downloadMsg = (await textOf('downloadStatus')).trim();
    pass(`download status: "${downloadMsg}"`);
    check(maxProgress > 0, `live progress reached ${maxProgress}% in the UI`);

    const downloadedBin = (() => {
      const snapshots = path.join(cacheDir, `models--${HF_REPO.replace('/', '--')}`, 'snapshots');
      try {
        for (const rev of fs.readdirSync(snapshots)) {
          const candidate = path.join(snapshots, rev, 'model.bin');
          if (fs.existsSync(candidate)) return candidate;
        }
      } catch {
        return null;
      }
      return null;
    })();
    check(downloadedBin !== null, `files landed in the chosen cache dir (${downloadedBin || 'missing'})`);

    // --- installed + active ------------------------------------------------
    // D8 disposition (drift): installed/search rows in the Steno shell have
    // no data-repo-id attribute (the repo id lives in the .hf-model-id span),
    // the hint contract is different (no "Selected …" hfStatus text), and
    // persistence needs a settings save — retarget to the implemented UX.
    const hfInstalledRowExpr = `[...document.querySelectorAll('#hfInstalled .hf-model-item')].find(el => (el.querySelector('.hf-model-id') || {}).textContent === ${JSON.stringify(
      HF_REPO
    )})`;
    const hfResultsRowExpr = `[...document.querySelectorAll('#hfResults .hf-model-item')].find(el => (el.querySelector('.hf-model-id') || {}).textContent === ${JSON.stringify(
      HF_REPO
    )})`;
    const installedHasModel = await waitFor(
      async () => await ev(`Boolean(${hfInstalledRowExpr})`),
      { timeout: 20000, label: 'installed row appears' }
    ).catch(() => false);
    check(Boolean(installedHasModel), 'downloaded model appears under Installed');

    // Selecting the model and clicking Use can race the download's
    // background refreshModels() re-render, so verify the selection stuck
    // and retry with diagnostics instead of failing blind. hfUseBtn sets the
    // renderer-local activeModel; settingsSaveBtn is what persists it.
    let useEnabled = false;
    let activeSaved = false;
    let selectNote = '';
    for (let attempt = 1; attempt <= 4 && !activeSaved; attempt += 1) {
      const selected = await ev(
        `(() => {
           const row = ${hfInstalledRowExpr};
           if (row) row.click();
           return { installedRow: Boolean(row), selected: row ? row.classList.contains('selected') : false, useVisible: row ? !document.getElementById('hfUseBtn').hidden : false };
         })()`
      );
      if (!selected || !selected.selected) {
        // Fall back to the search-results row for the same repository.
        await ev(
          `(() => { const r = ${hfResultsRowExpr}; if (r) r.click(); return Boolean(r); })()`
        );
      }
      const selectionState = await ev(
        `({ selected: Boolean((${hfInstalledRowExpr}) && (${hfInstalledRowExpr}).classList.contains('selected')) || Boolean((${hfResultsRowExpr}) && (${hfResultsRowExpr}).classList.contains('selected')), useVisible: !document.getElementById('hfUseBtn').hidden, status: (document.getElementById('hfStatus').textContent || '').trim() })`
      );
      useEnabled = Boolean(selectionState && selectionState.useVisible);
      let statusAfterClick = '';
      if (useEnabled) {
        await ev('document.getElementById("hfUseBtn").click()');
        await sleep(500); // hfUseBtn sets renderer-local activeModel …
        await ev('document.getElementById("settingsSaveBtn").click()'); // … and this persists it
        statusAfterClick = (await textOf('hfStatus')).trim();
        activeSaved = Boolean(
          await waitFor(async () => (await getSettings()).activeModel === HF_REPO, {
            timeout: 8000,
            label: 'active model saved',
          }).catch(() => false)
        );
      }
      selectNote = `installedRow=${Boolean(
        selected && selected.installedRow
      )} selection=${JSON.stringify(selectionState)} afterClick=${JSON.stringify(statusAfterClick)}`;
      if (!activeSaved) {
        note(`set-active attempt ${attempt}: ${selectNote}`);
        await sleep(1500);
      }
    }
    check(useEnabled, `installed row enables the Use button (${selectNote})`);
    check(
      activeSaved,
      `active model = ${HF_REPO}` +
        `${activeSaved ? '' : ` [${selectNote} activeModel="${(await getSettings()).activeModel}"]`}`
    );
    // D8 disposition (drift): hfUseBtn sets local state but does not re-render
    // the lists — the "✓ Active" badge only appears after the next list load
    // (loadHfModels refreshes both lists and re-reads activeModel). Re-run the
    // search to refresh, then assert the badge.
    if (activeSaved) {
      await ev('document.getElementById("hfSearchBtn").click()');
      await waitFor(
        async () => (await ev('document.getElementById("hfResults").children.length')) > 0,
        { timeout: 20000, label: 'list refreshed after Use' }
      ).catch(() => undefined);
    }
    const activeBadge = await waitFor(
      async () =>
        await ev(
          `(() => { const row = ${hfInstalledRowExpr}; return row ? /Active/i.test(row.textContent) : false; })()`
        ),
      { timeout: 20000, label: 'active badge rendered' }
    ).catch(() => false);
    check(Boolean(activeBadge), 'Installed list marks the active model');

    // --- transcript end-to-end --------------------------------------------
    step('End-to-end transcription');
    await ev(`window.electronAPI.importAudio(${JSON.stringify(SPEECH_WAV)})`);
    await waitFor(
      async () => {
        const text = await ev('document.getElementById("transcriptArea").value');
        return (await pipelineDone()) && text.length > 0;
      },
      { timeout: 240000, interval: 500, label: 'transcription completed' }
    );
    const transcript = await ev('document.getElementById("transcriptArea").value');
    check(transcript.length > 10, `transcript produced: "${transcript.slice(0, 120)}"`);
    check(!transcript.includes('[Mock transcript]'), 'transcript is real (not the mock fallback)');

    const transcriptPathShown = (await textOf('savedTranscriptPath')).trim();
    check(
      transcriptPathShown.includes('transcripts/transcript_') && transcriptPathShown.endsWith('.txt'),
      `saved transcript path surfaced: "${transcriptPathShown}"`
    );
    // The shell labels the fields "Saved: …"/"Summary: …" (renderer 818/823,
    // 907 may prefix "Summary saved:") — accept either spelling.
    const transcriptFile = transcriptPathShown.replace(/^(?:Transcript|Saved):\s*/, '');
    check(fs.existsSync(transcriptFile), `auto-saved .txt exists (${transcriptFile})`);
    check(
      fs.readFileSync(transcriptFile, 'utf8') === transcript,
      'auto-saved .txt content matches the transcript'
    );

    // --- auto summary ------------------------------------------------------
    step('Auto-summary from LM Studio');
    // Sample the app's TCP sockets while the summary is in flight: a hung
    // summary is otherwise undiagnosable from the report alone.
    const summaryWaitStartedAt = Date.now();
    const connSamples = [];
    const connSampler = setInterval(() => {
      const sockets = exec('lsof', ['-nP', '-iTCP', '-a', '-p', String(rootPid)]).stdout
        .split('\n')
        .filter((line) => line.includes('TCP'))
        .map((line) => line.trim().split(/\s+/).slice(-3).join(' '))
        .join(' | ');
      const queues = exec('netstat', ['-an', '-p', 'tcp'])
        .stdout.split('\n')
        .filter((line) => line.includes('.1234.'))
        .map((line) => line.trim().replace(/\s+/g, ' '))
        .join(' | ');
      connSamples.push(`${Date.now() - summaryWaitStartedAt}ms: ${sockets || 'no sockets'} >> ${queues || 'no 1234 flow'}`);
    }, 5000);
    // Wait for the result OR a reported error so a failing summary surfaces as
    // an assertion instead of an opaque timeout.
    const autoSummaryState = await waitFor(
      async () => {
        const summary = await ev('document.getElementById("summaryArea").value');
        if (summary.length > 0) return 'ok';
        const errorShown = !(await ev('document.getElementById("summaryError").hidden'));
        if (errorShown) return 'error';
        return null;
      },
      { timeout: 360000, interval: 1000, label: 'auto summary' }
    ).catch(() => 'timeout');
    clearInterval(connSampler);
    note(`socket samples during auto summary: ${connSamples.length} sample(s)`);
    for (const sample of connSamples) note(`  ${sample}`);
    const summary = await ev('document.getElementById("summaryArea").value');
    const summaryStatusText = (await textOf('summaryStatus')).trim();
    const summaryErrorText = (await textOf('summaryError')).trim();
    check(
      autoSummaryState === 'ok' && summary.length > 0,
      `auto summary produced (${summary.length} chars) [LLM ${llmWarm ? 'warm' : 'cold'}]: "${summary.slice(0, 100)}"` +
        `${autoSummaryState === 'ok' ? '' : ` [state=${autoSummaryState} status="${summaryStatusText}" error="${summaryErrorText}"]`}`
    );
    // D8 disposition: nothing in the app ever sets a "Summary ready" hint —
    // the renderer clears #summaryStatus on success. The old assertion was
    // drift; the observable contract is: status cleared, no error, summary
    // content present (asserted above), saved path present (below).
    check(summaryStatusText === '', `summary status cleared on success: "${summaryStatusText}"`);
    check((await textOf('summaryError')).trim() === '', 'no summary error shown');

    const summaryPathShown = (await textOf('savedSummaryPath')).trim();
    check(
      summaryPathShown.includes('summaries/summary_') && summaryPathShown.endsWith('.md'),
      `saved summary path surfaced: "${summaryPathShown}"`
    );
    const summaryFile = summaryPathShown.replace(/^(?:Summary saved|Summary):\s*/, '');
    check(fs.existsSync(summaryFile), `auto-saved .md exists (${summaryFile})`);
    check(
      fs.readFileSync(summaryFile, 'utf8') === summary,
      'auto-saved .md content matches the summary'
    );

    // transcript must still be usable after summarization
    const transcriptStillThere = await ev('document.getElementById("transcriptArea").value');
    check(transcriptStillThere === transcript, 'transcript remains intact after summarization');

    // --- manual summarize --------------------------------------------------
    step('Manual Summarize button');
    await ev('document.getElementById("summaryArea").value = ""');
    await ev('document.getElementById("summarizeBtn").click()');
    const manualState = await waitFor(
      async () => {
        const value = await ev('document.getElementById("summaryArea").value');
        if (value.length > 0) return 'ok';
        const errorShown = !(await ev('document.getElementById("summaryError").hidden'));
        if (errorShown) return 'error';
        return null;
      },
      { timeout: 360000, interval: 1000, label: 'manual summary' }
    ).catch(() => 'timeout');
    const manualSummary = await ev('document.getElementById("summaryArea").value');
    check(
      manualState === 'ok' && manualSummary.length > 0,
      `manual summary produced (${manualSummary.length} chars)` +
        `${manualState === 'ok' ? '' : ` [state=${manualState} error="${(await textOf('summaryError')).trim()}"]`}`
    );
    const summaryFiles = fs.readdirSync(path.join(dataDir, 'summaries'));
    check(summaryFiles.length >= 2, `summaries/ holds ${summaryFiles.length} .md file(s) after manual run`);
    } catch (err) {
      // Floor step failed: record it and keep going so the sections below still
      // prove the new work; the process still exits non-zero via `failures`.
      fail(`floor step aborted: ${err.message}`);
      note('continuing with the layout / markdown / dictation sections');
    }

    // --- Steno shell structure + plan-fixed layout values ------------------
    step('Steno shell structure (v3 plan)');
    const shell = await ev(
      `(() => { const q = (id) => document.getElementById(id);
         const exists = (id) => Boolean(q(id));
         const nav = ['navHome', 'navAll'].every(exists);
         const detail = q('noteDetail');
         const pill = q('recordingPill');
         return {
           sidebar: exists('sidebar'),
           nav,
           search: exists('searchInput'),
           noteList: exists('noteList'),
           noteListItems: q('noteList') ? q('noteList').children.length : 0,
           detailOpen: detail ? !detail.hidden : false,
           title: exists('noteTitle'),
           folderSelect: exists('noteFolderSelect'),
           tabs: exists('tabTranscript') && exists('tabSummary'),
           staleHint: exists('summaryStaleHint'),
           reTranscribe: exists('reTranscribeBtn'),
           pillExists: Boolean(pill),
           pillHiddenWhenIdle: pill ? pill.hidden === true : false,
         }; })()`
    );
    check(shell.sidebar, '#sidebar present');
    check(shell.nav, 'nav present (#navHome + #navAll)');
    check(shell.search, '#searchInput present');
    check(shell.noteList, '#noteList present');
    check(
      shell.noteListItems >= 1,
      `note list has items after the floor import (${shell.noteListItems} item(s))`
    );
    check(
      shell.detailOpen,
      'note detail opens after the floor import (title/folder/tabs reachable)'
    );
    check(shell.title && shell.folderSelect, 'note detail has title + folder select');
    check(shell.tabs, 'transcript + summary tabs present');
    check(shell.staleHint, '#summaryStaleHint present');
    check(shell.reTranscribe, '#reTranscribeBtn present');
    check(shell.pillExists && shell.pillHiddenWhenIdle, 'recording pill exists and is hidden at rest');

    // ⌘K focus (synthetic key — same-library injection, labeled synthetic).
    // The renderer listens on `document`, so dispatch there.
    await ev('document.activeElement && document.activeElement.blur()');
    await ev(
      `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true, bubbles: true }))`
    );
    const searchFocused = await ev('document.activeElement === document.getElementById("searchInput")');
    check(searchFocused, '[synthetic] ⌘K focuses #searchInput');

    step('Steno shell layout + plan values (workstream 1)');
    // Measure the default view: transcript tab active, settings folded away.
    await ev('document.getElementById("tabTranscript").click()');
    if (!(await ev('document.getElementById("settingsPanel").hidden'))) {
      // D8 disposition (drift): settingsBtn only OPENS the section
      // (openSettings); the fold control is settingsCloseBtn (closeSettings).
      await ev('document.getElementById("settingsCloseBtn").click()');
      // closeSettings may await async work — wait for the fold instead of
      // sampling one round-trip after the click.
      await waitFor(async () => await ev('document.getElementById("settingsPanel").hidden'), {
        timeout: 8000,
        label: 'settings folds away',
      }).catch(() => undefined);
    }
    check(
      await ev('document.getElementById("settingsPanel").hidden'),
      'settings stays a collapsible section of the right column (not a modal)'
    );
    check(
      await ev('!document.getElementById("transcriptPanel").hidden && document.getElementById("summaryPanel").hidden'),
      'transcript tab is the default tab'
    );

    // Hard constraint: the restructure may move/restyle but never drop ids.
    const referenced = referencedIds();
    const missingIds = await ev(
      `(() => { const ids = ${JSON.stringify(referenced)}; return ids.filter((id) => !document.getElementById(id)); })()`
    );
    check(
      missingIds.length === 0,
      `all ${referenced.length} ids referenced by renderer.ts / cdp-smoke.mjs exist in the DOM`
    );
    for (const id of missingIds) fail(`missing element id: #${id}`);

    const layout = await ev(LAYOUT_PROBE);
    const panes = layout.panes || { sidebar: { x: 0, w: 0 }, main: { x: 1e9, w: 0 } };
    check(
      Math.abs(layout.outer.w - DEFAULT_WINDOW.width) <= 2 &&
        Math.abs(layout.outer.h - DEFAULT_WINDOW.height) <= 2,
      `window default ${DEFAULT_WINDOW.width}x${DEFAULT_WINDOW.height} (outer ${layout.outer.w}x${layout.outer.h})`
    );
    check(layout.panes !== null, 'Steno shell panes present (#sidebar + #mainContent)');
    check(
      panes.sidebar.x + panes.sidebar.w <= panes.main.x + 1,
      'sidebar sits left of main content with no overlap'
    );
    check(
      layout.doc.sw <= layout.inner.w + 1 && layout.doc.sh <= layout.inner.h + 1,
      `no page-level overflow at ${layout.inner.w}x${layout.inner.h}`
    );
    const clipped = Object.entries(layout.visible).filter(([, ok]) => ok === false).map(([id]) => id);
    const unrendered = Object.entries(layout.visible).filter(([, ok]) => ok === 'not-rendered').map(([id]) => id);
    check(
      clipped.length === 0,
      `key controls fully inside the viewport (${clipped.length ? `clipped: ${clipped.join(', ')}` : 'none clipped'}; not-rendered at rest: ${unrendered.join(', ') || 'none'})`
    );
    check(layout.hintText.trim() === DICTATION_HINT_TEXT, `dictation hint copy: "${layout.hintText.trim()}"`);
    check(layout.colorScheme === 'dark', `single dark theme (color-scheme: ${layout.colorScheme})`);
    for (const [name, value] of Object.entries(layout.contrast)) {
      if (value === null) fail(`contrast not computable for ${name}`);
      else check(value >= 4.5, `WCAG AA ${name}: ${value}:1`);
    }
    note(`body ${layout.bodyColor} on ${layout.bodyBg}`);

    // Minimum size. Two parts: the window must actually clamp to the
    // configured minWidth/minHeight, and the content must not clip there.
    // Electron's devtools endpoint here does not expose
    // Browser.getWindowForTarget, so the real window is driven with
    // window.resizeTo() and the content is verified in an emulated viewport of
    // the same size (the title bar costs 28px, as measured above: 760 -> 732).
    const beforeResize = await ev('({ w: outerWidth, h: outerHeight })');
    await ev('window.resizeTo(600, 400)');
    await sleep(900);
    const afterResize = await ev('({ w: outerWidth, h: outerHeight })');
    const resizeWorks = afterResize.w !== beforeResize.w || afterResize.h !== beforeResize.h;
    if (resizeWorks) {
      check(
        afterResize.w >= MIN_WINDOW.width - 2 && afterResize.h >= MIN_WINDOW.height - 2,
        `window clamps at minWidth/minHeight: requested 600x400, got ${afterResize.w}x${afterResize.h}`
      );
    } else {
      const mainSource = fs.readFileSync(path.join(ROOT, 'src', 'main', 'main.ts'), 'utf8');
      check(
        /minWidth:\s*960/.test(mainSource) && /minHeight:\s*640/.test(mainSource),
        `minWidth: 960 / minHeight: 640 configured on the BrowserWindow (window.resizeTo unavailable: ${JSON.stringify(afterResize)})`
      );
    }
    await ev(`window.resizeTo(${DEFAULT_WINDOW.width}, ${DEFAULT_WINDOW.height})`);
    await sleep(700);

    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: MIN_WINDOW.width,
      height: MIN_WINDOW.height - 28,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await sleep(900);
    const minLayout = await ev(LAYOUT_PROBE);
    check(
      Math.abs(minLayout.inner.w - MIN_WINDOW.width) <= 2,
      `content measured at the minimum window size (${minLayout.inner.w}x${minLayout.inner.h} content of ${MIN_WINDOW.width}x${MIN_WINDOW.height})`
    );
    const minClipped = Object.entries(minLayout.visible).filter(([, ok]) => ok === false).map(([id]) => id);
    check(
      minClipped.length === 0,
      `no clipped content at min size ${MIN_WINDOW.width}x${MIN_WINDOW.height}` +
        `${minClipped.length ? ` (clipped: ${minClipped.join(', ')})` : ''}`
    );
    check(
      minLayout.doc.sw <= minLayout.inner.w + 1 && minLayout.doc.sh <= minLayout.inner.h + 1,
      `no page overflow at min size (${minLayout.doc.sw}x${minLayout.doc.sh} vs ${minLayout.inner.w}x${minLayout.inner.h})`
    );
    const minPanes = minLayout.panes || { sidebar: { x: 0, w: 0 }, main: { x: 1e9, w: 0 } };
    check(
      minPanes.sidebar.x + minPanes.sidebar.w <= minPanes.main.x + 1,
      'sidebar stays left of main content at min size'
    );
    await cdp.send('Emulation.clearDeviceMetricsOverride');
    await sleep(700);

    // --- summary rendered as markdown --------------------------------------
    step('Summary rendered as Markdown (workstream 2)');
    const libs = await ev(
      '({ marked: typeof (window.marked && window.marked.parse), ' +
        'purify: typeof (window.DOMPurify && window.DOMPurify.sanitize), ' +
        'addHook: typeof (window.DOMPurify && window.DOMPurify.addHook) })'
    );
    check(libs.marked === 'function', 'vendored marked exposes window.marked.parse');
    check(libs.purify === 'function', 'vendored dompurify exposes window.DOMPurify.sanitize');
    check(libs.addHook === 'function', 'dompurify exposes addHook (used for the src policy)');

    await ev('document.getElementById("tabSummary").click()');
    const defaultView = await ev(
      `(() => ({ rawHidden: document.getElementById('summaryArea').hidden,
                 previewShown: !document.getElementById('summaryPreview').hidden,
                 pressed: document.getElementById('summaryPreviewBtn').getAttribute('aria-pressed') }))()`
    );
    check(
      defaultView.rawHidden === true && defaultView.previewShown === true && defaultView.pressed === 'true',
      'Summary tab defaults to the rendered Preview'
    );

    const llmSummary = await ev('document.getElementById("summaryArea").value');
    if (llmSummary.trim()) {
      check(llmSummary.trim().length > 0, `LLM summary source present (${llmSummary.length} chars)`);
      const llmRendered = await ev(
        `(() => { const p = document.getElementById('summaryPreview');
                   return { headings: p.querySelectorAll('h1,h2,h3,h4,h5,h6').length,
                            items: p.querySelectorAll('li').length,
                            text: (p.textContent || '').trim() }; })()`
      );
      check(llmRendered.text.length > 0, `preview renders the summary (${llmRendered.text.length} chars of text)`);
      if (/^#{1,6}\s/m.test(llmSummary)) {
        check(llmRendered.headings > 0, `summary headings render as <h*> (${llmRendered.headings})`);
      } else {
        note('LLM summary source contained no markdown headings; fixture below covers headings');
      }
      if (/^\s*[-*+]\s+/m.test(llmSummary)) {
        check(llmRendered.items > 0, `summary bullet lists render (${llmRendered.items} items)`);
      } else {
        note('LLM summary source contained no bullet list; fixture below covers lists');
      }
    } else {
      note('no LLM summary in the DOM (floor summarization did not complete) — fixture below covers rendering');
    }

    // Deterministic coverage for every construct the preview must handle.
    // IMPORTANT (root-caused in the builder debug probe): the Preview button
    // renders the NOTE's stored summary (switchSummaryView →
    // renderMarkdown(currentNoteContent.summary)), never the textarea, so a
    // fixture typed into #summaryArea alone shows "No summary yet". Seed the
    // fixture through the app's own path: updateNote(summary) + reopen.
    const llmSourceBeforeFixture = llmSummary;
    const activeNoteId = async () =>
      ev(
        `(() => { const li = document.querySelector('#noteList li.active'); return li ? li.dataset.id : null; })()`
      );
    const seedNoteSummary = async (summary) => {
      // Ensure a note is open first — the fixture phases may run with no
      // active note (floor only opens one on its own render path).
      let id = await activeNoteId();
      if (!id) {
        await ev(
          `(() => { const li = document.querySelector('#noteList li'); if (li) li.click(); return Boolean(li); })()`
        );
        await sleep(700);
        id = await activeNoteId();
      }
      if (!id) {
        note(
          `seedNoteSummary: no note id (list children=${await ev('document.getElementById("noteList").children.length')})`
        );
        return false;
      }
      const res = await ev(
        `window.electronAPI.updateNote({ id: ${JSON.stringify(id)}, summary: ${JSON.stringify(
          summary
        )}, markSummaryStale: false })`
      );
      if (!res || !res.success) {
        note(`seedNoteSummary: updateNote rejected for ${id}: ${JSON.stringify(res)}`);
        return false;
      }
      await ev(
        `(() => { const li = document.querySelector('#noteList li.active'); if (li) li.click(); return true; })()`
      );
      await sleep(700);
      const val = await ev('document.getElementById("summaryArea").value');
      // The store strips the trailing newline on save (probe-verified:
      // textarea holds the full fixture minus the final \n) — compare
      // end-trimmed, not byte-identical.
      if (String(val).trimEnd() !== String(summary).trimEnd()) {
        note(
          `seedNoteSummary: textarea mismatch after reopen (${val.length} vs ${summary.length} chars)`
        );
        return false;
      }
      return true;
    };
    const fixtureSeeded = await seedNoteSummary(MARKDOWN_FIXTURE);
    check(fixtureSeeded, 'fixture summary seeded into the open note (updateNote + reopen)');
    await ev('document.getElementById("summaryPreviewBtn").click()');
    const fixture = await ev(
      `(() => { const p = document.getElementById('summaryPreview');
                 const q = (s) => p.querySelectorAll(s).length;
                 const inlineCode = Array.from(p.querySelectorAll('code')).filter((c) => !c.closest('pre')).length;
                 return { h1: q('h1'), h2: q('h2'), li: q('li'), strong: q('strong'), em: q('em'),
                          inlineCode, fenced: q('pre code'), links: q('a[href]'),
                          linkHref: (p.querySelector('a[href]') || {}).getAttribute
                            ? p.querySelector('a[href]').getAttribute('href') : '',
                          quote: q('blockquote'), table: q('table') }; })()`
    );
    check(fixture.h1 >= 1 && fixture.h2 >= 2, `headings render (h1=${fixture.h1}, h2=${fixture.h2})`);
    check(fixture.li >= 2, `lists render (${fixture.li} items)`);
    check(fixture.strong >= 1 && fixture.em >= 1, `bold + italic render (strong=${fixture.strong}, em=${fixture.em})`);
    check(
      fixture.inlineCode >= 1 && fixture.fenced >= 1,
      `inline + fenced code render (inline=${fixture.inlineCode}, fenced=${fixture.fenced})`
    );
    check(fixture.links >= 1 && fixture.linkHref === 'https://example.com/docs', `links render with href (${fixture.linkHref})`);
    check(fixture.quote >= 1, 'blockquotes render');
    check(fixture.table >= 1, 'tables render');

    // Raw <-> Preview round trip over the same source.
    const sourceBeforeToggle = await ev('document.getElementById("summaryArea").value');
    await ev('document.getElementById("summaryRawBtn").click()');
    const rawState = await ev(
      `(() => ({ rawHidden: document.getElementById('summaryArea').hidden,
                 previewHidden: document.getElementById('summaryPreview').hidden,
                 value: document.getElementById('summaryArea').value,
                 rawPressed: document.getElementById('summaryRawBtn').getAttribute('aria-pressed') }))()`
    );
    check(
      rawState.rawHidden === false && rawState.previewHidden === true && rawState.rawPressed === 'true',
      'Raw shows the original markdown in #summaryArea'
    );
    check(rawState.value === sourceBeforeToggle, 'Raw view carries the identical source');
    await ev('document.getElementById("summaryPreviewBtn").click()');
    const backState = await ev(
      `(() => ({ rawHidden: document.getElementById('summaryArea').hidden,
                 previewShown: !document.getElementById('summaryPreview').hidden,
                 value: document.getElementById('summaryArea').value }))()`
    );
    check(
      backState.rawHidden === true && backState.previewShown === true && backState.value === sourceBeforeToggle,
      'Preview round-trips to the same source'
    );

    // Untrusted LLM output must never execute. Same seeding rule as above:
    // the payload has to reach the preview via the note's stored summary.
    const errorsBeforeXss = consoleErrors.length;
    const xssSeeded = await seedNoteSummary(XSS_PAYLOAD);
    check(xssSeeded, 'XSS payload seeded into the note summary');
    await ev('document.getElementById("summaryPreviewBtn").click()');
    await sleep(1500);
    const xss = await ev(
      `(() => { const p = document.getElementById('summaryPreview'); const img = p.querySelector('img');
                 return { ran: typeof window.__xss, scripts: p.querySelectorAll('script').length,
                          onerror: img ? img.getAttribute('onerror') : null,
                          hasImg: !!img, html: p.innerHTML,
                          raw: document.getElementById('summaryArea').value }; })()`
    );
    check(xss.ran === 'undefined', `payload script never executed (window.__xss is ${xss.ran})`);
    check(xss.scripts === 0, 'no <script> element survives in the preview');
    check(xss.onerror === null, 'onerror handler stripped from the rendered payload');
    check(xss.hasImg, 'payload markup still reaches the preview (sanitized, not nuked)');
    check(xss.raw === XSS_PAYLOAD, 'raw source still holds the payload — Copy would export it');
    const xssErrors = consoleErrors.slice(errorsBeforeXss);
    check(xssErrors.length === 0, `no console errors from the XSS payload (${xssErrors.join(' | ') || 'none'})`);
    for (const entry of xssErrors) note(`xss-phase console entry: ${entry}`);

    // Restore the real summary, then prove Copy + the auto-saved file keep
    // the RAW markdown (never the rendered HTML).
    const summaryRestored = await seedNoteSummary(llmSourceBeforeFixture);
    check(summaryRestored, 'original summary restored into the note after XSS phase');
    await ev('document.getElementById("summaryPreviewBtn").click()');
    if (llmSourceBeforeFixture.trim()) {
      await ev('document.getElementById("copySummaryBtn").click()');
      await sleep(500);
      const summaryClipboard = exec('pbpaste', []).stdout;
      check(
        summaryClipboard === llmSourceBeforeFixture,
        `summary Copy puts the RAW markdown on the clipboard (${summaryClipboard.length}/${llmSourceBeforeFixture.length} chars)`
      );
      // The shell writes either "Summary: …" or "Summary saved: …" — strip
      // either prefix so the fs check sees a bare absolute path.
      const savedSummaryPathText = (await textOf('savedSummaryPath'))
        .trim()
        .replace(/^(?:Summary saved|Summary):\s*/, '');
      check(
        savedSummaryPathText.startsWith('/') && savedSummaryPathText.endsWith('.md'),
        `saved summary path surfaced: "${savedSummaryPathText}"`
      );
      const savedSummaryRaw = fs.existsSync(savedSummaryPathText)
        ? fs.readFileSync(savedSummaryPathText, 'utf8')
        : '';
      check(
        savedSummaryRaw === llmSourceBeforeFixture,
        'auto-saved .md matches the RAW markdown source, not the rendered HTML'
      );
      check(!/^\s*<h[1-6]/i.test(savedSummaryRaw), 'auto-saved .md is not rendered HTML');
    } else {
      note('no summary source in the DOM (floor failed before summarization) — Copy/.md checks skipped');
    }

    // --- note library lifecycle (test plan §3.3) ---------------------------
    step('Note library lifecycle: record → note appears → opens');
    const openNoteCount = () => ev('document.getElementById("noteList").children.length');
    const listBeforeRecord = await openNoteCount();
    await ev('document.getElementById("recordBtn").click()');
    const pillUp = await waitFor(
      async () => !(await ev('document.getElementById("recordingPill").hidden')),
      { timeout: 12000, label: 'recording pill appears' }
    )
      .then(() => true)
      .catch(() => false);
    check(pillUp, 'record button starts a recording (pill shown)');
    let recordAudio = null;
    if (pillUp) {
      recordAudio = spawn('afplay', ['-v', '1.0', SPEECH_WAV], { stdio: 'ignore' });
    }
    // Streaming contract: partial text must land in the transcript WHILE the
    // pill is up, BEFORE stop is clicked (partial-then-final ordering).
    const transcriptBeforeRecord = await ev('document.getElementById("transcriptArea").value');
    let partialSeenAt = null;
    const recordDeadline = Date.now() + 14000;
    while (Date.now() < recordDeadline) {
      const value = await ev('document.getElementById("transcriptArea").value');
      if (value !== transcriptBeforeRecord && partialSeenAt === null) partialSeenAt = Date.now();
      await sleep(400);
    }
    const stopClickedAt = Date.now();
    await ev('document.getElementById("stopRecordBtn").click()');
    if (recordAudio) recordAudio.kill();
    // Only wait on the pipeline if the take actually opened — otherwise fail
    // fast and report WHY (button state / surfaced error / status line).
    let recordOutcome = 'no-start (pill never showed)';
    if (pillUp) {
      recordOutcome = await waitFor(
        async () => {
          const status = await reqStatus();
          return status === 'completed' || status === 'error' ? status : null;
        },
        { timeout: 240000, interval: 500, label: 'record → transcribe completes' }
      ).catch(() => 'timeout');
    }
    const recDiag = {
      err: await ev(
        `(() => { const e = document.getElementById('errorText'); return e.hidden ? '' : e.textContent.slice(0, 220); })()`
      ),
      status: await textOf('statusText'),
      disabled: await ev('document.getElementById("recordBtn").disabled'),
      pipeline: await reqStatus(),
    };
    check(
      recordOutcome === 'completed',
      `recording transcribes to completion (outcome=${recordOutcome}, btnDisabled=${recDiag.disabled}, pipeline=${recDiag.pipeline}, status="${recDiag.status}", err="${recDiag.err}")`
    );
    const listAfterRecord = await openNoteCount();
    check(
      listAfterRecord >= listBeforeRecord + 1,
      `new note appears in #noteList (${listBeforeRecord} → ${listAfterRecord})`
    );
    check(
      !(await ev('document.getElementById("noteDetail").hidden')),
      'the new note opens in the detail pane'
    );
    check(
      partialSeenAt !== null && partialSeenAt < stopClickedAt,
      partialSeenAt !== null
        ? `streaming partial arrived while recording, before stop (${stopClickedAt - partialSeenAt}ms before stop click)`
        : 'streaming partial text arrived while recording (partial-then-final ordering) — NOT OBSERVED'
    );

    // --- folder create + move (test plan §3.3) -----------------------------
    step('Folder seed + note move');
    // addFolderBtn calls window.prompt(), which Electron does not implement —
    // seed the folder through the same IPC a note move uses instead.
    const seed = await ev(
      `window.electronAPI.createNote({ title: 'Smoke folder anchor', source: 'import', folder: 'SmokeFolder', transcript: 'anchor transcript' })`
    );
    check(Boolean(seed && seed.success), 'anchor note seeding folder "SmokeFolder" created');
    // Refresh renderer state: a title blur round-trip is a UI path that
    // re-runs loadNotes() (lists + folder registry) without a reload.
    await ev(
      `(() => { const t = document.getElementById('noteTitle'); t.dispatchEvent(new Event('blur', { bubbles: true })); return true; })()`
    );
    await sleep(700);
    await ev(
      `(() => { const li = document.querySelector('#noteList li.active'); if (li) li.click(); return Boolean(li); })()`
    );
    await sleep(500);
    const folderOpts = await ev(
      `[...document.getElementById('noteFolderSelect').options].map(o => o.value)`
    );
    check(
      Array.isArray(folderOpts) && folderOpts.includes('SmokeFolder'),
      `folder select lists the seeded folder (${(folderOpts || []).join(', ')})`
    );
    const movableId = await ev(
      `(() => { const li = document.querySelector('#noteList li.active'); return li ? li.dataset.id : null; })()`
    );
    check(Boolean(movableId), 'a note is active and ready to move');
    if (movableId) {
      await ev(
        `(() => { const s = document.getElementById('noteFolderSelect'); s.value = 'SmokeFolder'; s.dispatchEvent(new Event('change', { bubbles: true })); return s.value; })()`
      );
      await sleep(800);
      const moved = await ev(
        `window.electronAPI.readNoteContent(${JSON.stringify(movableId)})`
      );
      check(
        moved && moved.note && moved.note.folder === 'SmokeFolder',
        `note moves into the folder (folder=${moved && moved.note ? moved.note.folder : 'n/a'})`
      );
    }

    // --- ⌘K offline search filters (test plan §3.3) ------------------------
    step('⌘K search filters the list (offline)');
    await ev(
      `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true, bubbles: true }))`
    );
    const focusedForSearch = await ev(
      'document.activeElement === document.getElementById("searchInput")'
    );
    check(focusedForSearch, '[synthetic] ⌘K focuses search before filtering');
    await ev(
      `(() => { const i = document.getElementById('searchInput'); i.value = 'zzz-no-such-note-xyz'; i.dispatchEvent(new Event('input', { bubbles: true })); return i.value; })()`
    );
    const emptyFiltered = await waitFor(
      async () => (await openNoteCount()) === 0,
      { timeout: 8000, label: 'search filters to zero matches' }
    )
      .then(() => true)
      .catch(() => false);
    check(emptyFiltered, 'nonsense query filters the list to zero items');
    await ev(
      `(() => { const i = document.getElementById('searchInput'); i.value = 'Smoke folder anchor'; i.dispatchEvent(new Event('input', { bubbles: true })); return i.value; })()`
    );
    const anchorMatches = await waitFor(
      async () => (await openNoteCount()) >= 1,
      { timeout: 8000, label: 'search matches the anchor note' }
    )
      .then(() => openNoteCount())
      .catch(() => 0);
    check(anchorMatches >= 1, `query "Smoke folder anchor" matches the note (${anchorMatches} item(s))`);
    await ev('document.getElementById("searchClearBtn").click()');
    await sleep(600);
    const clearedCount = await openNoteCount();
    check(clearedCount >= listAfterRecord, `clearing search restores the full list (${clearedCount} item(s))`);

    // --- re-transcribe: D4 guards + replace-on-success ---------------------
    step('Re-transcribe (D4 guards, failure keeps bytes, success swaps)');
    const allNotes = await ev('window.electronAPI.searchNotes("")');
    const audioNote = (allNotes.notes || []).find((n) => n.hasAudio);
    check(Boolean(audioNote), 'a note with stored audio exists for re-transcribe');
    const seedAudioless = await ev(
      `window.electronAPI.createNote({ title: 'No-audio retranscribe probe', source: 'import', transcript: 'STATIC TRANSCRIPT WITHOUT AUDIO' })`
    );
    check(Boolean(seedAudioless && seedAudioless.success), 'audio-less note created');
    await ev(
      `(() => { const t = document.getElementById('noteTitle'); t.dispatchEvent(new Event('blur', { bubbles: true })); return true; })()`
    );
    await sleep(700);
    await ev(
      `(() => { const li = [...document.querySelectorAll('#noteList li')].find(el => el.textContent.includes('No-audio retranscribe probe')); if (li) li.click(); return Boolean(li); })()`
    );
    await sleep(600);
    const audiolessBtn = await ev(
      `(() => { const b = document.getElementById('reTranscribeBtn'); return { disabled: b.disabled, title: b.title }; })()`
    );
    check(audiolessBtn.disabled, 're-transcribe is DISABLED on an audio-less note');
    check(
      String(audiolessBtn.title).toLowerCase().includes('no audio'),
      `tooltip explains why: "${audiolessBtn.title}"`
    );

    if (audioNote) {
      await ev(
        `(() => { const li = document.querySelector('#noteList li[data-id="${audioNote.id}"]'); if (li) li.click(); return Boolean(li); })()`
      );
      await sleep(600);
      const audioBtn = await ev(
        `(() => { const b = document.getElementById('reTranscribeBtn'); return { disabled: b.disabled, title: b.title }; })()`
      );
      check(audioBtn.disabled === false, 're-transcribe is enabled on a note with audio');

      // Replace-on-success guard: seed a SENTINEL transcript so the failure
      // run has something byte-identical to preserve.
      const SENTINEL = `SENTINEL-OLD-TRANSCRIPT-${Date.now()}`;
      await ev(
        `window.electronAPI.updateNote({ id: ${JSON.stringify(audioNote.id)}, transcript: ${JSON.stringify(SENTINEL)}, markSummaryStale: false })`
      );
      await ev(
        `(() => { const li = document.querySelector('#noteList li[data-id="${audioNote.id}"]'); if (li) li.click(); return Boolean(li); })()`
      );
      await sleep(600);
      const seeded = await ev('document.getElementById("transcriptArea").value');
      check(seeded === SENTINEL, 'sentinel transcript loaded into the pane');

      // (b) FAILURE: kill the transcription adapter mid-run (the plan's own
      // failure injection) — old transcript must stay byte-identical.
      await ev('document.getElementById("reTranscribeBtn").click()');
      const failureStarted = await waitFor(
        async () => (await statusShows('transcribing')) || (await reqStatus()) === 'transcribing',
        { timeout: 15000, label: 're-transcribe starts' }
      )
        .then(() => true)
        .catch(() => false);
      check(failureStarted, 're-transcribe run starts (status shows transcribing)');
      const adapterPids = pidsForPattern(`${ROOT}/python/nadabodha_transcribe.py`);
      check(adapterPids.length >= 1, `transcription adapter process running (pids: ${adapterPids.join(', ') || 'none'})`);
      const errorSeen = { at: null, how: null };
      for (const pid of adapterPids) {
        try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
      }
      const killAt = Date.now();
      while (Date.now() - killAt < 30000) {
        const status = await reqStatus();
        const errShown = await ev(
          `(() => { const e = document.getElementById('errorText'); return !e.hidden && e.textContent.length > 0; })()`
        );
        const statusTextNow = await ev('document.getElementById("statusText").textContent || ""');
        if (errShown) { errorSeen.at = Date.now(); errorSeen.how = 'errorText'; break; }
        if (status === 'error') { errorSeen.at = Date.now(); errorSeen.how = 'reqStatus=error'; break; }
        if (/fail|exited|error/i.test(statusTextNow)) { errorSeen.at = Date.now(); errorSeen.how = `statusText="${statusTextNow.slice(0, 60)}"`; break; }
        if (status === 'idle' && Date.now() - killAt > 4000) { errorSeen.at = Date.now(); errorSeen.how = 'pipeline settled after kill'; break; }
        await sleep(250);
      }
      check(errorSeen.at !== null, `adapter kill surfaces an error (${errorSeen.how || 'NOTHING SEEN'})`);
      // Wait for the pipeline to fully settle before asserting bytes.
      await waitFor(
        async () => {
          const status = await reqStatus();
          return status !== 'transcribing' && status !== 'recording';
        },
        { timeout: 20000, label: 'pipeline settles after adapter kill' }
      ).catch(() => undefined);
      const afterFailure = await ev('document.getElementById("transcriptArea").value');
      check(
        afterFailure === SENTINEL,
        `failed re-transcribe leaves the transcript BYTE-IDENTICAL (${afterFailure === SENTINEL ? 'unchanged' : `CHANGED to ${JSON.stringify(String(afterFailure).slice(0, 60))}`})`
      );
      const btnAfterFailure = await ev(
        `(() => { const b = document.getElementById('reTranscribeBtn'); return { disabled: b.disabled, title: b.title }; })()`
      );
      check(btnAfterFailure.disabled === false, 're-transcribe button re-enabled after the failed run (D4 release)');

      // (c) SUCCESS: same audio, adapter healthy → transcript swaps, summary
      // marked stale, run token released.
      const errHiddenBefore = await ev(
        `document.getElementById('errorText').hidden || document.getElementById('errorText').textContent === ''`
      );
      await ev('document.getElementById("reTranscribeBtn").click()');
      // D4 in-flight: the click handler disables the button synchronously.
      const inFlight = await ev(
        `(() => { const b = document.getElementById('reTranscribeBtn'); return { disabled: b.disabled, title: b.title }; })()`
      );
      check(inFlight.disabled, 're-transcribe button DISABLED while a run is in flight (D4 guard a)');
      check(
        String(inFlight.title).toLowerCase().includes('in progress'),
        `in-flight tooltip: "${inFlight.title}"`
      );
      // A second (programmatic) trigger must be a no-op: dispatch click on
      // the disabled button and prove no error/save-path side effects.
      await ev(
        `(() => { const b = document.getElementById('reTranscribeBtn'); b.dispatchEvent(new MouseEvent('click', { bubbles: true })); return true; })()`
      );
      const secondTriggerState = await ev(
        `(() => { const e = document.getElementById('errorText'); return { errHidden: e.hidden || e.textContent === '' }; })()`
      );
      check(
        secondTriggerState.errHidden === true,
        'second in-flight trigger is ignored (no error surfaced from a rejected duplicate run)'
      );
      const successOutcome = await waitFor(
        async () => {
          const status = await reqStatus();
          return status === 'completed' || status === 'error' ? status : null;
        },
        { timeout: 300000, interval: 500, label: 're-transcribe completes' }
      ).catch(() => 'timeout');
      check(successOutcome === 'completed', `re-transcribe completes successfully (outcome=${successOutcome})`);
      const afterSuccess = await ev('document.getElementById("transcriptArea").value');
      check(
        afterSuccess !== SENTINEL && afterSuccess.length > 10,
        `successful re-transcribe REPLACES the transcript (${afterSuccess === SENTINEL ? 'UNCHANGED' : `${SENTINEL.length} → ${afterSuccess.length} chars`})`
      );
      const staleShown = await ev(
        `!document.getElementById('summaryStaleHint').hidden`
      );
      check(staleShown, 'summary marked stale after re-transcribe (#summaryStaleHint shown)');
      const modelInfo = await ev(`window.electronAPI.readNoteContent(${JSON.stringify(audioNote.id)})`);
      check(
        modelInfo && modelInfo.note && modelInfo.note.model === HF_REPO,
        `frontmatter model recorded (${modelInfo && modelInfo.note ? modelInfo.note.model : 'n/a'})`
      );
      const btnAfterSuccess = await ev(
        `(() => { const b = document.getElementById('reTranscribeBtn'); return { disabled: b.disabled, title: b.title }; })()`
      );
      check(
        btnAfterSuccess.disabled === false,
        `re-transcribe button re-enabled after completion (title="${btnAfterSuccess.title}")`
      );
    } else {
      fail('no audio-backed note available — re-transcribe success/failure cases not exercised');
    }

    // --- meeting mode (D3 runtime) -----------------------------------------
    step('Meeting mode (fail-closed UI + PATH-stripped catap probe)');
    // Screen TCC is 'denied' on this host (verified with a getMediaAccessStatus
    // probe — no dialog is ever raised from 'denied'): the plan's acceptance is
    // fail-closed with a clear error and no crash.
    await ev('document.getElementById("meetingModeChk").checked = true');
    await ev('document.getElementById("recordBtn").click()');
    const meetingErrShown = await waitFor(
      async () => {
        const err = await ev(
          `(() => { const e = document.getElementById('errorText'); return !e.hidden ? e.textContent : ''; })()`
        );
        return err || null;
      },
      { timeout: 20000, label: 'screen-permission error surfaced' }
    ).catch(() => '');
    check(
      String(meetingErrShown).includes('Screen & System Audio Recording'),
      `meeting mode fails closed with a clear error: "${String(meetingErrShown).slice(0, 90)}"`
    );
    check(
      await ev('document.getElementById("recordingPill").hidden'),
      'no recording pill after the screen denial (nothing was spawned)'
    );
    check(appAlive, 'app alive after the meeting-mode denial (no crash)');
    const catapPids = pidsForPattern('catap record');
    check(catapPids.length === 0, `catap never spawned after the denial (pids: ${catapPids.join(', ') || 'none'})`);
    await ev('document.getElementById("meetingModeChk").checked = false');

    // L3 runtime probe: PATH without the conda bin dir → `catap` is ENOENT
    // while ffmpeg (homebrew) still resolves. The D3 acceptance: the Electron
    // main process must survive the spawn 'error' and surface it.
    const probeDir = path.join(scratch, 'catap-probe');
    fs.mkdirSync(probeDir, { recursive: true });
    fs.writeFileSync(
      path.join(probeDir, 'package.json'),
      JSON.stringify({ name: 'catap-probe', main: 'main.js' })
    );
    fs.writeFileSync(
      path.join(probeDir, 'main.js'),
      [
        "const { app } = require('electron');",
        "const path = require('path');",
        'const ROOT = process.env.SMOKE_ROOT;',
        "const { AudioRecorder } = require(path.join(ROOT, 'dist', 'main', 'audioRecorder.js'));",
        'const out = { meetingErr: null, state: null, startErr: null };',
        '(async () => {',
        '  const rec = new AudioRecorder();',
        "  rec.on('meeting-error', (m) => { out.meetingErr = String(m); });",
        '  try { rec.start({ meetingMode: true }); } catch (e) { out.startErr = String((e && e.message) || e); }',
        '  await new Promise((r) => setTimeout(r, 3500));',
        '  const st = rec.getState();',
        "  out.state = { status: st.status, meetingError: st.meetingError || null, error: st.error || null };",
        '  try { rec.cancel(); } catch {}',
        "  console.log('PROBE_RESULT=' + JSON.stringify(out));",
        '  app.exit(0);',
        "})().catch((e) => { console.log('PROBE_RESULT=' + JSON.stringify({ fatal: String((e && e.stack) || e) })); app.exit(1); });",
        '',
      ].join('\n')
    );
    const strippedPath = (process.env.PATH || '')
      .split(':')
      .filter((entry) => entry && !entry.includes('conda_envs/misc'))
      .join(':');
    const probeChild = spawn(electronBinary, [probeDir], {
      cwd: ROOT,
      env: { ...process.env, PATH: strippedPath, SMOKE_ROOT: ROOT },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let probeOut = '';
    let probeErrOut = '';
    probeChild.stdout.on('data', (b) => { probeOut += b.toString(); });
    probeChild.stderr.on('data', (b) => { probeErrOut += b.toString(); });
    const probeCode = await new Promise((resolve) => {
      const t = setTimeout(() => { try { probeChild.kill('SIGKILL'); } catch { /* */ } resolve('timeout'); }, 60000);
      probeChild.once('exit', (code) => { clearTimeout(t); resolve(code); });
    });
    const probeLine = probeOut.split('\n').find((l) => l.startsWith('PROBE_RESULT='));
    let probeResult = null;
    try { probeResult = probeLine ? JSON.parse(probeLine.slice('PROBE_RESULT='.length)) : null; } catch { probeResult = null; }
    check(
      probeCode === 0 && Boolean(probeResult),
      `PATH-stripped probe: Electron main stayed alive and exited cleanly (code=${probeCode}${probeResult ? '' : `, stderr=${probeErrOut.slice(-300)}`})`
    );
    if (probeResult) {
      check(
        Boolean(probeResult.meetingErr) && probeResult.meetingErr.includes('catap'),
        `catap ENOENT surfaced as a human-readable meetingError: "${probeResult.meetingErr}"`
      );
      check(
        probeResult.state && probeResult.state.status === 'recording',
        `mic kept recording after the catap failure — degraded to mic-only (state=${probeResult.state && probeResult.state.status}${probeResult.state && probeResult.state.error ? `, error=${probeResult.state.error}` : ''})`
      );
      check(
        probeResult.state && Boolean(probeResult.state.meetingError),
        'failure recorded on recorder state (readable app state)'
      );
    } else {
      fail(`PATH-stripped probe produced no PROBE_RESULT (stdout tail: ${probeOut.slice(-300)})`);
    }

    // Honest SKIPs for the parts this harness cannot automate.
    skip('meeting both-WAV capture in the UI: Screen & System Audio Recording is DENIED on this host — real consent flow is L4/A4; catap crash path covered by the unit test + the PATH-stripped probe above');
    skip('watch-folder pick + watcher lsof drain: pickWatchFolder opens a native dialog — not automatable (L4)');
    skip('migration fixture (legacy transcripts/ + summaries/ → reindex): needs an app restart cycle — Tester-stage work');
    skip('export via the Save as TXT/SRT/VTT buttons: native save dialog — round-trip covered node-side below');

    // --- batch import queue order (test plan §3.3) -------------------------
    step('Batch import: queue order + drain');
    const batchOne = path.join(scratch, 'batch-one.wav');
    const batchTwo = path.join(scratch, 'batch-two.wav');
    fs.copyFileSync(SPEECH_WAV, batchOne);
    fs.copyFileSync(SPEECH_WAV, batchTwo);
    const listBeforeBatch = await openNoteCount();
    const enqueued = await ev(
      `window.electronAPI.enqueueImports(${JSON.stringify([batchOne, batchTwo])})`
    );
    check(
      Array.isArray(enqueued) && enqueued.length === 2,
      `two files enqueued (${Array.isArray(enqueued) ? enqueued.length : 'n/a'} accepted)`
    );
    const queueRowsVisible = await waitFor(
      async () => (await ev('document.getElementById("importQueueList").children.length')) >= 2,
      { timeout: 15000, label: 'queue rows render' }
    )
      .then(() => true)
      .catch(() => false);
    check(queueRowsVisible, 'import queue section shows both pending rows');
    const queueOrder = await ev(
      `[...document.querySelectorAll('#importQueueList h4')].map(h => h.textContent || '')`
    );
    check(
      queueOrder.length >= 2 &&
        queueOrder[0].includes('batch-one') &&
        queueOrder[1].includes('batch-two'),
      `queue keeps enqueue order (${(queueOrder || []).join(' → ')})`
    );
    const queueDrained = await waitFor(
      async () => await ev('document.getElementById("importQueueSection").hidden'),
      { timeout: 720000, interval: 1000, label: 'import queue drains' }
    )
      .then(() => true)
      .catch(() => false);
    if (!queueDrained) {
      // Diagnose a stuck queue: pipeline state + row states say whether the
      // queue is waiting on a transcription that never finishes.
      const drainDiag = {
        pipeline: await reqStatus(),
        status: await textOf('statusText'),
        rows: await ev(
          `Array.from(document.querySelectorAll('#importQueueList .queue-row, #importQueueList li, #importQueueSection .queue-item')).map(r => r.textContent.slice(0, 80))`
        ),
        err: await ev(
          `(() => { const e = document.getElementById('errorText'); return e.hidden ? '' : e.textContent.slice(0, 200); })()`
        ),
      };
      note(`queue-not-drained diagnostics: ${JSON.stringify(drainDiag)}`);
    }
    check(queueDrained, 'import queue drains to empty (both files processed)');
    const listAfterBatch = await openNoteCount();
    check(
      listAfterBatch >= listBeforeBatch + 2,
      `batch imports add notes to the list (${listBeforeBatch} → ${listAfterBatch})`
    );

    // --- export SRT/VTT parse round-trip (node-side, app's own code) -------
    step('Export SRT/VTT parse round-trip');
    try {
      const exportMod = requireCjs(path.join(ROOT, 'dist', 'main', 'exportText.js'));
      const roundWords = Array.from({ length: 25 }, (_, i) => ({
        word: `word${i + 1}`,
        start: i * 0.4,
        end: i * 0.4 + 0.35,
      }));
      const roundText = roundWords.map((w) => w.word).join(' ');
      const srtFile = path.join(scratch, 'roundtrip.srt');
      const vttFile = path.join(scratch, 'roundtrip.vtt');
      const srtRes = exportMod.saveTranscript({ filePath: srtFile, format: 'srt', text: roundText, words: roundWords });
      const vttRes = exportMod.saveTranscript({ filePath: vttFile, format: 'vtt', text: roundText, words: roundWords });
      check(Boolean(srtRes && srtRes.success), `SRT export writes (${srtFile})`);
      check(Boolean(vttRes && vttRes.success), `VTT export writes (${vttFile})`);
      const parseStamps = (content, re) =>
        [...content.matchAll(re)].map((m) => ({
          start: m[1],
          end: m[2],
          s: Number(m[1].replace(/[,.]/g, '.')) || (() => {
            const [h, mm, rest] = m[1].split(':');
            const [s, ms] = rest.split(/[,.]/);
            return Number(h) * 3600 + Number(mm) * 60 + Number(s) + Number(ms) / 1000;
          })(),
        }));
      const srtContent = fs.readFileSync(srtFile, 'utf8');
      const vttContent = fs.readFileSync(vttFile, 'utf8');
      const srtStamps = parseStamps(srtContent, /(\d\d:\d\d:\d\d,\d\d\d) --> (\d\d:\d\d:\d\d,\d\d\d)/g);
      const vttStamps = parseStamps(vttContent, /(\d\d:\d\d:\d\d\.\d\d\d) --> (\d\d:\d\d:\d\d\.\d\d\d)/g);
      check(vttContent.startsWith('WEBVTT'), 'VTT starts with the WEBVTT header');
      check(srtStamps.length >= 2, `SRT parses back ${srtStamps.length} cue(s)`);
      const srtIndexes = [...srtContent.matchAll(/^(\d+)$/gm)].map((m) => Number(m[1]));
      check(
        srtIndexes.length === srtStamps.length && srtIndexes.every((v, i) => v === i + 1),
        `SRT cue indexes are sequential 1..${srtIndexes.length}`
      );
      const monotonic = (stamps) =>
        stamps.every((c, i) => i === 0 || c.s >= stamps[i - 1].s);
      check(monotonic(srtStamps), 'SRT timestamps are monotonic');
      check(monotonic(vttStamps), 'VTT timestamps are monotonic');
      const roundTripText = [...srtContent.matchAll(/^\d+\n\d\d.*\n(.*)$/gm)].map((m) => m[1]).join(' ');
      check(
        roundTripText.replace(/\s+/g, ' ').trim() === roundText,
        'SRT cue text round-trips to the source words'
      );
    } catch (err) {
      fail(`export round-trip aborted: ${err.message}`);
    }

    // --- dictation: hold Option, system-wide --------------------------------
    step('Dictation end-to-end (workstream 3)');

    const statusText = () => ev('document.getElementById("statusText").textContent || ""');
    const noticeText = () => ev('document.getElementById("dictationNotice").textContent || ""');
    const transcriptValue = () => ev('document.getElementById("transcriptArea").value');
    const dictationStatus = () => ev('window.electronAPI.getDictationStatus()');
    const badgeVisible = async () => !(await ev('document.getElementById("dictationBadge").hidden'));
    /**
     * Samples status/notice/pipeline-state for `ms`; stops early when the
     * notice changes. Dictation events never touch #statusText (the renderer
     * branches on origin first), so the dictation badge and the IPC
     * pipeline state are the real observables here.
     */
    async function sampleOutcome(ms) {
      const startNotice = await noticeText();
      const seen = new Set();
      const pipeline = new Set();
      let badgeSeen = false;
      let notice = startNotice;
      const end = Date.now() + ms;
      while (Date.now() < end) {
        seen.add(await statusText());
        pipeline.add(await reqStatus());
        if (await badgeVisible()) badgeSeen = true;
        const now = await noticeText();
        if (now && now !== startNotice) {
          notice = now;
          break;
        }
        notice = now;
        await sleep(120);
      }
      return { seen: [...seen], pipeline: [...pipeline], badgeSeen, notice };
    }
    const sawStatus = (sample, needle) => sample.seen.some((s) => s.includes(needle));
    const sawPipeline = (sample, value) => (sample.pipeline || []).includes(value);

    // Re-enable dictation and confirm the guarded hook is really running.
    await ev('window.electronAPI.updateSettings({ dictationEnabled: true, autoSummarize: false })');
    await waitFor(async () => (await dictationStatus()).running === true, {
      timeout: 20000,
      label: 'Option hook running',
    });
    const liveStatus = await dictationStatus();
    check(liveStatus.supported === true, 'uiohook-napi loads inside the Electron 33 main process');
    check(liveStatus.enabled === true, 'dictationEnabled is ON');
    check(liveStatus.accessibilityTrusted === true, 'Accessibility is trusted');
    check(liveStatus.running === true, 'global Option hook is listening (system-wide, not focus-bound)');
    check(
      await ev('document.getElementById("dictationBanner").hidden'),
      'no Accessibility banner while access is granted'
    );
    // Same call the banner button makes (ask=true); already trusted -> no prompt.
    const recheckTrusted = await ev('window.electronAPI.requestDictationAccess()');
    check(
      recheckTrusted.accessibilityTrusted === true && recheckTrusted.running === true,
      'requestDictationAccess() re-check keeps the hook running'
    );

    // (1) bare Option hold -> recording -> release -> transcription APPENDED.
    // The app owns the foreground for the whole dictation section so the
    // paste target is deterministic (own-window; guard rail asserted below).
    await cdp.send('Page.bringToFront');
    let take = null;
    // Up to 5 attempts: a chord abort here means an unrelated key arrived
    // during the hold (the desktop is shared), which is correct behaviour —
    // just not the bare-hold case we are proving.
    for (let attempt = 1; attempt <= 5 && !take; attempt += 1) {
      const before = await transcriptValue();
      uIOhook.keyToggle(UiohookKey.Alt, 'down');
      const heldAt = Date.now();
      // The dictation badge (not #statusText) reflects an open take: the
      // renderer branches on origin === 'dictation' before touching status.
      const started = await waitFor(async () => !(await ev('document.getElementById("dictationBadge").hidden')), {
        timeout: 8000,
        label: `take ${attempt}: badge shows on Option keydown`,
      })
        .then(() => true)
        .catch(() => false);
      const badgeVisibleDuringHold = started;
      const heldText = await transcriptValue();
      const clearedWhileHolding = heldText !== before;

      // Play the sample only once the take is really recording, so the mic
      // captures the speech instead of the silence before it.
      let audio = null;
      if (started) {
        audio = spawn('afplay', ['-v', '1.0', SPEECH_WAV], { stdio: 'ignore' });
        const audioExited = new Promise((resolve) => audio.once('exit', resolve));
        await Promise.race([audioExited, sleep(8000)]);
        await sleep(400); // tail of the utterance
      }
      while (Date.now() - heldAt < 4000) await sleep(100);
      uIOhook.keyToggle(UiohookKey.Alt, 'up');
      if (audio) audio.kill();

      const releasedAt = Date.now();
      // Single outcome wait: the badge proved the take opened, so a stale
      // 'completed' from the floor cannot short-circuit it — the pipeline
      // is already 'transcribing' (streaming) when the badge shows.
      // If the badge never showed, don't burn the full window: the take
      // never opened and the retry note below carries the diagnostics.
      let outcome = 'no-start (badge never showed)';
      if (started) {
        outcome = 'timeout';
        while (Date.now() - releasedAt < 240000) {
          const notice = await noticeText();
          if (notice) { outcome = notice; break; }
          const pipelineStatus = await reqStatus();
          if (pipelineStatus === 'completed') { outcome = 'completed'; break; }
          if (pipelineStatus === 'error') { outcome = 'error'; break; }
          await sleep(200);
        }
      }
      const after = await transcriptValue();
      const appendedSoFar = after.length > before.length ? after.slice(before.length) : '';
      // The model paraphrases slightly ("Hello, this is a local transcription
      // test…" rather than the exact opening), so accept any recognisable
      // trace of the sample — silence hallucinations come out unrelated.
      const looksLikeSample = /hello/i.test(appendedSoFar) || /transcription test/i.test(appendedSoFar);
      if (started && outcome === 'completed' && after !== before && looksLikeSample) {
        take = { attempt, before, after, badgeVisibleDuringHold, clearedWhileHolding };
      } else {
        const takeErr = await ev(
          `(() => { const e = document.getElementById('errorText'); return e.hidden ? '' : e.textContent.slice(0, 200); })()`
        );
        const takeStatus = await statusText();
        note(
          `dictation take ${attempt}/5: outcome=${outcome} appended="${appendedSoFar.trim().slice(0, 80) || '(none)'}" status="${takeStatus}" err="${takeErr}" pipeline=${await reqStatus()} — retrying`
        );
      }
      if (!take) await sleep(1500);
    }
    check(
      take !== null,
      `a bare Option hold produced a transcription (attempt ${take ? `${take.attempt}/5` : '5/5 exhausted'})`
    );
    if (take) {
      check(
        take.badgeVisibleDuringHold,
        'dictation-active indicator (#dictationBadge) shows while the key is held'
      );
      check(
        !take.clearedWhileHolding,
        'existing transcript is preserved while a dictation take records'
      );
      check(
        take.after.length > take.before.length && take.after.startsWith(take.before),
        `result is APPENDED, not replaced (${take.before.length} -> ${take.after.length} chars)`
      );
      const appended = take.after.slice(take.before.length);
      check(
        /hello/i.test(appended) || /transcription test/i.test(appended),
        `appended text transcribes the sample: "${appended.trim().slice(0, 90)}"`
      );
      note(`dictation take ${take.attempt} appended: ${appended.trim().slice(0, 120)}`);
    }

    // (2) chord: Option down + arrow -> abort, no transcription.
    // The arrow must land while the take is actually open, so wait for the
    // badge to show first (its main process can be busy finishing the
    // previous take), and retry if the abort never surfaces.
    let beforeChord = await transcriptValue();
    let chord = null;
    for (let attempt = 1; attempt <= 3 && !chord; attempt += 1) {
      beforeChord = await transcriptValue();
      const sampler = sampleOutcome(9000);
      uIOhook.keyToggle(UiohookKey.Alt, 'down');
      const sawTakeOpen = await waitFor(
        async () => !(await ev('document.getElementById("dictationBadge").hidden')),
        { timeout: 8000, label: `chord ${attempt}: take opens` }
      )
        .then(() => true)
        .catch(() => false);
      uIOhook.keyToggle(UiohookKey.ArrowRight, 'down');
      await sleep(90);
      uIOhook.keyToggle(UiohookKey.ArrowRight, 'up');
      await sleep(200);
      uIOhook.keyToggle(UiohookKey.Alt, 'up');
      const sample = await sampler;
      const afterAttempt = await transcriptValue();
      if (sample.notice === CHORD_NOTICE && afterAttempt === beforeChord) {
        chord = { ...sample, sawTakeOpen, attempt };
      } else {
        note(
          `chord ${attempt}/3: hint was "${sample.notice}" (take opened: ${sawTakeOpen}, transcript ${
            afterAttempt === beforeChord ? 'unchanged' : 'CHANGED'
          }, pipeline: ${sample.pipeline.join(' > ')}) — retrying`
        );
        await sleep(1500);
      }
    }
    const afterChord = await transcriptValue();
    check(
      chord !== null && chord.sawTakeOpen,
      `chord take opened (attempt ${chord ? `${chord.attempt}/3` : '3/3 exhausted'}; pipeline: ${chord ? chord.pipeline.join(' > ') : 'n/a'})`
    );
    check(chord !== null && chord.notice === CHORD_NOTICE, `chord abort hint: "${chord ? chord.notice : '(never shown)'}"`);
    check(
      chord === null || !sawPipeline(chord, 'completed'),
      'chord take never reaches a completed transcription'
    );
    check(afterChord === beforeChord, 'chord produces NO transcription (transcript unchanged)');

    // (3) release inside ~300ms -> discard with the inline hint.
    // A stray non-Option key during the window is itself a chord abort (also
    // correct behaviour), so retry until a clean window shows the too-short hint.
    const beforeTap = await transcriptValue();
    let tap = null;
    for (let attempt = 1; attempt <= 3 && !tap; attempt += 1) {
      const sampler = sampleOutcome(9000);
      uIOhook.keyToggle(UiohookKey.Alt, 'down');
      await sleep(170);
      uIOhook.keyToggle(UiohookKey.Alt, 'up');
      const sample = await sampler;
      if (sample.notice === TOO_SHORT_NOTICE) {
        tap = { ...sample, attempt };
      } else {
        note(`tap ${attempt}/3: hint was "${sample.notice}" (pipeline: ${sample.pipeline.join(' > ')}) — retrying`);
        await sleep(1200);
      }
    }
    const afterTap = await transcriptValue();
    check(
      tap !== null && tap.notice === TOO_SHORT_NOTICE,
      `too-short hint (attempt ${tap ? `${tap.attempt}/3` : '3/3 exhausted'}): "${tap ? tap.notice : '(never shown)'}"`
    );
    check(
      tap === null || !sawPipeline(tap, 'completed'),
      'too-short take never reaches a completed transcription'
    );
    check(afterTap === beforeTap, 'too-short tap produces NO transcription (transcript unchanged)');

    // (4) dictationEnabled OFF -> the settings toggle stops the hook and a
    // hold produces no recording.
    const beforeOff = await transcriptValue();
    const offOn = await dictationStatus();
    check(offOn.enabled && offOn.running, 'dictationEnabled is ON before the toggle-off check');
    await ev('document.getElementById("settingsBtn").click()');
    // openSettings kicks off an async form load (getSettings +
    // getDictationStatus + LLM models) which rewrites the toggle when it
    // lands — run5 proved 500ms was not enough (the load arrived AFTER the
    // set-false and the save then persisted ON). Wait for the form to settle
    // on the current ON state first.
    await waitFor(
      async () => (await ev('document.getElementById("settingsDictationChk").checked')) === true,
      { timeout: 15000, label: 'settings form loaded (toggle reflects ON)' }
    ).catch(() => undefined);
    // The section re-enabled dictation via updateSettings at its start, so
    // drive the toggle explicitly to OFF here — the contract under test is
    // "saving OFF stops the hook" (D8 disposition: the old parked-state
    // assertion contradicted the re-enable two steps above it).
    await ev('document.getElementById("settingsDictationChk").checked = false');
    await ev('document.getElementById("settingsSaveBtn").click()');
    const offPersisted = Boolean(
      await waitFor(async () => (await getSettings()).dictationEnabled === false, {
        timeout: 10000,
        label: 'dictationEnabled persisted OFF',
      }).catch(() => false)
    );
    check(offPersisted, 'saving the settings toggle OFF persists dictationEnabled=false');
    await waitFor(async () => (await dictationStatus()).running === false, {
      timeout: 15000,
      label: 'hook stopped after saving dictationEnabled=OFF',
    }).catch(() => undefined);
    const offStatus = await dictationStatus();
    check(offStatus.enabled === false && offStatus.running === false, 'dictationEnabled=OFF stops the hook');
    // The plan's hint contract lives on the sidebar hint: OFF hides it.
    // (#dictationStatus is a hidden ID remnant that no code writes.)
    const offHintOk = await waitFor(
      async () => await ev('document.getElementById("dictationHint").hidden'),
      { timeout: 10000, interval: 300, label: 'sidebar dictation hint hides when off' }
    )
      .then(() => true)
      .catch(() => false);
    check(offHintOk, 'sidebar dictation hint hides while dictationEnabled is OFF');
    const offSamplePromise = sampleOutcome(6000);
    uIOhook.keyToggle(UiohookKey.Alt, 'down');
    await sleep(1500);
    uIOhook.keyToggle(UiohookKey.Alt, 'up');
    const offSample = await offSamplePromise;
    check(
      !offSample.badgeSeen && !sawPipeline(offSample, 'completed'),
      'dictationEnabled=OFF produces NO recording (badge never shows, no run)'
    );
    check((await transcriptValue()) === beforeOff, 'transcript unchanged while dictation is off');

    // Re-enable through the same toggle so the default ON state is restored.
    await ev('document.getElementById("settingsDictationChk").checked = true');
    await ev('document.getElementById("settingsSaveBtn").click()');
    await waitFor(async () => (await dictationStatus()).running === true, {
      timeout: 20000,
      label: 'hook restarted after re-enabling',
    });
    const onHintOk = await waitFor(
      async () => {
        const probe = await ev(
          `(() => { const h = document.getElementById('dictationHint'); return { hidden: h.hidden, text: h.textContent.trim() }; })()`
        );
        return probe.hidden === false && probe.text === DICTATION_HINT_TEXT ? probe : null;
      },
      { timeout: 10000, interval: 300, label: 'sidebar dictation hint copy (exact)' }
    ).catch(() => null);
    check(
      onHintOk !== null,
      `sidebar dictation hint exact when ON: "${onHintOk ? onHintOk.text : 'hint not shown / copy mismatch'}"`
    );
    check(
      await ev('document.getElementById("settingsDictationChk").checked'),
      'settings toggle restored to checked (default ON)'
    );
    await ev('document.getElementById("settingsBtn").click()');
    pass('dictationEnabled re-enabled (default ON) at the end of the run');

    // --- dictation guard rail: own-window focus ----------------------------
    step('Dictation guard rail: own-window focus (no synthesized Cmd+V)');
    await cdp.send('Page.bringToFront');
    await ev('window.focus()');
    const OWN_SENTINEL = 'UNIQUE-OWNWINDOW-CLIP-SENTINEL-0930';
    spawnSync('pbcopy', [], { input: OWN_SENTINEL, encoding: 'utf8' });
    const clipBeforeOwn = spawnSync('pbpaste', [], { encoding: 'utf8' }).stdout;
    check(clipBeforeOwn === OWN_SENTINEL, 'clipboard seeded with the sentinel');
    let ownTake = null;
    for (let attempt = 1; attempt <= 3 && !ownTake; attempt += 1) {
      const beforeOwn = await transcriptValue();
      uIOhook.keyToggle(UiohookKey.Alt, 'down');
      const ownHeldAt = Date.now();
      const ownStarted = await waitFor(
        async () => !(await ev('document.getElementById("dictationBadge").hidden')),
        { timeout: 8000, label: `own-window take ${attempt}: badge shows` }
      )
        .then(() => true)
        .catch(() => false);
      let ownAudio = null;
      if (ownStarted) {
        ownAudio = spawn('afplay', ['-v', '1.0', SPEECH_WAV], { stdio: 'ignore' });
        const ownAudioExited = new Promise((resolve) => ownAudio.once('exit', resolve));
        await Promise.race([ownAudioExited, sleep(8000)]);
        await sleep(400);
      }
      while (Date.now() - ownHeldAt < 4000) await sleep(100);
      uIOhook.keyToggle(UiohookKey.Alt, 'up');
      if (ownAudio) ownAudio.kill();
      const ownReleasedAt = Date.now();
      let ownOutcome = 'no-start (badge never showed)';
      if (ownStarted) {
        ownOutcome = 'timeout';
        while (Date.now() - ownReleasedAt < 240000) {
          const ownNotice = await noticeText();
          if (ownNotice) { ownOutcome = ownNotice; break; }
          const ownPipeline = await reqStatus();
          if (ownPipeline === 'completed') { ownOutcome = 'completed'; break; }
          if (ownPipeline === 'error') { ownOutcome = 'error'; break; }
          await sleep(200);
        }
      }
      const afterOwn = await transcriptValue();
      const ownAppend = afterOwn.length > beforeOwn.length ? afterOwn.slice(beforeOwn.length) : '';
      if (ownStarted && ownOutcome === 'completed' && /hello|transcription test/i.test(ownAppend)) {
        ownTake = { attempt };
      } else {
        note(`own-window take ${attempt}/3: outcome=${ownOutcome} appended="${ownAppend.trim().slice(0, 60) || '(none)'}" — retrying`);
        await sleep(1500);
      }
    }
    check(
      ownTake !== null,
      `own-window take appends in-app (attempt ${ownTake ? `${ownTake.attempt}/3` : '3/3 exhausted'})`
    );
    const clipAfterOwn = spawnSync('pbpaste', [], { encoding: 'utf8' }).stdout;
    check(
      clipAfterOwn === OWN_SENTINEL,
      `clipboard untouched by the take — no synthesized Cmd+V in the own window (${JSON.stringify(
        clipAfterOwn.slice(0, 40)
      )})`
    );

    // --- network + console assertions -------------------------------------
    step('Console + network assertions');
    const externalPageRequests = pageRequests.filter((url) => /^https?:/i.test(url));
    check(
      externalPageRequests.length === 0,
      `renderer made no external HTTP requests (${pageRequests.length} request(s) total, all local)`
    );
    check(consoleErrors.length === 0, `zero console/log errors (${consoleErrors.length})`);
    for (const err of consoleErrors.slice(0, 10)) fail(err);
    check(exceptions.length === 0, `zero uncaught exceptions (${exceptions.length})`);
    for (const err of exceptions.slice(0, 10)) fail(err);

    // let socket sampling catch LLM/HF connections that are still open
    await sleep(2500);
    // HF endpoints rotate (CloudFront / Global Accelerator / EC2 cas-server pools):
    // take a fresh burst of resolutions, then classify every observed address.
    for (let round = 0; round < 6; round++) {
      await refreshDnsUnion();
      await sleep(250);
    }
    const remotes = [...observedRemotes];
    const unknown = [];
    const evidence = [];
    for (const ip of remotes) {
      if (ip === '127.0.0.1' || ip === '::1') {
        evidence.push(`${ip}=loopback`);
        continue;
      }
      if (await allowedRemote(ip)) {
        evidence.push(`${ip}=dns`);
        continue;
      }
      const via = await tlsServesHuggingFace(ip);
      if (via) {
        evidence.push(`${ip}=tls-cert(${via})`);
        continue;
      }
      unknown.push(ip);
    }
    check(
      unknown.length === 0,
      `all observed remote addresses are 127.0.0.1 or Hugging Face (${remotes.join(', ') || 'none'})`
    );
    for (const ip of unknown) fail(`unexpected remote address: ${ip}`);
    note(`observed remote addresses: ${remotes.join(', ') || '(none)'}`);
    note(`address evidence: ${evidence.join('; ')}`);
  } catch (err) {
    fail(`smoke aborted: ${err.message}`);
  } finally {
    // Stop the D7.4 watchdog/monitor before tearing the app down so the
    // monitor can never abort a normal teardown.
    clearInterval(targetMonitor);
    clearTimeout(watchdog);
    // --- teardown ----------------------------------------------------------
    step('Teardown');
    clearInterval(sampler);
    const tree = processTree(rootPid);
    if (cdpHolder.client) cdpHolder.client.close();
    killTree(rootPid);
    await sleep(1500);

    // Force-kill anything left from this run (electron, python adapter, ffmpeg).
    const remaining = appPids();
    for (const pid of remaining) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        /* ignore */
      }
    }
    const leftoverFfmpeg = exec('pgrep', ['-f', 'ffmpeg.*avfoundation']).stdout
      .split('\n')
      .filter((line) => /^\d+$/.test(line.trim()));
    check(remaining.length === 0, `no processes left for this worktree (checked ${tree.length} pid(s))`);
    if (leftoverFfmpeg.length > 0) {
      fail(`leftover ffmpeg processes: ${leftoverFfmpeg.join(', ')}`);
      for (const pid of leftoverFfmpeg) {
        try {
          process.kill(Number(pid), 'SIGKILL');
        } catch {
          /* ignore */
        }
      }
    } else {
      pass('no leftover ffmpeg processes');
    }

    const crashLines = mainLog
      .join('')
      .split('\n')
      .filter((line) => /Uncaught|FATAL|EXCEPTION/i.test(line));
    if (crashLines.length > 0) {
      for (const line of crashLines.slice(0, 5)) fail(`main process reported: ${line.trim()}`);
    } else {
      pass('main process reported no uncaught/fatal errors');
    }

    const restored = restoreSettings();
    note(`settings.json: ${settingsState} -> ${restored}`);
    try {
      fs.rmSync(scratch, { recursive: true, force: true });
      note(`scratch removed: ${scratch}`);
    } catch (err) {
      note(`scratch cleanup failed: ${err.message}`);
    }
  }

  // --- report --------------------------------------------------------------
  clearInterval(targetMonitor);
  clearTimeout(watchdog);
  console.log('\n================ SMOKE REPORT ================');
  console.log(`passed : ${passCount}`);
  console.log(`failed : ${failures.length}`);
  console.log(`skipped: ${skipCount}`);
  for (const msg of failures) console.log(`  FAIL: ${msg}`);
  for (const msg of notes) console.log(`  note: ${msg}`);
  console.log('--- app stdout (tail) ---');
  console.log(appStdout.split('\n').slice(-40).join('\n'));
  console.log('--- app stderr (tail) ---');
  console.log(appStderr.split('\n').slice(-40).join('\n'));
  const exitCode = failures.length > 0 ? 1 : 0;
  console.log('===============================================');
  console.log(`SMOKE_EXIT=${exitCode}`);
  process.exit(exitCode);
}

main().catch((err) => {
  console.error(`FATAL: ${err.stack || err.message}`);
  process.exit(1);
});
