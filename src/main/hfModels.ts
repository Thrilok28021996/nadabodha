import fs from 'fs';
import path from 'path';
import {
  HfModelInfo,
  HfModelListResult,
  HfRepoKind,
} from '../shared/ipc';

/**
 * Hugging Face model browser helpers: search URL construction, response
 * parsing, repo classification (which loader can run a repo locally) and
 * installed-model discovery in the configured cache directory.
 *
 * Network policy: model metadata is only ever fetched from huggingface.co
 * (see isAllowedHfHost); the renderer cannot fetch at all (CSP default-src
 * 'self'), so every request goes through the main process.
 */

export const HF_API_BASE = 'https://huggingface.co';
export const ASR_PIPELINE_TAG = 'automatic-speech-recognition';

export interface RepoClassification {
  kind: HfRepoKind;
  format: string;
  reason?: string;
}

export interface ClassifyInput {
  id: string;
  tags?: string[];
  files?: string[];
  pipelineTag?: string | null;
}

function hasFileMatching(files: string[], pattern: RegExp): boolean {
  return files.some((file) => pattern.test(file.toLowerCase()));
}

/**
 * Decides which local loader (if any) can run a repository:
 *  - ctranslate2  -> faster-whisper
 *  - pytorch      -> transformers Whisper pipeline
 *  - unsupported  -> surfaced in the UI as non-selectable with a reason
 */
export function classifyRepo(input: ClassifyInput): RepoClassification {
  const id = (input.id || '').toLowerCase();
  const tags = (input.tags || []).map((tag) => tag.toLowerCase());
  const files = (input.files || []).map((file) => file.toLowerCase());
  const pipelineTag = (input.pipelineTag || '').toLowerCase();

  // Diarization-only models (pyannote) are not speech-to-text.
  if (
    id.startsWith('pyannote/') ||
    tags.includes('pyannote') ||
    pipelineTag === 'audio-speaker-diarization'
  ) {
    return {
      kind: 'unsupported',
      format: 'Diarization',
      reason: 'pyannote diarization model — speaker separation, not transcription',
    };
  }

  // ggml / whisper.cpp weights: the app does not bundle whisper.cpp.
  if (
    tags.includes('ggml') ||
    tags.includes('whisper.cpp') ||
    id.includes('whisper.cpp') ||
    hasFileMatching(files, /(^|\/)ggml[^/]*\.bin$/) ||
    hasFileMatching(files, /\.(ggml|gguf)$/)
  ) {
    return {
      kind: 'unsupported',
      format: 'ggml',
      reason: 'ggml/whisper.cpp weights — this app does not bundle whisper.cpp',
    };
  }

  // Apple CoreML / WhisperKit packages.
  if (
    id.startsWith('argmaxinc/whisperkit') ||
    tags.includes('coreml') ||
    hasFileMatching(files, /\.mlpackage(\/|$)/) ||
    hasFileMatching(files, /\.mlmodelc/)
  ) {
    return {
      kind: 'unsupported',
      format: 'CoreML',
      reason: 'CoreML/WhisperKit package — not loadable by this app',
    };
  }

  // Apple MLX weights.
  if (id.startsWith('mlx-community/') || tags.includes('mlx')) {
    return {
      kind: 'unsupported',
      format: 'MLX',
      reason: 'MLX weights — this app runs faster-whisper/transformers, not MLX',
    };
  }

  // CTranslate2 (faster-whisper) checkpoints.
  if (tags.includes('ctranslate2') || tags.includes('ct2') || id.includes('faster-whisper')) {
    return { kind: 'ctranslate2', format: 'CTranslate2' };
  }

  // PyTorch / safetensors ASR checkpoints (openai/whisper-* and friends).
  if (
    pipelineTag === ASR_PIPELINE_TAG ||
    tags.includes(ASR_PIPELINE_TAG) ||
    tags.includes('whisper') ||
    id.includes('whisper')
  ) {
    return { kind: 'pytorch', format: 'PyTorch' };
  }

  return {
    kind: 'unsupported',
    format: 'Unsupported',
    reason: 'Not an automatic-speech-recognition model',
  };
}

/** Only Hugging Face hosts (and their CDN/mirror domains) may be contacted. */
export function isAllowedHfHost(hostname: string): boolean {
  const host = (hostname || '').toLowerCase();
  if (!host) {
    return false;
  }
  return (
    host === 'huggingface.co' ||
    host.endsWith('.huggingface.co') ||
    host === 'hf.co' ||
    host.endsWith('.hf.co')
  );
}

/** Caps how many rows a single search returns (HF's default is 1000). */
export const MAX_MODEL_SEARCH_RESULTS = 50;

/**
 * Builds the model search URL. An empty query yields the "top models"
 * listing (sorted by downloads, ASR pipeline only).
 */
export function buildModelSearchUrl(query?: string, base: string = HF_API_BASE): string {
  const params = new URLSearchParams();
  params.set('pipeline_tag', ASR_PIPELINE_TAG);
  const trimmed = (query || '').trim();
  if (trimmed) {
    params.set('search', trimmed);
  }
  params.set('sort', 'downloads');
  params.set('direction', '-1');
  params.set('limit', String(MAX_MODEL_SEARCH_RESULTS));
  return `${base}/api/models?${params.toString()}`;
}

