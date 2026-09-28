import { TranscriptionEvent } from '../shared/ipc';

/**
 * Summarization against an OpenAI-compatible local server (LM Studio).
 *
 * Mirrors the transcription IPC semantics: progress -> completed/idle/cancel/
 * error events on the existing event stream (origin 'summary'). A failure is
 * always reported as an event + return value, never as a thrown error, so a
 * broken LLM configuration can never take the transcript down with it.
 */

export interface ChatCompletionOptions {
  baseUrl: string;
  model: string;
  apiKey?: string;
  systemPrompt?: string;
  userPrompt: string;
  temperature?: number;
  maxTokens?: number;
}

export interface RequestSpec {
  url: string;
  init: RequestInit;
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export function normalizeBaseUrl(baseUrl: string): string {
  let normalized = (baseUrl || '').trim();
  while (normalized.endsWith('/')) {
    normalized = normalized.slice(0, -1);
  }
  return normalized;
}

export function buildChatCompletionRequest(opts: ChatCompletionOptions): RequestSpec {
  const url = `${normalizeBaseUrl(opts.baseUrl)}/chat/completions`;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const apiKey = (opts.apiKey || '').trim();
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }

  const messages: Array<{ role: string; content: string }> = [];
  const systemPrompt = (opts.systemPrompt || '').trim();
  if (systemPrompt) {
    messages.push({ role: 'system', content: systemPrompt });
  }
  messages.push({ role: 'user', content: opts.userPrompt });

  const body: Record<string, unknown> = {
    model: opts.model,
    messages,
    temperature: opts.temperature ?? 0.2,
    stream: false,
  };
  if (typeof opts.maxTokens === 'number' && opts.maxTokens > 0) {
    body.max_tokens = opts.maxTokens;
  }

  return {
    url,
    init: {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    },
  };
}

const TRANSCRIPT_PLACEHOLDER = /\{\{\s*transcript\s*\}\}/g;
const TRANSCRIPT_PLACEHOLDER_TEST = /\{\{\s*transcript\s*\}\}/;

/** Substitutes {{transcript}} (or appends the transcript when absent). */
export function buildUserPrompt(template: string, transcript: string): string {
  const source = template || '';
  if (TRANSCRIPT_PLACEHOLDER_TEST.test(source)) {
    return source.replace(TRANSCRIPT_PLACEHOLDER, transcript);
  }
  const header = source.trim();
  return `${header}${header ? '\n\n' : ''}Transcript:\n${transcript}`;
}

export interface SummarizeOptions {
  baseUrl: string;
  model: string;
  apiKey?: string;
  transcript: string;
  template: string;
  timeoutMs?: number;
}

export interface SummarizeOutcome {
  ok: boolean;
  text?: string;
  error?: string;
  cancelled?: boolean;
}

function describeError(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
}

function isAbortError(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'name' in err &&
    (err as { name?: string }).name === 'AbortError'
  );
}

async function safeText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '';
  }
}

export class Summarizer {
  private controller: AbortController | null = null;
  private cancelled = false;
  private timedOut = false;

  constructor(
    private readonly onEvent: (event: TranscriptionEvent) => void,
    private readonly fetchImpl: FetchLike = (url, init) => fetch(url, init)
  ) {}

  isRunning(): boolean {
    return this.controller !== null;
  }

  cancel(): void {
    this.cancelled = true;
    try {
      this.controller?.abort();
    } catch {
      // Ignore: aborting twice is harmless.
    }
  }

  private emit(event: TranscriptionEvent): void {
    this.onEvent({ ...event, origin: 'summary' });
  }

