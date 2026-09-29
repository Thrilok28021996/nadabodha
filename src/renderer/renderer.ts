// This file is loaded by index.html as a classic <script>, not as a module,
// so it must contain no top-level import/export: TypeScript would emit the
// CommonJS `Object.defineProperty(exports, ...)` prologue, and `exports` is
// undefined in the page, which aborts the whole script (F4). An `import()`
// type query is erased at compile time and does not make this a module.
type TranscriptionEvent = import('../shared/ipc').TranscriptionEvent;
type AppSettings = import('../shared/ipc').AppSettings;
type PythonValidation = import('../shared/ipc').PythonValidation;
type SettingsUpdateResult = import('../shared/ipc').SettingsUpdateResult;
type LlmConnectionResult = import('../shared/ipc').LlmConnectionResult;
type HfModelInfo = import('../shared/ipc').HfModelInfo;
type HfModelListResult = import('../shared/ipc').HfModelListResult;

// Preload API is injected at runtime; declare a minimal typed interface here
// to avoid importing from the sandboxed preload bundle.
interface ElectronApi {
  startRecording: () => Promise<{ outputPath: string }>;
  stopRecording: () => Promise<{ outputPath: string | null }>;
  importAudio: (filePath: string) => Promise<{ filePath: string }>;
  cancelTranscription: () => Promise<{ cancelled: boolean }>;
  saveTranscript: (request: { filePath: string; text: string }) => Promise<{ success: boolean; error?: string }>;
  copyTranscript: (text: string) => Promise<{ copied: boolean }>;
  requestStatus: () => Promise<{ status: string; text: string; filePath: string | null }>;
  requestSavePath?: () => Promise<string | undefined>;
  onTranscriptionEvent: (callback: (event: TranscriptionEvent) => void) => void;
  removeTranscriptionListener: () => void;
  getSettings: () => Promise<AppSettings>;
  updateSettings: (patch: Partial<AppSettings>) => Promise<SettingsUpdateResult>;
  validatePython: (pythonPath: string) => Promise<PythonValidation>;
  pickDirectory: (title?: string) => Promise<string | null>;
  pickPythonFile: () => Promise<string | null>;
  getPathForFile?: (file: File) => string;
  testLlmConnection: (baseUrl?: string) => Promise<LlmConnectionResult>;
  listHfModels: (query?: string) => Promise<HfModelListResult>;
  downloadModel: (repoId: string) => Promise<{ started: boolean; error?: string }>;
  cancelDownload: () => Promise<{ cancelled: boolean }>;
  summarize: (text?: string) => Promise<{ started: boolean; error?: string }>;
  cancelSummary: () => Promise<{ cancelled: boolean }>;
}

// Merged into the global Window declared by lib.dom; only read as a type.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
interface Window {
  electronAPI: ElectronApi;
}

type HintState = 'ok' | 'error' | 'busy' | '';

const recordBtn = document.getElementById('recordBtn') as HTMLButtonElement;
const stopRecordBtn = document.getElementById('stopRecordBtn') as HTMLButtonElement;
const importBtn = document.getElementById('importBtn') as HTMLButtonElement;
const cancelBtn = document.getElementById('cancelBtn') as HTMLButtonElement;
const copyBtn = document.getElementById('copyBtn') as HTMLButtonElement;
const saveBtn = document.getElementById('saveBtn') as HTMLButtonElement;
const statusText = document.getElementById('statusText') as HTMLParagraphElement;
const progressBar = document.getElementById('progressBar') as HTMLProgressElement;
const errorText = document.getElementById('errorText') as HTMLParagraphElement;
const transcriptArea = document.getElementById('transcriptArea') as HTMLTextAreaElement;
const fileInput = document.getElementById('fileInput') as HTMLInputElement;

// Tabs + summary
const tabTranscript = document.getElementById('tabTranscript') as HTMLButtonElement;
const tabSummary = document.getElementById('tabSummary') as HTMLButtonElement;
const transcriptPanel = document.getElementById('transcriptPanel') as HTMLElement;
const summaryPanel = document.getElementById('summaryPanel') as HTMLElement;
const summarizeBtn = document.getElementById('summarizeBtn') as HTMLButtonElement;
const cancelSummaryBtn = document.getElementById('cancelSummaryBtn') as HTMLButtonElement;
const summaryArea = document.getElementById('summaryArea') as HTMLTextAreaElement;
const summaryStatus = document.getElementById('summaryStatus') as HTMLParagraphElement;
const summaryError = document.getElementById('summaryError') as HTMLParagraphElement;