interface RawHfModel {
  id?: unknown;
  modelId?: unknown;
  downloads?: unknown;
  tags?: unknown;
  pipeline_tag?: unknown;
  siblings?: unknown;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((entry): entry is string => typeof entry === 'string');
}

function fileNames(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const names: string[] = [];
  for (const entry of value) {
    if (entry && typeof entry === 'object' && typeof (entry as { rfilename?: unknown }).rfilename === 'string') {
      names.push((entry as { rfilename: string }).rfilename);
    } else if (typeof entry === 'string') {
      names.push(entry);
    }
  }
  return names;
}

/** Parses the HF /api/models response into classified rows for the UI. */
export function parseModelList(payload: unknown): HfModelInfo[] {
  if (!Array.isArray(payload)) {
    return [];
  }
  const rows: HfModelInfo[] = [];
  for (const entry of payload as RawHfModel[]) {
    if (!entry || typeof entry !== 'object') {
      continue;
    }
    const id = typeof entry.id === 'string' ? entry.id : typeof entry.modelId === 'string' ? entry.modelId : '';
    if (!id) {
      continue;
    }
    const tags = stringArray(entry.tags);
    const pipelineTag = typeof entry.pipeline_tag === 'string' ? entry.pipeline_tag : null;
    const classification = classifyRepo({ id, tags, pipelineTag, files: fileNames(entry.siblings) });
    rows.push({
      id,
      downloads: typeof entry.downloads === 'number' ? entry.downloads : 0,
      pipelineTag,
      tags,
      kind: classification.kind,
      reason: classification.reason,
      format: classification.format,
    });
  }
  // Defensive cap: the URL already asks HF for at most MAX rows.
  return rows.slice(0, MAX_MODEL_SEARCH_RESULTS);
}

export function formatDownloads(downloads: number): string {
  if (!Number.isFinite(downloads) || downloads <= 0) {
    return '0';
  }
  if (downloads >= 1_000_000) {
    return `${(downloads / 1_000_000).toFixed(1)}M`;
  }
  if (downloads >= 1_000) {
    return `${(downloads / 1_000).toFixed(1)}k`;
  }
  return String(downloads);
}

/**
 * Lists models already present in the cache directory
 * (<cacheDir>/models--org--name/snapshots/<rev>/...).
 *
 * This is the loose "something is on disk" check. Use
 * {@link inspectInstalledModels} to tell complete snapshots from partial
 * (interrupted) ones - only complete ones may be offered as installed.
 */
export function listInstalledModels(cacheDir: string): string[] {
  if (!cacheDir || !cacheDir.trim()) {
    return [];
  }
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(cacheDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const installed: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith('models--')) {
      continue;
    }
    const remainder = entry.name.slice('models--'.length);
    const separator = remainder.indexOf('--');
    if (separator <= 0) {
      continue;
    }
    const repoId = `${remainder.slice(0, separator)}/${remainder.slice(separator + 2)}`;
    const snapshotsDir = path.join(cacheDir, entry.name, 'snapshots');
    try {
      const revisions = fs.readdirSync(snapshotsDir);
      const hasFiles = revisions.some((rev) => {
        try {
          return fs.readdirSync(path.join(snapshotsDir, rev)).length > 0;
        } catch {
          return false;
        }
      });
      if (hasFiles) {
        installed.push(repoId);
      }
    } catch {
      // Incomplete download (no snapshots yet) -> not installed.
    }
  }
  return installed.sort();
}

export interface InstalledModelInspection {
  /** Snapshots that can actually be loaded (safe to set active). */
  installed: string[];
  /** Repo folders with files, but incomplete (cancelled/failed download). */
  partial: string[];
}

const WEIGHT_FILE_RE = /\.(bin|safetensors|pt|pth|ckpt|onnx)$/i;
const WEIGHT_INDEX_FILES = ['model.safetensors.index.json', 'pytorch_model.bin.index.json'];

function nonEmptyFile(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isFile() && fs.statSync(filePath).size > 0;
  } catch {
    return false;
  }
}

/** Collects every file below `dir`; returns null when a link is dangling. */
function collectFiles(dir: string, out: string[] = []): string[] | null {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    let isDirectory: boolean;
    try {
      isDirectory = fs.statSync(full).isDirectory(); // follows symlinks
    } catch {
      return null; // dangling symlink: the blob never landed
    }
    if (isDirectory) {
      const nested = collectFiles(full, out);
      if (!nested) {
        return null;
      }
    } else {
      out.push(full);
    }
  }
  return out;
}

