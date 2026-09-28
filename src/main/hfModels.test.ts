import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  MAX_MODEL_SEARCH_RESULTS,
  buildModelSearchUrl,
  classifyRepo,
  formatDownloads,
  inspectInstalledModels,
  isAllowedHfHost,
  isCacheEntryComplete,
  listInstalledModels,
  parseModelList,
  searchHfModels,
} from './hfModels';

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

describe('classifyRepo', () => {
  it('classifies CTranslate2 (faster-whisper) repos', () => {
    expect(classifyRepo({ id: 'Systran/faster-whisper-base', tags: ['ctranslate2'] }).kind).toBe('ctranslate2');
    expect(classifyRepo({ id: 'Systran/faster-whisper-large-v3' }).kind).toBe('ctranslate2');
    expect(classifyRepo({ id: 'some/model', tags: ['ct2'] }).kind).toBe('ctranslate2');
  });

  it('classifies PyTorch ASR repos', () => {
    expect(classifyRepo({ id: 'openai/whisper-tiny', pipelineTag: 'automatic-speech-recognition' }).kind).toBe('pytorch');
    expect(classifyRepo({ id: 'openai/whisper-base' }).kind).toBe('pytorch');
    expect(classifyRepo({ id: 'custom/asr-model', tags: ['automatic-speech-recognition'] }).kind).toBe('pytorch');
  });

  it('marks ggml/whisper.cpp repos unsupported with a reason', () => {
    const byId = classifyRepo({ id: 'ggerganov/whisper.cpp' });
    expect(byId.kind).toBe('unsupported');
    expect(byId.reason).toContain('whisper.cpp');

    const byFile = classifyRepo({ id: 'x/y', files: ['ggml-tiny.bin'] });
    expect(byFile.kind).toBe('unsupported');
    expect(byFile.reason).toContain('ggml');

    expect(classifyRepo({ id: 'x/y', tags: ['ggml'] }).kind).toBe('unsupported');
  });

  it('marks pyannote diarization repos unsupported', () => {
    const result = classifyRepo({ id: 'pyannote/voice-activity-detection' });
    expect(result.kind).toBe('unsupported');
    expect(result.reason).toContain('diarization');
  });

  it('marks WhisperKit/CoreML and MLX repos unsupported', () => {
    expect(classifyRepo({ id: 'argmaxinc/whisperkit-coreml' }).kind).toBe('unsupported');
    expect(classifyRepo({ id: 'x/y', files: ['model.mlpackage/Weights'] }).kind).toBe('unsupported');
    expect(classifyRepo({ id: 'mlx-community/whisper-large-v3-turbo' }).kind).toBe('unsupported');
  });

  it('marks non-ASR models unsupported', () => {
    const result = classifyRepo({ id: 'sentence-transformers/all-MiniLM-L6-v2', pipelineTag: 'feature-extraction' });
    expect(result.kind).toBe('unsupported');
    expect(result.reason).toContain('automatic-speech-recognition');
  });
});

describe('buildModelSearchUrl', () => {
  it('builds the ASR search URL with a query', () => {
    const url = buildModelSearchUrl('faster whisper');
    expect(url).toContain('https://huggingface.co/api/models?');
    expect(url).toContain('pipeline_tag=automatic-speech-recognition');
    expect(url).toContain('sort=downloads');
    expect(url).toContain('direction=-1');
    const parsed = new URL(url);
    expect(parsed.searchParams.get('search')).toBe('faster whisper');
    expect(parsed.searchParams.get('pipeline_tag')).toBe('automatic-speech-recognition');
  });

  it('omits the search term for the top-models listing', () => {
    const url = buildModelSearchUrl('   ');
    expect(url).not.toContain('search=');
    expect(url).toContain('pipeline_tag=automatic-speech-recognition');
    expect(url).toContain('sort=downloads');
  });
});

describe('isAllowedHfHost', () => {
  it('allows Hugging Face hosts and CDNs only', () => {
    expect(isAllowedHfHost('huggingface.co')).toBe(true);
    expect(isAllowedHfHost('www.huggingface.co')).toBe(true);
    expect(isAllowedHfHost('cdn-lfs.huggingface.co')).toBe(true);
    expect(isAllowedHfHost('hf.co')).toBe(true);
    expect(isAllowedHfHost('cas-bridge.xethub.hf.co')).toBe(true);
    expect(isAllowedHfHost('evil.example.com')).toBe(false);
    expect(isAllowedHfHost('huggingface.co.evil.com')).toBe(false);
    expect(isAllowedHfHost('')).toBe(false);
  });
});