// Saved files
const savedPanel = document.getElementById('savedPanel') as HTMLElement;
const savedTranscriptPath = document.getElementById('savedTranscriptPath') as HTMLParagraphElement;
const savedSummaryPath = document.getElementById('savedSummaryPath') as HTMLParagraphElement;
const saveErrorText = document.getElementById('saveErrorText') as HTMLParagraphElement;

// Settings
const settingsBtn = document.getElementById('settingsBtn') as HTMLButtonElement;
const settingsPanel = document.getElementById('settingsPanel') as HTMLElement;
const settingsSaveBtn = document.getElementById('settingsSaveBtn') as HTMLButtonElement;
const settingsStatus = document.getElementById('settingsStatus') as HTMLParagraphElement;
const pythonPathInput = document.getElementById('pythonPathInput') as HTMLInputElement;
const pythonBrowseBtn = document.getElementById('pythonBrowseBtn') as HTMLButtonElement;
const pythonValidateBtn = document.getElementById('pythonValidateBtn') as HTMLButtonElement;
const pythonStatus = document.getElementById('pythonStatus') as HTMLParagraphElement;
const llmBaseUrlInput = document.getElementById('llmBaseUrlInput') as HTMLInputElement;
const llmModelSelect = document.getElementById('llmModelSelect') as HTMLSelectElement;
const llmApiKeyInput = document.getElementById('llmApiKeyInput') as HTMLInputElement;
const llmRefreshBtn = document.getElementById('llmRefreshBtn') as HTMLButtonElement;
const llmTestBtn = document.getElementById('llmTestBtn') as HTMLButtonElement;
const llmStatus = document.getElementById('llmStatus') as HTMLParagraphElement;
const dataDirInput = document.getElementById('dataDirInput') as HTMLInputElement;
const dataDirBrowseBtn = document.getElementById('dataDirBrowseBtn') as HTMLButtonElement;
const dataDirStatus = document.getElementById('dataDirStatus') as HTMLParagraphElement;
const cacheDirInput = document.getElementById('cacheDirInput') as HTMLInputElement;
const cacheDirBrowseBtn = document.getElementById('cacheDirBrowseBtn') as HTMLButtonElement;
const cacheDirStatus = document.getElementById('cacheDirStatus') as HTMLParagraphElement;
const summarizeEnabledChk = document.getElementById('summarizeEnabledChk') as HTMLInputElement;
const autoSummarizeChk = document.getElementById('autoSummarizeChk') as HTMLInputElement;
const promptPathStatus = document.getElementById('promptPathStatus') as HTMLParagraphElement;
const hfSearchInput = document.getElementById('hfSearchInput') as HTMLInputElement;
const hfSearchBtn = document.getElementById('hfSearchBtn') as HTMLButtonElement;
const hfStatus = document.getElementById('hfStatus') as HTMLParagraphElement;
const hfResults = document.getElementById('hfResults') as HTMLElement;
const hfInstalled = document.getElementById('hfInstalled') as HTMLElement;
const hfDownloadBtn = document.getElementById('hfDownloadBtn') as HTMLButtonElement;
const hfUseBtn = document.getElementById('hfUseBtn') as HTMLButtonElement;
const hfCancelDownloadBtn = document.getElementById('hfCancelDownloadBtn') as HTMLButtonElement;
const downloadProgress = document.getElementById('downloadProgress') as HTMLProgressElement;
const downloadStatus = document.getElementById('downloadStatus') as HTMLParagraphElement;

let currentText = '';
let currentSettings: AppSettings | null = null;
let selectedModelId: string | null = null;
let installedModels: string[] = [];
let partialModels: string[] = [];
let activeModel = '';
let hfLoaded = false;
let hfSearchTimer: number | undefined;
let llmLoadTimer: number | undefined;

function setHint(element: HTMLElement, text: string, state: HintState = ''): void {
  element.textContent = text;
  element.hidden = !text;
  element.setAttribute('data-state', state);
}