function revisionLoadable(revisionDir: string): boolean {
  const files = collectFiles(revisionDir);
  if (!files || files.length === 0) {
    return false;
  }
  if (!nonEmptyFile(path.join(revisionDir, 'config.json'))) {
    return false;
  }
  const weights = files.filter((file) => WEIGHT_FILE_RE.test(path.basename(file)));
  if (weights.length === 0 || weights.some((file) => !nonEmptyFile(file))) {
    return false;
  }
  // Sharded checkpoints: every shard named by the index must be present.
  for (const indexName of WEIGHT_INDEX_FILES) {
    const indexPath = path.join(revisionDir, indexName);
    if (!fs.existsSync(indexPath)) {
      continue;
    }
    try {
      const parsed = JSON.parse(fs.readFileSync(indexPath, 'utf8')) as {
        weight_map?: Record<string, unknown>;
      };
      const weightMap = parsed.weight_map;
      if (!weightMap || typeof weightMap !== 'object') {
        return false;
      }
      for (const shard of new Set(Object.values(weightMap).map(String))) {
        if (!nonEmptyFile(path.join(revisionDir, shard))) {
          return false;
        }
      }
    } catch {
      return false;
    }
  }
  return true;
}

function hasIncompleteBlob(dir: string): boolean {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (hasIncompleteBlob(path.join(dir, entry.name))) {
        return true;
      }
    } else if (entry.name.endsWith('.incomplete')) {
      return true;
    }
  }
  return false;
}

/** True only when the cache entry holds a snapshot that can be loaded. */
export function isCacheEntryComplete(repoDir: string): boolean {
  const snapshotsDir = path.join(repoDir, 'snapshots');
  let revisions: string[];
  try {
    revisions = fs.readdirSync(snapshotsDir);
  } catch {
    return false; // folder exists but no snapshot landed yet
  }
  if (hasIncompleteBlob(repoDir)) {
    return false; // interrupted transfer marker still on disk
  }
  const refsDir = path.join(repoDir, 'refs');
  if (fs.existsSync(refsDir)) {
    try {
      for (const ref of fs.readdirSync(refsDir)) {
        const target = fs.readFileSync(path.join(refsDir, ref), 'utf8').trim();
        if (!target || !fs.existsSync(path.join(snapshotsDir, target))) {
          return false;
        }
      }
    } catch {
      return false;
    }
  }
  return revisions.some((revision) => revisionLoadable(path.join(snapshotsDir, revision)));
}

/**
 * Splits every `models--*` folder in the cache into complete (installed)
 * and partial (interrupted) entries. A partial snapshot is offered for
 * re-download, never as an installed/usable model.
 */
export function inspectInstalledModels(cacheDir: string): InstalledModelInspection {
  const result: InstalledModelInspection = { installed: [], partial: [] };
  if (!cacheDir || !cacheDir.trim()) {
    return result;
  }
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(cacheDir, { withFileTypes: true });
  } catch {
    return result;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith('models--')) {
      continue;
    }
    const remainder = entry.name.slice('models--'.length);
    const separator = remainder.indexOf('--');
    if (separator <= 0) {
      continue;
    }
    const repoId = `${remainder.slice(0, separator)}/${remainder.slice(separator + 2)}`;
    const repoDir = path.join(cacheDir, entry.name);
    if (isCacheEntryComplete(repoDir)) {
      result.installed.push(repoId);
    } else {
      result.partial.push(repoId);
    }
  }
  result.installed.sort();
  result.partial.sort();
  return result;
}

export interface ModelSearchDeps {
  fetchImpl?: typeof fetch;
  baseUrl?: string;
  timeoutMs?: number;
}

/** Fetches + classifies models. Contacts huggingface.co only. */
export async function searchHfModels(
  query: string,
  cacheDir: string,
  activeModel: string,
  deps: ModelSearchDeps = {}
): Promise<HfModelListResult> {
  const fetchImpl = deps.fetchImpl || fetch;
  const url = buildModelSearchUrl(query, deps.baseUrl || HF_API_BASE);
  // Local cache inspection never touches the network, so it runs first and
  // is returned on every path (including failures): partial snapshots must
  // stay visible even when search is offline.
  const inspection = inspectInstalledModels(cacheDir);
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    return {
      models: [],
      installed: inspection.installed,
      partial: inspection.partial,
      activeModel,
      error: `Invalid URL: ${url}`,
    };
  }
  if (!isAllowedHfHost(parsedUrl.hostname)) {
    return {
      models: [],
      installed: inspection.installed,
      partial: inspection.partial,
      activeModel,
      error: `Blocked request to non-Hugging-Face host: ${parsedUrl.hostname}`,
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deps.timeoutMs ?? 20000);
  try {
    const response = await fetchImpl(url, { signal: controller.signal });
    if (!response.ok) {
      return {
        models: [],
        installed: inspection.installed,
        partial: inspection.partial,
        activeModel,
        error: `Hugging Face search failed: HTTP ${response.status}`,
      };
    }
    const payload: unknown = await response.json();
    return {
      models: parseModelList(payload),
      installed: inspection.installed,
      partial: inspection.partial,
      activeModel,
    };
  } catch (err) {
    return {
      models: [],
      installed: inspection.installed,
      partial: inspection.partial,
      activeModel,
      error: `Hugging Face search failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  } finally {
    clearTimeout(timer);
  }
}
