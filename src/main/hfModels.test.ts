import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  buildModelSearchUrl,
  classifyRepo,
  formatDownloads,
  isAllowedHfHost,
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
});