function showTab(which: 'transcript' | 'summary'): void {
  const showSummary = which === 'summary';
  transcriptPanel.hidden = showSummary;
  summaryPanel.hidden = !showSummary;
  tabTranscript.classList.toggle('active', !showSummary);
  tabSummary.classList.toggle('active', showSummary);
  tabTranscript.setAttribute('aria-selected', String(!showSummary));
  tabSummary.setAttribute('aria-selected', String(showSummary));
}

function clearSavedPaths(): void {
  savedTranscriptPath.hidden = true;
  savedSummaryPath.hidden = true;
  saveErrorText.hidden = true;
  savedPanel.hidden = savedTranscriptPath.hidden && savedSummaryPath.hidden && saveErrorText.hidden;
}

function showSavedTranscriptPath(filePath: string): void {
  savedTranscriptPath.textContent = `Transcript: ${filePath}`;
  savedTranscriptPath.hidden = false;
  savedPanel.hidden = false;
}

function showSavedSummaryPath(filePath: string): void {
  savedSummaryPath.textContent = `Summary: ${filePath}`;
  savedSummaryPath.hidden = false;
  savedPanel.hidden = false;
}

function showSaveError(message: string): void {
  saveErrorText.textContent = message;
  saveErrorText.hidden = false;
  savedPanel.hidden = false;
}

function updateStatus(event: TranscriptionEvent): void {
  statusText.textContent = `Status: ${event.status}`;
  errorText.hidden = true;

  if (event.status === 'recording' || event.status === 'transcribing') {
    // N-F3: a new capture or transcription replaces the transcript on
    // screen as soon as it starts, not only when it completes.
    currentText = '';
    transcriptArea.value = '';
    summaryArea.value = '';
    setHint(summaryStatus, '');
    summaryError.hidden = true;
    clearSavedPaths();
    recordBtn.disabled = true;
    stopRecordBtn.disabled = event.status === 'transcribing';
    importBtn.disabled = true;
    cancelBtn.disabled = false;
    copyBtn.disabled = true;
    saveBtn.disabled = true;
    summarizeBtn.disabled = true;
  } else if (event.status === 'completed') {
    recordBtn.disabled = false;
    stopRecordBtn.disabled = true;
    importBtn.disabled = false;
    cancelBtn.disabled = true;
    copyBtn.disabled = false;
    saveBtn.disabled = false;
    currentText = event.text || '';
    transcriptArea.value = currentText;
    summarizeBtn.disabled = !currentText.trim();
    if (event.savedTranscriptPath) {
      showSavedTranscriptPath(event.savedTranscriptPath);
    }
    if (event.saveError) {
      showSaveError(event.saveError);
    }
  } else if (event.status === 'error') {
    recordBtn.disabled = false;
    stopRecordBtn.disabled = true;
    importBtn.disabled = false;
    cancelBtn.disabled = true;
    copyBtn.disabled = !currentText;
    saveBtn.disabled = !currentText;
    summarizeBtn.disabled = !currentText.trim();
    errorText.textContent = event.error || 'Unknown error';
    errorText.hidden = false;
    if (event.saveError) {
      showSaveError(event.saveError);
    }
  } else {
    // idle / cancelled
    recordBtn.disabled = false;
    stopRecordBtn.disabled = true;
    importBtn.disabled = false;
    cancelBtn.disabled = true;
    copyBtn.disabled = !currentText;
    saveBtn.disabled = !currentText;
    summarizeBtn.disabled = !currentText.trim();
  }

  if (event.status === 'transcribing' && typeof event.progress === 'number') {
    progressBar.value = event.progress;
    progressBar.hidden = false;
  } else {
    progressBar.value = 0;
    progressBar.hidden = true;
  }
}

function handleSummaryEvent(event: TranscriptionEvent): void {
  showTab('summary');
  if (event.status === 'summarizing') {
    setHint(summaryStatus, `Summarizing…${typeof event.progress === 'number' ? ` ${event.progress}%` : ''}`, 'busy');
    summaryError.hidden = true;
    summarizeBtn.disabled = true;
    cancelSummaryBtn.hidden = false;
  } else if (event.status === 'completed') {
    setHint(summaryStatus, 'Summary ready', 'ok');
    summaryError.hidden = true;
    if (typeof event.text === 'string') {
      summaryArea.value = event.text;
    }
    summarizeBtn.disabled = !currentText.trim();
    cancelSummaryBtn.hidden = true;
    if (event.savedSummaryPath) {
      showSavedSummaryPath(event.savedSummaryPath);
    }
    if (event.saveError) {
      showSaveError(event.saveError);
    }
  } else if (event.status === 'error') {
    setHint(summaryStatus, '');
    summaryError.textContent = event.error || 'Summarization failed';
    summaryError.hidden = false;
    summarizeBtn.disabled = !currentText.trim();
    cancelSummaryBtn.hidden = true;
    if (event.saveError) {
      showSaveError(event.saveError);
    }
  } else if (event.status === 'cancelled') {
    setHint(summaryStatus, 'Summary cancelled');
    cancelSummaryBtn.hidden = true;
    summarizeBtn.disabled = !currentText.trim();
  }
}

