import { TranscriptionEvent } from '../shared/ipc';
import {
  Summarizer,
  buildChatCompletionRequest,
  buildUserPrompt,
  listLlmModels,
  normalizeBaseUrl,
} from './summarizer';

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function abortError(): Error {
  const err = new Error('The operation was aborted');
  err.name = 'AbortError';
  return err;
}

describe('normalizeBaseUrl', () => {
  it('trims whitespace and trailing slashes', () => {
    expect(normalizeBaseUrl(' http://127.0.0.1:1234/v1/ ')).toBe('http://127.0.0.1:1234/v1');
    expect(normalizeBaseUrl('http://127.0.0.1:1234/v1///')).toBe('http://127.0.0.1:1234/v1');
    expect(normalizeBaseUrl('')).toBe('');
  });
});

describe('buildChatCompletionRequest', () => {
  it('builds a POST to <base>/chat/completions without auth when no key', () => {
    const spec = buildChatCompletionRequest({
      baseUrl: 'http://127.0.0.1:1234/v1/',
      model: 'neohorse-1-4b-mlx',
      userPrompt: 'Summarize this: hello world',
      temperature: 0,
    });

    expect(spec.url).toBe('http://127.0.0.1:1234/v1/chat/completions');
    expect(spec.init.method).toBe('POST');
    const headers = spec.init.headers as Record<string, string>;
    expect(headers['Content-Type']).toBe('application/json');
    expect(headers.Authorization).toBeUndefined();

    const body = JSON.parse(spec.init.body as string);
    expect(body.model).toBe('neohorse-1-4b-mlx');
    expect(body.stream).toBe(false);
    expect(body.temperature).toBe(0);
    expect(body.messages).toEqual([{ role: 'user', content: 'Summarize this: hello world' }]);
  });

  it('sends an Authorization header when an API key is configured', () => {
    const spec = buildChatCompletionRequest({
      baseUrl: 'http://127.0.0.1:1234/v1',
      model: 'm',
      apiKey: ' secret-key ',
      systemPrompt: 'You are terse.',
      userPrompt: 'go',
      maxTokens: 256,
    });
    const headers = spec.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer secret-key');
    const body = JSON.parse(spec.init.body as string);
    expect(body.messages[0]).toEqual({ role: 'system', content: 'You are terse.' });
    expect(body.messages[1]).toEqual({ role: 'user', content: 'go' });
    expect(body.max_tokens).toBe(256);
  });
});

describe('buildUserPrompt', () => {
  it('substitutes the transcript placeholder', () => {
    expect(buildUserPrompt('Summarize:\n{{transcript}}', 'the transcript body')).toBe(
      'Summarize:\nthe transcript body'
    );
    expect(buildUserPrompt('T: {{ transcript }}!', 'abc')).toBe('T: abc!');
  });

  it('appends the transcript when the template has no placeholder', () => {
    expect(buildUserPrompt('Just summarize.', 'abc')).toBe('Just summarize.\n\nTranscript:\nabc');
    expect(buildUserPrompt('', 'abc')).toBe('Transcript:\nabc');
  });
});

