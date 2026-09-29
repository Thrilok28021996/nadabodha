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

function pass(msg) {
  passCount += 1;
  console.log(`  PASS  ${msg}`);
}
function fail(msg) {
  failures.push(msg);
  console.error(`  FAIL  ${msg}`);
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
  const left = document.querySelector('.col-left');
  const right = document.querySelector('.col-right');
  const visible = {};
  for (const id of ['recordBtn', 'stopRecordBtn', 'importBtn', 'cancelBtn', 'statusText', 'dictationHint', 'tabTranscript', 'tabSummary', 'transcriptArea', 'copyBtn', 'saveBtn']) {
    const el = document.getElementById(id);
    if (!el) { visible[id] = null; continue; }
    const r = el.getBoundingClientRect();
    visible[id] = r.width > 0 && r.height > 0 && r.top >= -0.5 && r.left >= -0.5 && r.bottom <= innerHeight + 0.5 && r.right <= innerWidth + 0.5;
  }
  return {
    outer: { w: outerWidth, h: outerHeight },
    inner: { w: innerWidth, h: innerHeight },
    doc: { sw: document.documentElement.scrollWidth, sh: document.documentElement.scrollHeight },
    columns: left && right ? { left: rect(left), right: rect(right) } : null,
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

/** True when the layout probe shows no overflow and no column overlap. */
function layoutHealthy(probe) {
  if (!probe || !probe.columns) return false;
  const { left, right } = probe.columns;
  if (left.x + left.w > right.x + 1) return false; // columns overlap / wrap
  if (left.y > right.y + right.h + 1) return false; // stacked, not side by side
  if (probe.doc.sw > probe.inner.w + 1) return false; // horizontal overflow
  if (probe.doc.sh > probe.inner.h + 1) return false; // vertical overflow
  return Object.entries(probe.visible).every(([, ok]) => ok === true);
}

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
    check(banner.exists && banner.hidden === false, 'accessibility banner is visible');
    check(banner.text.includes(ACCESSIBILITY_BANNER), `banner copy: "${banner.text}"`);

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

    await ev('document.getElementById("dictationGrantBtn").click()');
    const engaged = await waitFor(
      async () => (await ev('document.getElementById("dictationGrantBtn").disabled')) === true,
      { timeout: 5000, label: 'grant button polling' }
    ).catch(() => false);
    check(Boolean(engaged), 'grant button starts its re-check loop');

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
  child.stdout.on('data', (buf) => mainLog.push(buf.toString()));
  child.stderr.on('data', (buf) => mainLog.push(buf.toString()));
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

  try {
    // --- boot --------------------------------------------------------------
    step('Wait for renderer');
    await waitFor(
      async () =>
        (await ev('document.readyState')) === 'complete' && (await ev('!!window.electronAPI')),
      { timeout: 30000, label: 'renderer ready' }
    );
    pass('renderer ready with electronAPI exposed');

    // --- open settings -----------------------------------------------------
    // The pre-existing floor from earlier cycles is wrapped so that one failing
    // floor step still lets the layout / markdown / dictation sections below
    // run. Failures are still recorded and the process still exits non-zero.
    try {
    step('Open Settings panel');
    await ev('document.getElementById("settingsBtn").click()');
    check(!(await ev('document.getElementById("settingsPanel").hidden')), 'settings panel opens from the gear button');

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

    // Dictation defaults to ON in settingsStore. Park it through the real
    // toggle (uncheck the persisted checkbox) so the later settings saves in
    // this e2e keep it parked, then stop the hook over IPC.
    const bootSettings = await getSettings();
    check(bootSettings.dictationEnabled === true, 'dictationEnabled defaults to ON');
    await ev('document.getElementById("dictationEnabledChk").checked = false');
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
    } catch (err) {
      warmNote = `failed after ${((Date.now() - warmStartedAt) / 1000).toFixed(1)}s: ${err.message}`;
    }
    note(`LLM warm-up: ${warmNote}`);

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
    await waitFor(async () => (await textOf('settingsStatus')).includes('Saved with issues'), {
      timeout: 30000,
      label: 'save with validation error',
    });
    const saveIssueMsg = (await textOf('settingsStatus')).trim();
    check(saveIssueMsg.includes('not found'), `save reports the python issue inline: "${saveIssueMsg}"`);

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
    await waitFor(
      async () => (await ev('document.getElementById("hfResults").children.length')) > 0,
      { timeout: 45000, label: 'HF search results' }
    );
    const rowCount = await ev('document.getElementById("hfResults").children.length');
    check(rowCount > 0, `search returned ${rowCount} row(s)`);

    const targetRowText = await ev(
      `(() => { const row = document.querySelector('#hfResults [data-repo-id=${JSON.stringify(HF_REPO)}]');` +
        ' return row ? row.textContent : null; })()'
    );
    check(targetRowText !== null, `row for ${HF_REPO} is listed`);
    check(
      typeof targetRowText === 'string' && targetRowText.includes('CTranslate2'),
      `row shows format "CTranslate2": "${targetRowText}"`
    );
    check(
      typeof targetRowText === 'string' && targetRowText.includes('downloads'),
      'row shows download count'
    );

    // --- download ----------------------------------------------------------
    step('Download model with live progress');
    await ev(
      `(() => { const row = document.querySelector('#hfResults [data-repo-id=${JSON.stringify(
        HF_REPO
      )}]'); row.click(); return row.classList.contains('selected'); })()`
    );
    const downloadEnabled = await ev('!document.getElementById("hfDownloadBtn").disabled');
    check(downloadEnabled, 'selecting a supported model enables the Download button');

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
      if (current.includes('Downloaded ')) {
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
    const installedHasModel = await waitFor(
      async () =>
        ev(
          `Array.from(document.querySelectorAll('#hfInstalled [data-repo-id]')).some(el => el.dataset.repoId === ${JSON.stringify(
            HF_REPO
          )})`
        ),
      { timeout: 20000, label: 'installed row appears' }
    ).catch(() => false);
    check(installedHasModel, 'downloaded model appears under Installed');

    // Selecting the model and clicking Set active can race the download's
    // background refreshModels() re-render (the button can still be enabled
    // while the selection was never registered), so verify the selection stuck
    // and retry with diagnostics instead of failing blind.
    let useEnabled = false;
    let activeSaved = false;
    let selectNote = '';
    for (let attempt = 1; attempt <= 4 && !activeSaved; attempt += 1) {
      const selected = await ev(
        `(() => {
           const row = document.querySelector('#hfInstalled [data-repo-id=${JSON.stringify(HF_REPO)}]');
           if (row) row.click();
           return { installedRow: Boolean(row), status: (document.getElementById('hfStatus').textContent || '').trim() };
         })()`
      );
      if (!String(selected.status).includes(`Selected ${HF_REPO}`)) {
        // Fall back to the search-results row for the same repository.
        await ev(
          `(() => { const r = document.querySelector('#hfResults [data-repo-id=${JSON.stringify(HF_REPO)}]'); if (r) r.click(); return true; })()`
        );
      }
      const statusAfter = (await textOf('hfStatus')).trim();
      useEnabled = await ev('!document.getElementById("hfUseBtn").disabled');
      let statusAfterClick = '';
      if (statusAfter.includes(`Selected ${HF_REPO}`) && useEnabled) {
        await ev('document.getElementById("hfUseBtn").click()');
        await sleep(700); // catch the handler's own hint before any re-render
        statusAfterClick = (await textOf('hfStatus')).trim();
        activeSaved = Boolean(
          await waitFor(async () => (await getSettings()).activeModel === HF_REPO, {
            timeout: 8000,
            label: 'active model saved',
          }).catch(() => false)
        );
      }
      selectNote = `installedRow=${selected.installedRow} status=${JSON.stringify(
        statusAfter
      )} useEnabled=${useEnabled} afterClick=${JSON.stringify(statusAfterClick)}`;
      if (!activeSaved) {
        note(`set-active attempt ${attempt}: ${selectNote}`);
        await sleep(1500);
      }
    }
    check(useEnabled, 'installed row enables the Set active button');
    check(
      activeSaved,
      `active model = ${HF_REPO}` +
        `${activeSaved ? '' : ` [${selectNote} activeModel="${(await getSettings()).activeModel}"]`}`
    );
    const activeBadge = await waitFor(
      async () =>
        ev(
          `(() => { const row = document.querySelector('#hfInstalled [data-repo-id=${JSON.stringify(
            HF_REPO
          )}]'); return row ? row.textContent.includes('active') : false; })()`
        ),
      { timeout: 20000, label: 'active badge rendered' }
    ).catch(() => false);
    check(Boolean(activeBadge), 'Installed list marks the active model');

    // --- transcript end-to-end --------------------------------------------
    step('End-to-end transcription');
    await ev(`window.electronAPI.importAudio(${JSON.stringify(SPEECH_WAV)})`);
    await waitFor(
      async () => {
        const status = await textOf('statusText');
        const text = await ev('document.getElementById("transcriptArea").value');
        return status.includes('completed') && text.length > 0;
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
    const transcriptFile = transcriptPathShown.replace(/^Transcript:\s*/, '');
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
      `auto summary produced (${summary.length} chars): "${summary.slice(0, 100)}"` +
        `${autoSummaryState === 'ok' ? '' : ` [state=${autoSummaryState} status="${summaryStatusText}" error="${summaryErrorText}"]`}`
    );
    check(summaryStatusText.includes('Summary ready'), `summary status: "${summaryStatusText}"`);
    check((await textOf('summaryError')).trim() === '', 'no summary error shown');

    const summaryPathShown = (await textOf('savedSummaryPath')).trim();
    check(
      summaryPathShown.includes('summaries/summary_') && summaryPathShown.endsWith('.md'),
      `saved summary path surfaced: "${summaryPathShown}"`
    );
    const summaryFile = summaryPathShown.replace(/^Summary:\s*/, '');
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

    // --- two-column dark layout -------------------------------------------
    step('Two-column dark layout (workstream 1)');
    // Measure the default view: transcript tab active, settings folded away.
    await ev('document.getElementById("tabTranscript").click()');
    if (!(await ev('document.getElementById("settingsPanel").hidden'))) {
      await ev('document.getElementById("settingsBtn").click()');
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
    const cols = layout.columns || { left: { x: 0, w: 0 }, right: { x: 1e9, w: 0 } };
    check(
      Math.abs(layout.outer.w - DEFAULT_WINDOW.width) <= 2 &&
        Math.abs(layout.outer.h - DEFAULT_WINDOW.height) <= 2,
      `window default ${DEFAULT_WINDOW.width}x${DEFAULT_WINDOW.height} (outer ${layout.outer.w}x${layout.outer.h})`
    );
    check(layout.columns !== null, 'two columns (.col-left / .col-right) present');
    check(cols.left.x + cols.left.w <= cols.right.x + 1, 'columns sit side by side with no overlap');
    check(
      layout.doc.sw <= layout.inner.w + 1 && layout.doc.sh <= layout.inner.h + 1,
      `no page-level overflow at ${layout.inner.w}x${layout.inner.h}`
    );
    const clipped = Object.entries(layout.visible).filter(([, ok]) => ok !== true).map(([id]) => id);
    check(
      clipped.length === 0,
      `key controls fully inside the viewport (${clipped.length ? `clipped: ${clipped.join(', ')}` : 'none clipped'})`
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
    const minClipped = Object.entries(minLayout.visible).filter(([, ok]) => ok !== true).map(([id]) => id);
    check(
      minClipped.length === 0,
      `no clipped content at min size ${MIN_WINDOW.width}x${MIN_WINDOW.height}` +
        `${minClipped.length ? ` (clipped: ${minClipped.join(', ')})` : ''}`
    );
    check(
      minLayout.doc.sw <= minLayout.inner.w + 1 && minLayout.doc.sh <= minLayout.inner.h + 1,
      `no page overflow at min size (${minLayout.doc.sw}x${minLayout.doc.sh} vs ${minLayout.inner.w}x${minLayout.inner.h})`
    );
    const minCols = minLayout.columns || { left: { x: 0, w: 0 }, right: { x: 1e9, w: 0 } };
    check(
      minCols.left.x + minCols.left.w <= minCols.right.x + 1,
      'columns stay side by side at min size'
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
    const llmSourceBeforeFixture = llmSummary;
    await ev(`document.getElementById("summaryArea").value = ${JSON.stringify(MARKDOWN_FIXTURE)}`);
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

    // Untrusted LLM output must never execute.
    const errorsBeforeXss = consoleErrors.length;
    await ev(`document.getElementById("summaryArea").value = ${JSON.stringify(XSS_PAYLOAD)}`);
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
    await ev(`document.getElementById("summaryArea").value = ${JSON.stringify(llmSourceBeforeFixture)}`);
    await ev('document.getElementById("summaryPreviewBtn").click()');
    if (llmSourceBeforeFixture.trim()) {
      await ev('document.getElementById("copySummaryBtn").click()');
      await sleep(500);
      const summaryClipboard = exec('pbpaste', []).stdout;
      check(
        summaryClipboard === llmSourceBeforeFixture,
        `summary Copy puts the RAW markdown on the clipboard (${summaryClipboard.length}/${llmSourceBeforeFixture.length} chars)`
      );
      const savedSummaryPathText = (await textOf('savedSummaryPath')).trim().replace(/^Summary:\s*/, '');
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

    // --- dictation: hold Option, system-wide --------------------------------
    step('Dictation end-to-end (workstream 3)');

    const statusText = () => ev('document.getElementById("statusText").textContent || ""');
    const noticeText = () => ev('document.getElementById("dictationNotice").textContent || ""');
    const transcriptValue = () => ev('document.getElementById("transcriptArea").value');
    const dictationStatus = () => ev('window.electronAPI.getDictationStatus()');
    /** Samples status/notice for `ms`; stops early when the notice changes. */
    async function sampleOutcome(ms) {
      const startNotice = await noticeText();
      const seen = new Set();
      let notice = startNotice;
      const end = Date.now() + ms;
      while (Date.now() < end) {
        seen.add(await statusText());
        const now = await noticeText();
        if (now && now !== startNotice) {
          notice = now;
          break;
        }
        notice = now;
        await sleep(120);
      }
      return { seen: [...seen], notice };
    }
    const sawStatus = (sample, needle) => sample.seen.some((s) => s.includes(needle));

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
    let take = null;
    // Up to 5 attempts: a chord abort here means an unrelated key arrived
    // during the hold (the desktop is shared), which is correct behaviour —
    // just not the bare-hold case we are proving.
    for (let attempt = 1; attempt <= 5 && !take; attempt += 1) {
      const before = await transcriptValue();
      uIOhook.keyToggle(UiohookKey.Alt, 'down');
      const heldAt = Date.now();
      const started = await waitFor(async () => (await statusText()).includes('recording'), {
        timeout: 8000,
        label: `take ${attempt}: recording starts on Option keydown`,
      })
        .then(() => true)
        .catch(() => false);
      const badgeVisible = started
        ? !(await ev('document.getElementById("dictationBadge").hidden'))
        : false;
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
      let outcome = 'timeout';
      // The floor's earlier transcription leaves "completed" on screen, so wait
      // for THIS take to move on: an abort notice, an error, or the
      // transcription phase.
      while (Date.now() - releasedAt < 240000) {
        const status = await statusText();
        const notice = await noticeText();
        if (notice) { outcome = notice; break; }
        if (status.includes('error')) { outcome = status; break; }
        if (status.includes('transcribing')) { outcome = 'transcribing'; break; }
        await sleep(200);
      }
      if (outcome === 'transcribing') {
        const transcribingSince = Date.now();
        while (Date.now() - transcribingSince < 240000) {
          const status = await statusText();
          const notice = await noticeText();
          if (status.includes('completed')) { outcome = 'completed'; break; }
          if (status.includes('error') || notice) { outcome = notice || status; break; }
          await sleep(300);
        }
      }
      const after = await transcriptValue();
      const appendedSoFar = after.length > before.length ? after.slice(before.length) : '';
      // The model paraphrases slightly ("Hello, this is a local transcription
      // test…" rather than the exact opening), so accept any recognisable
      // trace of the sample — silence hallucinations come out unrelated.
      const looksLikeSample = /hello/i.test(appendedSoFar) || /transcription test/i.test(appendedSoFar);
      if (started && outcome === 'completed' && after !== before && looksLikeSample) {
        take = { attempt, before, after, badgeVisible, clearedWhileHolding };
      } else {
        note(
          `dictation take ${attempt}: outcome=${outcome} appended="${appendedSoFar.trim().slice(0, 80) || '(none)'}" — retrying`
        );
      }
      if (!take) await sleep(1500);
    }
    check(take !== null, 'a bare Option hold produced a transcription');
    if (take) {
      check(
        take.badgeVisible,
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
    // The arrow must land while the take is actually open, so wait for the app
    // to show "recording" first (its main process can be busy finishing the
    // previous take), and retry if the abort never surfaces.
    let beforeChord = await transcriptValue();
    let chord = null;
    for (let attempt = 1; attempt <= 3 && !chord; attempt += 1) {
      beforeChord = await transcriptValue();
      const sampler = sampleOutcome(9000);
      uIOhook.keyToggle(UiohookKey.Alt, 'down');
      const sawRecording = await waitFor(async () => (await statusText()).includes('recording'), {
        timeout: 8000,
        label: `chord ${attempt}: take opens`,
      })
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
        chord = { ...sample, sawRecording };
      } else {
        note(
          `chord ${attempt}: hint was "${sample.notice}" (recording seen: ${sawRecording}, transcript ${
            afterAttempt === beforeChord ? 'unchanged' : 'CHANGED'
          }, statuses: ${sample.seen.join(' > ')}) — retrying`
        );
        await sleep(1500);
      }
    }
    const afterChord = await transcriptValue();
    check(chord !== null && chord.sawRecording, `chord take opened (statuses: ${chord ? chord.seen.join(' > ') : 'n/a'})`);
    check(chord !== null && chord.notice === CHORD_NOTICE, `chord abort hint: "${chord ? chord.notice : '(never shown)'}"`);
    check(chord === null || !sawStatus(chord, 'transcribing'), 'chord take never reaches the transcription pipeline');
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
        tap = sample;
      } else {
        note(`tap ${attempt}: hint was "${sample.notice}" (statuses: ${sample.seen.join(' > ')}) — retrying`);
        await sleep(1200);
      }
    }
    const afterTap = await transcriptValue();
    check(
      tap !== null && tap.notice === TOO_SHORT_NOTICE,
      `too-short hint: "${tap ? tap.notice : '(never shown)'}"`
    );
    check(tap === null || !sawStatus(tap, 'transcribing'), 'too-short take never reaches the transcription pipeline');
    check(afterTap === beforeTap, 'too-short tap produces NO transcription (transcript unchanged)');

    // (4) dictationEnabled OFF -> the settings toggle stops the hook and a
    // hold produces no recording.
    const beforeOff = await transcriptValue();
    await ev('document.getElementById("settingsBtn").click()');
    check(
      !(await ev('document.getElementById("dictationEnabledChk").checked')),
      'settings checkbox still reflects the parked (off) state'
    );
    await ev('document.getElementById("settingsSaveBtn").click()');
    await waitFor(async () => (await dictationStatus()).running === false, {
      timeout: 15000,
      label: 'hook stopped after saving dictationEnabled=OFF',
    });
    const offHintOk = await waitFor(
      async () => ((await textOf('dictationStatus')) || '').includes('switched off'),
      { timeout: 10000, interval: 300, label: 'settings hint reports dictation off' }
    ).catch(() => false);
    check(Boolean(offHintOk), `settings hint when off: "${((await textOf('dictationStatus')) || '').trim()}"`);
    const offStatus = await dictationStatus();
    check(offStatus.enabled === false && offStatus.running === false, 'dictationEnabled=OFF stops the hook');
    const offSamplePromise = sampleOutcome(6000);
    uIOhook.keyToggle(UiohookKey.Alt, 'down');
    await sleep(1500);
    uIOhook.keyToggle(UiohookKey.Alt, 'up');
    const offSample = await offSamplePromise;
    check(!sawStatus(offSample, 'recording'), 'dictationEnabled=OFF produces NO recording');
    check((await transcriptValue()) === beforeOff, 'transcript unchanged while dictation is off');

    // Re-enable through the same toggle so the default ON state is restored.
    await ev('document.getElementById("dictationEnabledChk").checked = true');
    await ev('document.getElementById("settingsSaveBtn").click()');
    await waitFor(async () => (await dictationStatus()).running === true, {
      timeout: 20000,
      label: 'hook restarted after re-enabling',
    });
    const onHintOk = await waitFor(
      async () => ((await textOf('dictationStatus')) || '').includes(DICTATION_HINT_TEXT),
      { timeout: 10000, interval: 300, label: 'settings hint back to hold-Option' }
    ).catch(() => false);
    check(Boolean(onHintOk), `settings hint when on: "${((await textOf('dictationStatus')) || '').trim()}"`);
    check(
      await ev('document.getElementById("dictationEnabledChk").checked'),
      'settings checkbox restored to checked (default ON)'
    );
    await ev('document.getElementById("settingsBtn").click()');
    pass('dictationEnabled re-enabled (default ON) at the end of the run');

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
  console.log('\n================ SMOKE REPORT ================');
  console.log(`passed : ${passCount}`);
  console.log(`failed : ${failures.length}`);
  for (const msg of failures) console.log(`  FAIL: ${msg}`);
  for (const msg of notes) console.log(`  note: ${msg}`);
  console.log('===============================================');
  process.exit(failures.length > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(`FATAL: ${err.stack || err.message}`);
  process.exit(1);
});