function handleDownloadEvent(event: TranscriptionEvent): void {
  if (event.status === 'downloading') {
    downloadProgress.hidden = false;
    hfCancelDownloadBtn.hidden = false;
    hfDownloadBtn.disabled = true;
    if (typeof event.progress === 'number') {
      downloadProgress.value = event.progress;
    }
    const percent = typeof event.progress === 'number' ? ` ${event.progress}%` : '';
    const filePart = event.file ? ` — ${event.file}` : '';
    setHint(downloadStatus, `Downloading ${event.repoId || 'model'}…${percent}${filePart}`, 'busy');
  } else if (event.status === 'completed') {
    downloadProgress.hidden = true;
    hfCancelDownloadBtn.hidden = true;
    hfDownloadBtn.disabled = !selectedModelId;
    downloadProgress.value = 0;
    setHint(downloadStatus, `Downloaded ${event.repoId || 'model'} to ${event.path || 'cache'}`, 'ok');
    void refreshModels();
  } else if (event.status === 'error') {
    downloadProgress.hidden = true;
    hfCancelDownloadBtn.hidden = true;
    hfDownloadBtn.disabled = !selectedModelId;
    setHint(downloadStatus, event.error || 'Model download failed', 'error');
    void refreshModels();
  } else if (event.status === 'cancelled') {
    downloadProgress.hidden = true;
    hfCancelDownloadBtn.hidden = true;
    hfDownloadBtn.disabled = !selectedModelId;
    setHint(downloadStatus, `Download of ${event.repoId || 'model'} cancelled — partial files stay resumable`, 'ok');
    // Re-list the cache so the interrupted snapshot shows up as incomplete
    // (and can be downloaded again) instead of silently vanishing.
    void refreshModels();
  }
}

function handleEvent(event: TranscriptionEvent): void {
  if (event.origin === 'summary') {
    handleSummaryEvent(event);
    return;
  }
  if (event.origin === 'download') {
    handleDownloadEvent(event);
    return;
  }
  updateStatus(event);
}

recordBtn.addEventListener('click', async () => {
  try {
    await window.electronAPI.startRecording();
  } catch (err) {
    updateStatus({ status: 'error', error: String(err) });
  }
});

stopRecordBtn.addEventListener('click', async () => {
  try {
    await window.electronAPI.stopRecording();
  } catch (err) {
    updateStatus({ status: 'error', error: String(err) });
  }
});

importBtn.addEventListener('click', () => {
  fileInput.click();
});

fileInput.addEventListener('change', async () => {
  const file = fileInput.files?.[0];
  if (!file) return;
  try {
    const resolved = window.electronAPI.getPathForFile?.(file) ||
      (file as unknown as { path?: string }).path ||
      '';
    if (!resolved) {
      throw new Error('Could not resolve the selected file path');
    }
    await window.electronAPI.importAudio(resolved);
  } catch (err) {
    updateStatus({ status: 'error', error: String(err) });
  }
  fileInput.value = '';
});

cancelBtn.addEventListener('click', async () => {
  try {
    await window.electronAPI.cancelTranscription();
  } catch (err) {
    updateStatus({ status: 'error', error: String(err) });
  }
});

copyBtn.addEventListener('click', async () => {
  try {
    await window.electronAPI.copyTranscript(transcriptArea.value);
    copyBtn.textContent = 'Copied!';
    setTimeout(() => (copyBtn.textContent = 'Copy'), 1500);
  } catch (err) {
    updateStatus({ status: 'error', error: String(err) });
  }
});