describe('parseModelList', () => {
  it('maps rows and classifies them', () => {
    const rows = parseModelList([
      {
        id: 'Systran/faster-whisper-base',
        downloads: 1654216,
        tags: ['ctranslate2', 'automatic-speech-recognition'],
        pipeline_tag: 'automatic-speech-recognition',
      },
      { id: 'openai/whisper-tiny', downloads: 10, pipeline_tag: 'automatic-speech-recognition' },
      { modelId: 'ggerganov/whisper.cpp', downloads: 5 },
      { downloads: 3 },
      'not-an-object',
    ]);

    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({ id: 'Systran/faster-whisper-base', downloads: 1654216, kind: 'ctranslate2', format: 'CTranslate2' });
    expect(rows[1].kind).toBe('pytorch');
    expect(rows[2].kind).toBe('unsupported');
    expect(rows[2].id).toBe('ggerganov/whisper.cpp');
  });

  it('returns an empty list for a non-array payload', () => {
    expect(parseModelList({ error: 'rate limited' })).toEqual([]);
    expect(parseModelList(null)).toEqual([]);
  });
});

describe('formatDownloads', () => {
  it('formats large counters', () => {
    expect(formatDownloads(0)).toBe('0');
    expect(formatDownloads(999)).toBe('999');
    expect(formatDownloads(1654216)).toBe('1.7M');
    expect(formatDownloads(12345)).toBe('12.3k');
  });
});