describe('Summarizer', () => {
  it('emits progress then completion and returns the summary', async () => {
    const events: TranscriptionEvent[] = [];
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return jsonResponse({
        choices: [{ message: { role: 'assistant', content: '  A summary.  ' } }],
      });
    };

    const summarizer = new Summarizer((event) => events.push(event), fetchImpl);
    const outcome = await summarizer.summarize({
      baseUrl: 'http://127.0.0.1:1234/v1',
      model: 'neohorse-1-4b-mlx',
      transcript: 'hello world',
      template: 'Summarize {{transcript}}',
    });

    expect(outcome).toEqual({ ok: true, text: 'A summary.' });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('http://127.0.0.1:1234/v1/chat/completions');
    const body = JSON.parse(calls[0].init?.body as string);
    expect(body.model).toBe('neohorse-1-4b-mlx');
    expect(body.messages[0].content).toBe('Summarize hello world');

    expect(events.map((e) => e.status)).toEqual(['summarizing', 'summarizing', 'completed']);
    expect(events.every((e) => e.origin === 'summary')).toBe(true);
    expect(events[events.length - 1].text).toBe('A summary.');
  });

  it('reports an HTTP failure inline without throwing', async () => {
    const events: TranscriptionEvent[] = [];
    const fetchImpl = async () => jsonResponse({ error: 'model not loaded' }, 500);
    const summarizer = new Summarizer((event) => events.push(event), fetchImpl);

    const outcome = await summarizer.summarize({
      baseUrl: 'http://127.0.0.1:1234/v1',
      model: 'm',
      transcript: 'hello',
      template: '{{transcript}}',
    });

    expect(outcome.ok).toBe(false);
    expect(outcome.error).toContain('HTTP 500');
    expect(outcome.error).toContain('model not loaded');
    expect(events[events.length - 1].status).toBe('error');
    expect(events[events.length - 1].origin).toBe('summary');
  });

  it('reports a network failure without throwing', async () => {
    const events: TranscriptionEvent[] = [];
    const fetchImpl = async () => {
      throw new Error('ECONNREFUSED');
    };
    const summarizer = new Summarizer((event) => events.push(event), fetchImpl);

    const outcome = await summarizer.summarize({
      baseUrl: 'http://127.0.0.1:1234/v1',
      model: 'm',
      transcript: 'hello',
      template: '{{transcript}}',
    });

    expect(outcome.ok).toBe(false);
    expect(outcome.error).toContain('ECONNREFUSED');
    expect(events[events.length - 1].status).toBe('error');
  });

  it('handles cancellation as a cancelled event, not an error crash', async () => {
    const events: TranscriptionEvent[] = [];
    const fetchImpl = (_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(abortError()));
      });

    const summarizer = new Summarizer((event) => events.push(event), fetchImpl);
    const pending = summarizer.summarize({
      baseUrl: 'http://127.0.0.1:1234/v1',
      model: 'm',
      transcript: 'hello',
      template: '{{transcript}}',
      timeoutMs: 5000,
    });
    summarizer.cancel();
    const outcome = await pending;

    expect(outcome.ok).toBe(false);
    expect(outcome.cancelled).toBe(true);
    expect(events.map((e) => e.status)).toEqual(['summarizing', 'cancelled']);
    expect(events.every((e) => e.origin === 'summary')).toBe(true);
  });

  it('refuses to run without an LLM configuration', async () => {
    const events: TranscriptionEvent[] = [];
    let called = false;
    const fetchImpl = async () => {
      called = true;
      return jsonResponse({});
    };
    const summarizer = new Summarizer((event) => events.push(event), fetchImpl);

    const outcome = await summarizer.summarize({
      baseUrl: 'http://127.0.0.1:1234/v1',
      model: '',
      transcript: 'hello',
      template: '{{transcript}}',
    });

    expect(outcome.ok).toBe(false);
    expect(outcome.error).toContain('base URL and model');
    expect(called).toBe(false);
    expect(events[0].status).toBe('error');
  });

  it('refuses an empty transcript', async () => {
    const events: TranscriptionEvent[] = [];
    const summarizer = new Summarizer((event) => events.push(event), async () => jsonResponse({}));
    const outcome = await summarizer.summarize({
      baseUrl: 'http://127.0.0.1:1234/v1',
      model: 'm',
      transcript: '   ',
      template: '{{transcript}}',
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toContain('transcript is empty');
    expect(events[0].status).toBe('error');
  });

  it('reports an empty LLM response as an error', async () => {
    const events: TranscriptionEvent[] = [];
    const summarizer = new Summarizer((event) => events.push(event), async () =>
      jsonResponse({ choices: [{ message: { content: '' } }] })
    );
    const outcome = await summarizer.summarize({
      baseUrl: 'http://127.0.0.1:1234/v1',
      model: 'm',
      transcript: 'hello',
      template: '{{transcript}}',
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toContain('no content');
    expect(events[events.length - 1].status).toBe('error');
  });
});

describe('listLlmModels', () => {
  it('returns the model ids from GET /models', async () => {
    const seen: string[] = [];
    const fetchImpl = async (url: string) => {
      seen.push(url);
      return jsonResponse({ data: [{ id: 'qwen3.5-9b-mlx' }, { id: 'neohorse-1-4b-mlx' }, {}] });
    };
    const result = await listLlmModels('http://127.0.0.1:1234/v1/', fetchImpl);
    expect(seen[0]).toBe('http://127.0.0.1:1234/v1/models');
    expect(result.ok).toBe(true);
    expect(result.models).toEqual(['qwen3.5-9b-mlx', 'neohorse-1-4b-mlx']);
    expect(result.message).toContain('2 model(s)');
  });

  it('fails cleanly on HTTP errors', async () => {
    const result = await listLlmModels('http://127.0.0.1:1234/v1', async () =>
      jsonResponse({}, 503)
    );
    expect(result.ok).toBe(false);
    expect(result.message).toContain('HTTP 503');
  });

  it('fails cleanly when the server is unreachable', async () => {
    const result = await listLlmModels('http://127.0.0.1:59999/v1', async () => {
      throw new Error('connect ECONNREFUSED');
    });
    expect(result.ok).toBe(false);
    expect(result.message).toContain('ECONNREFUSED');
  });

  it('rejects an empty base URL without fetching', async () => {
    let called = false;
    const result = await listLlmModels('', async () => {
      called = true;
      return jsonResponse({});
    });
    expect(called).toBe(false);
    expect(result.ok).toBe(false);
    expect(result.message).toContain('empty');
  });
});