saveBtn.addEventListener('click', async () => {
  try {
    const filePath = await window.electronAPI.requestSavePath?.();
    if (!filePath) return;
    const result = await window.electronAPI.saveTranscript({
      filePath,
      text: transcriptArea.value,
    });
    if (!result.success) {
      updateStatus({ status: 'error', error: result.error || 'Save failed' });
    }
  } catch (err) {
    updateStatus({ status: 'error', error: String(err) });
  }
});

// ---- Tabs -------------------------------------------------------------------

tabTranscript.addEventListener('click', () => showTab('transcript'));
tabSummary.addEventListener('click', () => showTab('summary'));

summarizeBtn.addEventListener('click', async () => {
  try {
    const result = await window.electronAPI.summarize(transcriptArea.value);
    if (!result.started) {
      showTab('summary');
      summaryError.textContent = result.error || 'Cannot start summarization';
      summaryError.hidden = false;
    }
  } catch (err) {
    showTab('summary');
    summaryError.textContent = String(err);
    summaryError.hidden = false;
  }
});

cancelSummaryBtn.addEventListener('click', async () => {
  try {
    await window.electronAPI.cancelSummary();
  } catch (err) {
    summaryError.textContent = String(err);
    summaryError.hidden = false;
  }
});

// ---- Settings ---------------------------------------------------------------

function openSettings(open: boolean): void {
  settingsPanel.hidden = !open;
  settingsBtn.setAttribute('aria-expanded', String(open));
  if (open && !hfLoaded) {
    void refreshModels();
  }
}

settingsBtn.addEventListener('click', () => {
  openSettings(settingsPanel.hidden);
});

function ensureModelOption(model: string): void {
  if (!model) return;
  const exists = Array.from(llmModelSelect.options).some((option) => option.value === model);
  if (!exists) {
    const option = document.createElement('option');
    option.value = model;
    option.textContent = model;
    llmModelSelect.appendChild(option);
  }
  llmModelSelect.value = model;
}

function updatePromptPathStatus(dataDir: string): void {
  if (dataDir) {
    setHint(promptPathStatus, `Prompt template: ${dataDir}/scripts/summarize-prompt.md`);
  } else {
    setHint(promptPathStatus, 'Using the built-in prompt (choose a data directory for an editable copy)');
  }
}

function applySettingsToForm(settings: AppSettings): void {
  currentSettings = settings;
  pythonPathInput.value = settings.pythonPath;
  llmBaseUrlInput.value = settings.llmBaseUrl;
  ensureModelOption(settings.llmModel);
  llmApiKeyInput.value = settings.llmApiKey;
  dataDirInput.value = settings.dataDir;
  cacheDirInput.value = settings.sttCacheDir;
  summarizeEnabledChk.checked = settings.summarizationEnabled;
  autoSummarizeChk.checked = settings.autoSummarize;
  activeModel = settings.activeModel;
  updatePromptPathStatus(settings.dataDir);
  if (settings.dataDir) {
    setHint(dataDirStatus, `Ready: ${settings.dataDir}/transcripts, /summaries, /scripts`, 'ok');
  } else {
    setHint(dataDirStatus, '');
  }
}

async function loadSettings(): Promise<void> {
  try {
    const settings = await window.electronAPI.getSettings();
    applySettingsToForm(settings);
  } catch (err) {
    setHint(settingsStatus, `Cannot load settings: ${String(err)}`, 'error');
  }
}

settingsSaveBtn.addEventListener('click', async () => {
  setHint(settingsStatus, 'Saving…', 'busy');
  try {
    const result = await window.electronAPI.updateSettings({
      pythonPath: pythonPathInput.value.trim(),
      llmBaseUrl: llmBaseUrlInput.value.trim(),
      llmModel: llmModelSelect.value,
      llmApiKey: llmApiKeyInput.value,
      dataDir: dataDirInput.value.trim(),
      sttCacheDir: cacheDirInput.value.trim(),
      summarizationEnabled: summarizeEnabledChk.checked,
      autoSummarize: autoSummarizeChk.checked,
    });

    applySettingsToForm(result.settings);

    const messages = result.messages || {};
    const errors = result.errors || {};

    if (errors.pythonPath) {
      setHint(pythonStatus, errors.pythonPath, 'error');
    } else {
      setHint(pythonStatus, messages.pythonPath || '', messages.pythonPath ? 'ok' : '');
    }

    if (errors.dataDir) {
      setHint(dataDirStatus, errors.dataDir, 'error');
    } else if (result.settings.dataDir) {
      setHint(dataDirStatus, `Ready: ${result.settings.dataDir}/transcripts, /summaries, /scripts`, 'ok');
    } else {
      setHint(dataDirStatus, '');
    }

    if (errors.sttCacheDir) {
      setHint(cacheDirStatus, errors.sttCacheDir, 'error');
    } else if (result.settings.sttCacheDir) {
      setHint(cacheDirStatus, `Model cache: ${result.settings.sttCacheDir}`, 'ok');
    } else {
      setHint(cacheDirStatus, '');
    }

    const errorList = Object.values(errors).filter(Boolean);
    if (errorList.length > 0) {
      setHint(settingsStatus, `Saved with issues: ${errorList.join(' | ')}`, 'error');
    } else {
      setHint(settingsStatus, 'Settings saved', 'ok');
    }
    void refreshModels();
  } catch (err) {
    setHint(settingsStatus, `Cannot save settings: ${String(err)}`, 'error');
  }
});