describe('listInstalledModels', () => {
  it('lists cache entries that contain snapshot files', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nadabodha-hf-'));
    const good = path.join(dir, 'models--Systran--faster-whisper-base', 'snapshots', 'abc');
    fs.mkdirSync(good, { recursive: true });
    fs.writeFileSync(path.join(good, 'model.bin'), 'x');

    const emptySnap = path.join(dir, 'models--org--model', 'snapshots', 'abc');
    fs.mkdirSync(emptySnap, { recursive: true });

    fs.mkdirSync(path.join(dir, 'models--org--incomplete'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'unrelated-dir'), { recursive: true });

    expect(listInstalledModels(dir)).toEqual(['Systran/faster-whisper-base']);
    expect(listInstalledModels('')).toEqual([]);
    expect(listInstalledModels(path.join(dir, 'missing'))).toEqual([]);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('inspectInstalledModels', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nadabodha-hf-state-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function repoDir(repoId: string): string {
    return path.join(dir, `models--${repoId.replace('/', '--')}`);
  }

  function snapshot(repoId: string, revision = 'abc'): { revisionDir: string } {
    const revisionDir = path.join(repoDir(repoId), 'snapshots', revision);
    fs.mkdirSync(revisionDir, { recursive: true });
    fs.writeFileSync(path.join(revisionDir, 'config.json'), '{"model_type":"whisper"}');
    fs.writeFileSync(path.join(revisionDir, 'model.bin'), 'weights');
    return { revisionDir };
  }

  it('separates loadable snapshots from interrupted ones', () => {
    snapshot('Systran/faster-whisper-base');

    // Partial: weights landed but the config never did.
    const partialRev = path.join(repoDir('org/partial-model'), 'snapshots', 'abc');
    fs.mkdirSync(partialRev, { recursive: true });
    fs.writeFileSync(path.join(partialRev, 'model.bin'), 'weights');

    // Partial: folder exists, nothing was written yet.
    fs.mkdirSync(repoDir('org/no-snapshots'), { recursive: true });

    // Not a model at all.
    fs.mkdirSync(path.join(dir, 'unrelated-dir'), { recursive: true });

    expect(inspectInstalledModels(dir)).toEqual({
      installed: ['Systran/faster-whisper-base'],
      partial: ['org/no-snapshots', 'org/partial-model'],
    });
  });

  it('rejects empty weights, dangling symlinks and unresolved refs', () => {
    const { revisionDir } = snapshot('org/model');

    fs.writeFileSync(path.join(revisionDir, 'model.bin'), '');
    expect(isCacheEntryComplete(repoDir('org/model'))).toBe(false);

    fs.writeFileSync(path.join(revisionDir, 'model.bin'), 'weights');
    fs.unlinkSync(path.join(revisionDir, 'model.bin'));
    fs.symlinkSync(path.join(repoDir('org/model'), 'blobs', 'missing'), path.join(revisionDir, 'model.bin'));
    expect(isCacheEntryComplete(repoDir('org/model'))).toBe(false);

    fs.unlinkSync(path.join(revisionDir, 'model.bin'));
    fs.writeFileSync(path.join(revisionDir, 'model.bin'), 'weights');
    expect(isCacheEntryComplete(repoDir('org/model'))).toBe(true);

    fs.mkdirSync(path.join(repoDir('org/model'), 'refs'), { recursive: true });
    fs.writeFileSync(path.join(repoDir('org/model'), 'refs', 'main'), 'gone');
    expect(isCacheEntryComplete(repoDir('org/model'))).toBe(false);

    fs.writeFileSync(path.join(repoDir('org/model'), 'refs', 'main'), 'abc');
    expect(isCacheEntryComplete(repoDir('org/model'))).toBe(true);
  });

  it('rejects a cache entry carrying an interrupted transfer marker', () => {
    snapshot('org/model');
    const blobs = path.join(repoDir('org/model'), 'blobs');
    fs.mkdirSync(blobs, { recursive: true });
    fs.writeFileSync(path.join(blobs, 'model.bin.incomplete'), 'half');

    expect(inspectInstalledModels(dir)).toEqual({ installed: [], partial: ['org/model'] });
  });

  it('requires every shard named by a weight index', () => {
    const { revisionDir } = snapshot('org/sharded');
    fs.unlinkSync(path.join(revisionDir, 'model.bin'));
    fs.writeFileSync(path.join(revisionDir, 'model-00001-of-00002.safetensors'), 'a');
    fs.writeFileSync(
      path.join(revisionDir, 'model.safetensors.index.json'),
      JSON.stringify({
        weight_map: {
          'layer.0': 'model-00001-of-00002.safetensors',
          'layer.1': 'model-00002-of-00002.safetensors',
        },
      })
    );
    expect(isCacheEntryComplete(repoDir('org/sharded'))).toBe(false);

    fs.writeFileSync(path.join(revisionDir, 'model-00002-of-00002.safetensors'), 'b');
    expect(isCacheEntryComplete(repoDir('org/sharded'))).toBe(true);
  });

  it('returns nothing for a blank or missing cache directory', () => {
    expect(inspectInstalledModels('')).toEqual({ installed: [], partial: [] });
    expect(inspectInstalledModels('   ')).toEqual({ installed: [], partial: [] });
    expect(inspectInstalledModels(path.join(dir, 'missing'))).toEqual({ installed: [], partial: [] });
  });
});

describe('search limits', () => {
  it('caps the number of rows requested from the API', () => {
    const url = buildModelSearchUrl('whisper');
    expect(url).toContain(`limit=${MAX_MODEL_SEARCH_RESULTS}`);
  });

  it('caps the parsed result even if the server ignores the limit', () => {
    const rows = Array.from({ length: MAX_MODEL_SEARCH_RESULTS + 25 }, (_, index) => ({
      id: `org/model-${index}`,
      pipeline_tag: 'automatic-speech-recognition',
    }));
    expect(parseModelList(rows)).toHaveLength(MAX_MODEL_SEARCH_RESULTS);
  });
});

describe('searchHfModels', () => {
  const cacheDir = '';
  const activeModel = '';

  it('fetches from Hugging Face and classifies results', async () => {
    const seenUrls: string[] = [];
    const fetchImpl = async (url: string) => {
      seenUrls.push(url);
      return jsonResponse([{ id: 'Systran/faster-whisper-base', downloads: 10, tags: ['ctranslate2'] }]);
    };

    const result = await searchHfModels('faster', cacheDir, activeModel, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(result.error).toBeUndefined();
    expect(result.models).toHaveLength(1);
    expect(result.models[0].kind).toBe('ctranslate2');
    expect(seenUrls[0]).toContain('https://huggingface.co/api/models?');
    expect(seenUrls[0]).toContain('search=faster');
  });

  it('blocks requests to non-Hugging-Face hosts', async () => {
    const fetchImpl = async () => jsonResponse([]);
    const result = await searchHfModels('', cacheDir, activeModel, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      baseUrl: 'https://evil.example.com',
    });
    expect(result.error).toContain('Blocked request to non-Hugging-Face host');
    expect(result.models).toEqual([]);
  });

  it('surfaces HTTP failures inline', async () => {
    const fetchImpl = async () => jsonResponse({ error: 'too many requests' }, 429);
    const result = await searchHfModels('', cacheDir, activeModel, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(result.error).toContain('HTTP 429');
  });

  it('surfaces network failures inline', async () => {
    const fetchImpl = async () => {
      throw new Error('ECONNREFUSED');
    };
    const result = await searchHfModels('', cacheDir, activeModel, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(result.error).toContain('ECONNREFUSED');
  });

  it('reports partial snapshots even when the search fails', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nadabodha-hf-partial-'));
    try {
      const partialRev = path.join(dir, 'models--org--interrupted', 'snapshots', 'abc');
      fs.mkdirSync(partialRev, { recursive: true });
      fs.writeFileSync(path.join(partialRev, 'model.bin'), 'weights');

      const result = await searchHfModels('', dir, activeModel, {
        fetchImpl: (async () => {
          throw new Error('ECONNREFUSED');
        }) as unknown as typeof fetch,
      });

      expect(result.installed).toEqual([]);
      expect(result.partial).toEqual(['org/interrupted']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
