import type { CallResult, Run, RunStats, SeriesStats } from './types';

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 1) return sorted[0];
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

export function seriesStats(values: number[]): SeriesStats | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const mean = s.reduce((a, b) => a + b, 0) / s.length;
  const variance = s.length > 1 ? s.reduce((a, b) => a + (b - mean) ** 2, 0) / (s.length - 1) : 0;
  return {
    count: s.length,
    min: s[0],
    max: s[s.length - 1],
    mean,
    median: percentile(s, 50),
    p90: percentile(s, 90),
    p95: percentile(s, 95),
    p99: percentile(s, 99),
    stddev: Math.sqrt(variance),
  };
}

const avg = (xs: (number | null)[]) => {
  const v = xs.filter((x): x is number => x !== null);
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
};

export function runStats(results: CallResult[]): RunStats {
  const ok = results.filter(r => r.ok);
  const withCache = ok.filter(r => r.cachedTokens !== undefined && r.cachedTokens !== null);
  // Rychlost generování: výstupní tokeny / doba generování (ve streamingu bez TTFT)
  const tps = ok
    .map(r => {
      if (!r.outputTokens) return null;
      // Když stream dorazí prakticky najednou, doba generování by byla ~0 → použije se celá latence
      const streamMs = r.ttftMs !== null ? r.latencyMs - r.ttftMs : 0;
      const genMs = streamMs >= 100 ? streamMs : r.latencyMs;
      return genMs > 0 ? r.outputTokens / (genMs / 1000) : null;
    });
  return {
    total: results.length,
    ok: ok.length,
    errors: results.length - ok.length,
    errorRate: results.length ? (results.length - ok.length) / results.length : 0,
    latency: seriesStats(ok.map(r => r.latencyMs)),
    ttft: seriesStats(ok.map(r => r.ttftMs).filter((x): x is number => x !== null)),
    avgOutputTokens: avg(ok.map(r => r.outputTokens)),
    avgPromptTokens: avg(ok.map(r => r.promptTokens)),
    avgThoughtsTokens: avg(ok.map(r => r.thoughtsTokens)),
    cacheHitRate: avg(withCache.map(r => (r.cachedTokens! > 0 ? 1 : 0))),
    avgCachedShare: avg(withCache.map(r => (r.promptTokens ? r.cachedTokens! / r.promptTokens : null))),
    avgCachedTokens: avg(withCache.map(r => r.cachedTokens!)),
    tokensPerSec: avg(tps),
  };
}

export interface HistogramBin {
  label: string;
  from: number;
  to: number;
  count: number;
}

export function histogram(values: number[], bins = 10): HistogramBin[] {
  if (!values.length) return [];
  const min = Math.min(...values);
  const max = Math.max(...values);
  const n = Math.min(bins, Math.max(1, values.length));
  const width = (max - min) / n || 1;
  const out: HistogramBin[] = Array.from({ length: n }, (_, i) => ({
    from: min + i * width,
    to: min + (i + 1) * width,
    count: 0,
    label: '',
  }));
  for (const v of values) {
    const i = Math.min(n - 1, Math.floor((v - min) / width));
    out[i].count++;
  }
  for (const b of out) b.label = `${Math.round(b.from)}–${Math.round(b.to)}`;
  return out;
}

/* ---------- Export ---------- */

const csvCell = (v: unknown) => {
  if (v === null || v === undefined) return '';
  const s = typeof v === 'number' ? String(Math.round(v * 100) / 100) : String(v);
  return /[",;\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const toCsv = (rows: unknown[][]) => '﻿' + rows.map(r => r.map(csvCell).join(';')).join('\r\n');

export function callsCsv(runs: Run[]): string {
  const rows: unknown[][] = [[
    'run_id', 'model', 'stream', 'call', 'started_at', 'ok', 'http_status', 'latency_ms', 'ttft_ms',
    'prompt_tokens', 'cached_tokens', 'output_tokens', 'thoughts_tokens', 'total_tokens', 'finish_reason', 'model_version', 'error', 'response',
    'system_instruction', 'context',
  ]];
  for (const run of runs) {
    for (const r of run.results) {
      rows.push([
        run.id, run.config.model, run.config.stream, r.index, r.startedAt, r.ok, r.httpStatus, r.latencyMs, r.ttftMs,
        r.promptTokens, r.cachedTokens, r.outputTokens, r.thoughtsTokens, r.totalTokens, r.finishReason, r.modelVersion, r.error, r.text,
        r.renderedSystemInstruction ?? run.config.systemInstruction, r.renderedContext ?? run.config.context,
      ]);
    }
  }
  return toCsv(rows);
}

export function summaryCsv(runs: Run[]): string {
  const rows: unknown[][] = [[
    'run_id', 'started_at', 'model', 'stream', 'calls', 'pause_ms', 'ok', 'errors', 'error_rate',
    'lat_min', 'lat_mean', 'lat_median', 'lat_p90', 'lat_p95', 'lat_p99', 'lat_max', 'lat_stddev',
    'ttft_median', 'ttft_p95', 'avg_prompt_tokens', 'avg_cached_tokens', 'cache_hit_rate', 'avg_cached_share', 'avg_output_tokens', 'avg_thoughts_tokens', 'tokens_per_sec',
    'system_instruction', 'context', 'generation_config',
  ]];
  for (const run of runs) {
    const s = runStats(run.results);
    const l = s.latency;
    rows.push([
      run.id, run.startedAt, run.config.model, run.config.stream, s.total, run.config.pauseMs, s.ok, s.errors, s.errorRate,
      l?.min, l?.mean, l?.median, l?.p90, l?.p95, l?.p99, l?.max, l?.stddev,
      s.ttft?.median, s.ttft?.p95, s.avgPromptTokens, s.avgCachedTokens, s.cacheHitRate, s.avgCachedShare, s.avgOutputTokens, s.avgThoughtsTokens, s.tokensPerSec,
      run.config.systemInstruction, run.config.context, run.config.generationConfig,
    ]);
  }
  return toCsv(rows);
}

export function runsJson(runs: Run[]): string {
  return JSON.stringify(
    { exportedAt: new Date().toISOString(), runs: runs.map(r => ({ ...r, stats: runStats(r.results) })) },
    null,
    2,
  );
}

export function download(content: string, filename: string, type: string) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