pythonValidateBtn.addEventListener('click', async () => {
  setHint(pythonStatus, 'Validating…', 'busy');
  try {
    const validation = await window.electronAPI.validatePython(pythonPathInput.value.trim());
    setHint(pythonStatus, validation.message, validation.ok ? 'ok' : 'error');
  } catch (err) {
    setHint(pythonStatus, String(err), 'error');
  }
});

pythonBrowseBtn.addEventListener('click', async () => {
  try {
    const filePath = await window.electronAPI.pickPythonFile();
    if (filePath) {
      pythonPathInput.value = filePath;
    }
  } catch (err) {
    setHint(pythonStatus, String(err), 'error');
  }
});

dataDirBrowseBtn.addEventListener('click', async () => {
  try {
    const dir = await window.electronAPI.pickDirectory('Choose the data directory');
    if (dir) {
      dataDirInput.value = dir;
    }
  } catch (err) {
    setHint(dataDirStatus, String(err), 'error');
  }
});

cacheDirBrowseBtn.addEventListener('click', async () => {
  try {
    const dir = await window.electronAPI.pickDirectory('Choose the model cache directory');
    if (dir) {
      cacheDirInput.value = dir;
    }
  } catch (err) {
    setHint(cacheDirStatus, String(err), 'error');
  }
});

/**
 * The summarizer talks to /chat/completions, so embedding, reranker and
 * other non-chat models are dead entries in the dropdown.
 */
function isChatCapableModel(modelId: string): boolean {
  const id = (modelId || '').trim().toLowerCase();
  if (!id) {
    return false;
  }
  const nonChat = [
    /(^|[-_./])embed/, // text-embedding-*, nomic-embed-*, *-embedding-*
    /(^|[-_./])rerank/,
    /(^|[-_./])retrieval/,
    /(^|[-_./])bge[-_]/,
    /(^|[-_./])e5[-_]/,
    /(^|[-_./])gte[-_]/,
    /(^|[-_./])minilm/,
    /(^|[-_./])stella[-_]/,
    /(^|[-_./])whisper/,
    /(^|[-_./])tts([-_.]|$)/,
    /(^|[-_./])asr([-_.]|$)/,
    /(^|[-_./])clip([-_.]|$)/,
    /(^|[-_./])stable-diffusion/,
    /(^|[-_./])flux[-_.]/,
  ];
  return !nonChat.some((pattern) => pattern.test(id));
}

async function loadLlmModels(baseUrl: string, showStatus: boolean): Promise<void> {
  if (showStatus) {
    setHint(llmStatus, 'Loading models…', 'busy');
  }
  try {
    const result = await window.electronAPI.testLlmConnection(baseUrl);
    const previous = llmModelSelect.value || currentSettings?.llmModel || '';
    llmModelSelect.innerHTML = '<option value="">— none —</option>';
    let listed = 0;
    for (const model of result.models) {
      if (!isChatCapableModel(model)) {
        continue;
      }
      const option = document.createElement('option');
      option.value = model;
      option.textContent = model;
      llmModelSelect.appendChild(option);
      listed += 1;
    }
    ensureModelOption(previous);
    if (listed > 0 && previous) {
      llmModelSelect.value = previous;
    }
    if (showStatus) {
      setHint(llmStatus, result.message, result.ok ? 'ok' : 'error');
    }
  } catch (err) {
    if (showStatus) {
      setHint(llmStatus, String(err), 'error');
    }
  }
}

