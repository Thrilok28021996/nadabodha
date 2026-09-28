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

    await ev(
      `(() => { const row = document.querySelector('#hfInstalled [data-repo-id=${JSON.stringify(
        HF_REPO
      )}]'); row.click(); return true; })()`
    );
    let useEnabled = await ev('!document.getElementById("hfUseBtn").disabled');
    if (!useEnabled && (await textOf('hfUseBtn')).trim() === 'Active') {
      // Already active (stale state) — clear it so the Set active transition is exercised.
      note('downloaded model already active — clearing activeModel to exercise Set active');
      await ev('window.electronAPI.updateSettings({ activeModel: "" })');
      await ev('document.getElementById("hfSearchBtn").click()');
      await waitFor(
        async () => {
          await ev(
            `(() => { const r = document.querySelector('#hfInstalled [data-repo-id=${JSON.stringify(
              HF_REPO
            )}]'); if (r) r.click(); return true; })()`
          );
          return ev('!document.getElementById("hfUseBtn").disabled');
        },
        { timeout: 20000, interval: 500, label: 'Set active enabled after clearing activeModel' }
      );
      useEnabled = true;
    }
    check(useEnabled, 'installed row enables the Set active button');
    await ev('document.getElementById("hfUseBtn").click()');
    await waitFor(async () => (await getSettings()).activeModel === HF_REPO, {
      timeout: 20000,
      label: 'active model saved',
    });
    pass(`active model = ${HF_REPO}`);
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
    await waitFor(
      async () => {
        const summary = await ev('document.getElementById("summaryArea").value');
        return summary.length > 0;
      },
      { timeout: 300000, interval: 1000, label: 'auto summary' }
    );
    const summary = await ev('document.getElementById("summaryArea").value');
    const summaryStatusText = (await textOf('summaryStatus')).trim();
    check(summary.length > 0, `auto summary produced (${summary.length} chars): "${summary.slice(0, 100)}"`);
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
    await waitFor(
      async () => {
        const value = await ev('document.getElementById("summaryArea").value');
        return value.length > 0;
      },
      { timeout: 300000, interval: 1000, label: 'manual summary' }
    );
    const manualSummary = await ev('document.getElementById("summaryArea").value');
    check(manualSummary.length > 0, `manual summary produced (${manualSummary.length} chars)`);
    const summaryFiles = fs.readdirSync(path.join(dataDir, 'summaries'));
    check(summaryFiles.length >= 2, `summaries/ holds ${summaryFiles.length} .md file(s) after manual run`);

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
