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
  return rows;
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
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    return { models: [], installed: [], activeModel, error: `Invalid URL: ${url}` };
  }
  if (!isAllowedHfHost(parsedUrl.hostname)) {
    return {
      models: [],
      installed: [],
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
        installed: listInstalledModels(cacheDir),
        activeModel,
        error: `Hugging Face search failed: HTTP ${response.status}`,
      };
    }
    const payload: unknown = await response.json();
    return {
      models: parseModelList(payload),
      installed: listInstalledModels(cacheDir),
      activeModel,
    };
  } catch (err) {
    return {
      models: [],
      installed: listInstalledModels(cacheDir),
      activeModel,
      error: `Hugging Face search failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  } finally {
    clearTimeout(timer);
  }
}