llmBaseUrlInput.addEventListener('input', () => {
  if (llmLoadTimer) {
    window.clearTimeout(llmLoadTimer);
  }
  llmLoadTimer = window.setTimeout(() => {
    void loadLlmModels(llmBaseUrlInput.value.trim(), false);
  }, 500);
});

llmRefreshBtn.addEventListener('click', () => {
  void loadLlmModels(llmBaseUrlInput.value.trim(), true);
});

llmTestBtn.addEventListener('click', () => {
  void loadLlmModels(llmBaseUrlInput.value.trim(), true);
});

// ---- Hugging Face model browser --------------------------------------------

function formatDownloads(downloads: number): string {
  if (!Number.isFinite(downloads) || downloads <= 0) return '0';
  if (downloads >= 1000000) return `${(downloads / 1000000).toFixed(1)}M`;
  if (downloads >= 1000) return `${(downloads / 1000).toFixed(1)}k`;
  return String(downloads);
}

function renderModelRow(
  model: HfModelInfo,
  container: HTMLElement,
  installed: boolean,
  active: boolean,
  partial = false
): HTMLElement {
  const row = document.createElement('div');
  row.className = 'model-row';
  row.setAttribute('role', 'listitem');
  row.dataset.repoId = model.id;

  const label = document.createElement('span');
  label.className = 'model-id';
  label.textContent = model.id;
  row.appendChild(label);

  const meta = document.createElement('span');
  meta.className = 'model-meta';
  meta.textContent = `${formatDownloads(model.downloads)} downloads · ${model.format}`;
  row.appendChild(meta);

  if (installed || partial) {
    const badge = document.createElement('span');
    badge.className = partial ? 'badge partial' : 'badge';
    badge.textContent = partial
      ? active
        ? 'active · incomplete'
        : 'incomplete'
      : active
        ? 'active'
        : 'installed';
    row.appendChild(badge);
  }

  if (partial) {
    row.classList.add('partial');
    row.title = `${model.id} — download was interrupted; download it again to finish`;
  }

  if (model.kind === 'unsupported') {
    row.classList.add('unsupported');
    row.title = model.reason || 'Cannot run locally';
    const reason = document.createElement('span');
    reason.className = 'model-reason';
    reason.textContent = model.reason || 'Cannot run locally as speech-to-text';
    row.appendChild(reason);
  } else {
    row.addEventListener('click', () => selectModel(model.id, container === hfInstalled));
  }

  container.appendChild(row);
  return row;
}

function selectModel(repoId: string, fromInstalled: boolean): void {
  selectedModelId = repoId;
  const rows = hfResults.querySelectorAll('.model-row');
  rows.forEach((row) => {
    row.classList.toggle('selected', (row as HTMLElement).dataset.repoId === repoId);
  });
  const isInstalled = installedModels.includes(repoId);
  const isPartial = partialModels.includes(repoId);
  // A partial snapshot can be downloaded again (and finished), but it is
  // never "installed": it must not be offered as a working model.
  hfDownloadBtn.disabled = !repoId || (isInstalled && !isPartial);
  hfUseBtn.disabled = (!isInstalled && !isPartial) || repoId === activeModel;
  hfUseBtn.textContent = repoId === activeModel ? 'Active' : 'Set active';
  if (isPartial && !isInstalled) {
    setHint(
      hfStatus,
      `${repoId} is incomplete — its download was interrupted. Download it again to finish before setting it active.`,
      'error'
    );
  } else if (fromInstalled) {
    setHint(hfStatus, `Selected ${repoId}`, 'ok');
  }
}

async function refreshModels(): Promise<void> {
  try {
    const result = await window.electronAPI.listHfModels(hfSearchInput.value.trim());
    installedModels = result.installed || [];
    partialModels = result.partial || [];
    activeModel = result.activeModel || '';
    renderSearchResults(result);
    renderInstalled(result);
    hfLoaded = true;
    if (result.error) {
      setHint(hfStatus, result.error, 'error');
    }
  } catch (err) {
    setHint(hfStatus, String(err), 'error');
  }
}

