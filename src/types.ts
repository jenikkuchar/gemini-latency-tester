export interface RunConfig {
  model: string;
  systemInstruction: string;
  context: string;
  calls: number;
  pauseMs: number;
  stream: boolean;
  /** Volitelný generationConfig jako JSON text (prázdné = výchozí hodnoty modelu) */
  generationConfig: string;
}

export interface CallResult {
  index: number;
  startedAt: string;
  ok: boolean;
  httpStatus: number | null;
  /** Celková doba od odeslání požadavku po přijetí celé odpovědi */
  latencyMs: number;
  /** Doba do prvního bloku odpovědi (jen ve streamingu) */
  ttftMs: number | null;
  error: string | null;
  promptTokens: number | null;
  outputTokens: number | null;
  thoughtsTokens: number | null;
  totalTokens: number | null;
  finishReason: string | null;
  modelVersion: string | null;
  text: string;
  /** Skutečně odeslané texty po dosazení proměnných (jen pokud šablona proměnné obsahuje) */
  renderedSystemInstruction?: string | null;
  renderedContext?: string | null;
}

export type RunStatus = 'running' | 'done' | 'aborted';

export interface Run {
  id: string;
  startedAt: string;
  finishedAt: string | null;
  status: RunStatus;
  config: RunConfig;
  results: CallResult[];
}

export interface SeriesStats {
  count: number;
  min: number;
  max: number;
  mean: number;
  median: number;
  p90: number;
  p95: number;
  p99: number;
  stddev: number;
}

export interface RunStats {
  total: number;
  ok: number;
  errors: number;
  errorRate: number;
  latency: SeriesStats | null;
  ttft: SeriesStats | null;
  avgOutputTokens: number | null;
  avgPromptTokens: number | null;
  avgThoughtsTokens: number | null;
  /** Průměrná rychlost generování výstupních tokenů (tok/s) */
  tokensPerSec: number | null;
}

export interface ModelInfo {
  id: string;
  displayName: string;
}
