import type { CallResult, RunConfig } from './types';

const API = 'https://generativelanguage.googleapis.com/v1beta';

/** Ověří JSON generationConfig; vrací objekt nebo vyhodí chybu s českou zprávou */
export function parseGenerationConfig(text: string): Record<string, unknown> | undefined {
  if (!text.trim()) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new Error(`generationConfig není platný JSON: ${(e as Error).message}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('generationConfig musí být JSON objekt');
  }
  return parsed as Record<string, unknown>;
}

export function buildBody(config: RunConfig, systemInstruction = config.systemInstruction, context = config.context) {
  const body: Record<string, unknown> = {
    contents: [{ role: 'user', parts: [{ text: context }] }],
  };
  if (systemInstruction.trim()) {
    body.systemInstruction = { parts: [{ text: systemInstruction }] };
  }
  const gen = parseGenerationConfig(config.generationConfig);
  if (gen) body.generationConfig = gen;
  return body;
}

function errorMessage(data: any, status: number): string {
  const e = data?.error;
  if (e?.message) return `${e.status ?? status}: ${e.message}`;
  return `HTTP ${status}`;
}

interface Acc {
  text: string;
  usage: any;
  finishReason: string | null;
  modelVersion: string | null;
}

function absorb(acc: Acc, chunk: any) {
  const cand = chunk?.candidates?.[0];
  for (const p of cand?.content?.parts ?? []) {
    if (typeof p.text === 'string' && !p.thought) acc.text += p.text;
  }
  if (cand?.finishReason) acc.finishReason = cand.finishReason;
  if (chunk?.usageMetadata) acc.usage = chunk.usageMetadata;
  if (chunk?.modelVersion) acc.modelVersion = chunk.modelVersion;
}

/** Provede jedno volání a změří čas. Nikdy nevyhazuje – chybu vrací ve výsledku. */
export async function callOnce(
  apiKey: string,
  config: RunConfig,
  body: unknown,
  index: number,
  signal: AbortSignal,
): Promise<CallResult> {
  const method = config.stream ? 'streamGenerateContent?alt=sse' : 'generateContent';
  const url = `${API}/models/${encodeURIComponent(config.model)}:${method}`;
  const startedAt = new Date().toISOString();
  const acc: Acc = { text: '', usage: null, finishReason: null, modelVersion: null };
  let httpStatus: number | null = null;
  let ttft: number | null = null;
  let error: string | null = null;

  const t0 = performance.now();
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify(body),
      signal,
    });
    httpStatus = res.status;
    if (!res.ok) {
      const data = await res.json().catch(() => null);
      error = errorMessage(data, res.status);
    } else if (config.stream && res.body) {
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (!payload || payload === '[DONE]') continue;
          try {
            absorb(acc, JSON.parse(payload));
            // TTFT = první úplný blok odpovědi ze streamu
            if (ttft === null) ttft = performance.now() - t0;
          } catch {
            /* neúplný řádek se ignoruje */
          }
        }
      }
    } else {
      absorb(acc, await res.json());
    }
  } catch (e) {
    error = (e as Error).name === 'AbortError' ? 'Přerušeno' : (e as Error).message || 'Chyba sítě';
  }
  const latencyMs = performance.now() - t0;

  if (!error && acc.finishReason && !['STOP', 'MAX_TOKENS'].includes(acc.finishReason) && !acc.text) {
    error = `Odpověď zablokována (${acc.finishReason})`;
  }

  const u = acc.usage ?? {};
  return {
    index,
    startedAt,
    ok: !error,
    httpStatus,
    latencyMs,
    ttftMs: config.stream ? ttft : null,
    error,
    promptTokens: u.promptTokenCount ?? null,
    outputTokens: u.candidatesTokenCount ?? null,
    thoughtsTokens: u.thoughtsTokenCount ?? null,
    totalTokens: u.totalTokenCount ?? null,
    finishReason: acc.finishReason,
    modelVersion: acc.modelVersion,
    text: acc.text,
  };
}