function renderSearchResults(result: HfModelListResult): void {
  hfResults.innerHTML = '';
  if (result.error) {
    setHint(hfStatus, result.error, 'error');
    return;
  }
  if (result.models.length === 0) {
    setHint(hfStatus, 'No models found', '');
    return;
  }
  setHint(hfStatus, `${result.models.length} model(s) — click a row to select it`, 'ok');
  for (const model of result.models) {
    const row = renderModelRow(
      model,
      hfResults,
      installedModels.includes(model.id),
      model.id === activeModel,
      partialModels.includes(model.id)
    );
    if (model.id === activeModel) {
      row.classList.add('selected');
    }
  }
}

function renderInstalled(result: HfModelListResult): void {
  hfInstalled.innerHTML = '';
  const installed = result.installed || [];
  const partial = result.partial || [];
  if (installed.length === 0 && partial.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'hint';
    empty.textContent = `Nothing installed yet in ${currentSettings?.sttCacheDir || 'the cache directory'}`;
    hfInstalled.appendChild(empty);
    return;
  }
  for (const repoId of installed) {
    renderModelRow(
      {
        id: repoId,
        downloads: 0,
        pipelineTag: 'automatic-speech-recognition',
        tags: [],
        kind: 'pytorch',
        format: installedFormat(repoId),
      },
      hfInstalled,
      true,
      repoId === result.activeModel
    );
  }
  // Interrupted downloads are listed apart from installed models: they can be
  // downloaded again, but never activated or used for transcription.
  for (const repoId of partial) {
    renderModelRow(
      {
        id: repoId,
        downloads: 0,
        pipelineTag: 'automatic-speech-recognition',
        tags: [],
        kind: 'pytorch',
        format: installedFormat(repoId),
      },
      hfInstalled,
      false,
      repoId === result.activeModel,
      true
    );
  }
  if (result.activeModel && partial.includes(result.activeModel)) {
    setHint(
      hfStatus,
      `Active model ${result.activeModel} is incomplete — its download was interrupted. Download it again before transcribing.`,
      'error'
    );
  }
}

function installedFormat(repoId: string): string {
  if (repoId.toLowerCase().includes('faster-whisper')) return 'CTranslate2';
  return 'PyTorch';
}

function runHfSearch(): void {
  if (hfSearchTimer) {
    window.clearTimeout(hfSearchTimer);
    hfSearchTimer = undefined;
  }
  setHint(hfStatus, 'Searching…', 'busy');
  void refreshModels();
}

hfSearchInput.addEventListener('input', () => {
  if (hfSearchTimer) {
    window.clearTimeout(hfSearchTimer);
  }
  hfSearchTimer = window.setTimeout(runHfSearch, 400);
});

hfSearchBtn.addEventListener('click', runHfSearch);

hfDownloadBtn.addEventListener('click', async () => {
  if (!selectedModelId) return;
  setHint(downloadStatus, `Starting download of ${selectedModelId}…`, 'busy');
  downloadProgress.hidden = false;
  downloadProgress.value = 0;
  try {
    const result = await window.electronAPI.downloadModel(selectedModelId);
    if (!result.started) {
      downloadProgress.hidden = true;
      setHint(downloadStatus, result.error || 'Download failed to start', 'error');
    }
  } catch (err) {
    downloadProgress.hidden = true;
    setHint(downloadStatus, String(err), 'error');
  }
});

hfCancelDownloadBtn.addEventListener('click', async () => {
  try {
    await window.electronAPI.cancelDownload();
  } catch (err) {
    setHint(downloadStatus, String(err), 'error');
  }
});

hfUseBtn.addEventListener('click', async () => {
  if (!selectedModelId) return;
  if (partialModels.includes(selectedModelId)) {
    setHint(
      hfStatus,
      `Cannot set ${selectedModelId} active: its download is incomplete. Download it again to finish, then set it active.`,
      'error'
    );
    return;
  }
  try {
    const result = await window.electronAPI.updateSettings({ activeModel: selectedModelId });
    applySettingsToForm(result.settings);
    activeModel = result.settings.activeModel;
    setHint(hfStatus, `Active model: ${activeModel || 'none (fallback chain)'}`, 'ok');
    await refreshModels();
  } catch (err) {
    setHint(hfStatus, String(err), 'error');
  }
});

// ---- Boot -------------------------------------------------------------------

window.electronAPI.onTranscriptionEvent(handleEvent);

window.electronAPI.requestStatus().then((status) => {
  updateStatus({ status: status.status as TranscriptionEvent['status'], text: status.text });
}).catch(() => {
  updateStatus({ status: 'idle' });
});

void loadSettings();