  async summarize(opts: SummarizeOptions): Promise<SummarizeOutcome> {
    const baseUrl = (opts.baseUrl || '').trim();
    const model = (opts.model || '').trim();

    if (!baseUrl || !model) {
      const error = 'Summarization needs a local LLM: set the base URL and model in Settings.';
      this.emit({ status: 'error', error });
      return { ok: false, error };
    }

    if (!opts.transcript || !opts.transcript.trim()) {
      const error = 'Nothing to summarize: the transcript is empty.';
      this.emit({ status: 'error', error });
      return { ok: false, error };
    }

    this.cancelled = false;
    this.timedOut = false;
    this.controller = new AbortController();
    const timeoutMs = opts.timeoutMs ?? 300000;
    this.emit({ status: 'summarizing', progress: 10 });

    let timeoutHandle: NodeJS.Timeout | undefined;
    try {
      const spec = buildChatCompletionRequest({
        baseUrl,
        model,
        apiKey: opts.apiKey,
        userPrompt: buildUserPrompt(opts.template, opts.transcript),
      });

      timeoutHandle = setTimeout(() => {
        this.timedOut = true;
        this.controller?.abort();
      }, timeoutMs);

      let response: Response;
      try {
        response = await this.fetchImpl(spec.url, {
          ...spec.init,
          signal: this.controller.signal,
        });
      } finally {
        if (timeoutHandle) {
          clearTimeout(timeoutHandle);
        }
      }

      this.emit({ status: 'summarizing', progress: 60 });

      if (!response.ok) {
        const body = (await safeText(response)).trim();
        const detail = body ? `: ${body.slice(0, 300)}` : '';
        const error = `Summarization failed (HTTP ${response.status})${detail}`;
        this.emit({ status: 'error', error });
        return { ok: false, error };
      }

      let payload: unknown;
      try {
        payload = await response.json();
      } catch (err) {
        const error = `Summarization failed: invalid JSON response (${describeError(err)})`;
        this.emit({ status: 'error', error });
        return { ok: false, error };
      }

      const choices = (payload as { choices?: Array<{ message?: { content?: unknown } }> })?.choices;
      const content = choices?.[0]?.message?.content;
      const text = typeof content === 'string' ? content.trim() : '';
      if (!text) {
        const error = 'Summarization failed: the LLM returned no content.';
        this.emit({ status: 'error', error });
        return { ok: false, error };
      }

      this.emit({ status: 'completed', progress: 100, text });
      return { ok: true, text };
    } catch (err) {
      if (this.cancelled && !this.timedOut) {
        this.emit({ status: 'cancelled' });
        return { ok: false, cancelled: true, error: 'Summarization cancelled' };
      }
      if (this.timedOut || isAbortError(err)) {
        const error = `Summarization timed out after ${Math.round(timeoutMs / 1000)}s`;
        this.emit({ status: 'error', error });
        return { ok: false, error };
      }
      const error = `Summarization failed: ${describeError(err)}`;
      this.emit({ status: 'error', error });
      return { ok: false, error };
    } finally {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
      this.controller = null;
    }
  }
}

/**
 * GET <base>/models — used by "Test Connection" and to populate the model
 * dropdown. Returns a result object instead of throwing.
 */
export async function listLlmModels(
  baseUrl: string,
  fetchImpl: FetchLike = (url, init) => fetch(url, init),
  timeoutMs = 15000
): Promise<{ ok: boolean; models: string[]; message: string }> {
  const normalized = normalizeBaseUrl(baseUrl);
  if (!normalized) {
    return { ok: false, models: [], message: 'Base URL is empty' };
  }
  const url = `${normalized}/models`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, { method: 'GET', signal: controller.signal });
    if (!response.ok) {
      return { ok: false, models: [], message: `HTTP ${response.status} from ${url}` };
    }
    const payload = (await response.json()) as { data?: Array<{ id?: unknown }> };
    const models = Array.isArray(payload?.data)
      ? payload.data.map((entry) => (typeof entry?.id === 'string' ? entry.id : '')).filter(Boolean)
      : [];
    return { ok: true, models, message: `Connected — ${models.length} model(s) available` };
  } catch (err) {
    return {
      ok: false,
      models: [],
      message: `Cannot reach ${url}: ${isAbortError(err) ? 'timed out' : describeError(err)}`,
    };
  } finally {
    clearTimeout(timer);
  }
}
