import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Play,
  Square,
  Download,
  Trash2,
  KeyRound,
  Eye,
  EyeOff,
  ChevronDown,
  AlertTriangle,
  Gauge,
} from 'lucide-react';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
  ReferenceLine,
  Cell,
} from 'recharts';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

import type { CallResult, ModelInfo, Run, RunConfig } from './types';
import { buildBody, callOnce, parseGenerationConfig } from './gemini';
import { callsCsv, download, histogram, runStats, runsJson, summaryCsv } from './stats';
import { TEMPLATE_VARS, hasVariables, invalidVariables, renderTemplate } from './template';

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// Série grafů dle manuálu – pevné pořadí, v obou režimech stejné
const CHART = ['#0a84ff', '#30d158', '#ff9f0a', '#bf5af2', '#ff375f', '#64d2ff', '#ffd60a', '#ac8e68'];

interface ChartTheme {
  grid: string;
  axis: string;
  danger: string;
  cursor: string;
}
function readChartTheme(): ChartTheme {
  const s = getComputedStyle(document.documentElement);
  const v = (name: string) => s.getPropertyValue(name).trim();
  return { grid: v('--jk-chart-grid'), axis: v('--jk-chart-axis'), danger: v('--jk-danger'), cursor: v('--jk-fill') };
}
const TOOLTIP_STYLE = {
  backgroundColor: 'var(--jk-glass)',
  backdropFilter: 'blur(30px)',
  borderRadius: '14px',
  border: 'none',
  boxShadow: 'var(--jk-shadow-pop)',
  fontSize: '12px',
};
const TOOLTIP_LABEL_STYLE = { color: 'var(--jk-text)', fontWeight: 600 };
const TOOLTIP_ITEM_STYLE = { color: 'var(--jk-text)' };

// Český formát čísel
const nf = (n: number, digits = 0) =>
  n.toLocaleString('cs-CZ', { minimumFractionDigits: digits, maximumFractionDigits: digits });
const ms = (n: number | null | undefined) =>
  n === null || n === undefined ? '–' : n >= 10000 ? `${nf(n / 1000, 2)} s` : `${nf(n)} ms`;
// Popisky osy latence: do 1 s v ms, nad 1 s v sekundách, aby se vešly
const axisMs = (v: number) => (v === 0 ? '0' : v >= 1000 ? `${nf(v / 1000, v % 1000 ? 1 : 0)} s` : `${nf(v)} ms`);
const fmtDate = (iso: string) =>
  new Date(iso).toLocaleString('cs-CZ', { day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });

// Textové modely dle https://ai.google.dev/gemini-api/docs/models (bez TTS, Live, obrázků a vypnutých),
// v každé skupině od nejvyšší verze po nejnižší
const MODEL_GROUPS: { label: string; models: ModelInfo[] }[] = [
  {
    label: 'Pro',
    models: [
      { id: 'gemini-3.1-pro-preview', displayName: 'Gemini 3.1 Pro (preview)' },
      { id: 'gemini-2.5-pro', displayName: 'Gemini 2.5 Pro' },
    ],
  },
  {
    label: 'Flash',
    models: [
      { id: 'gemini-3.8-flash', displayName: 'Gemini 3.8 Flash' },
      { id: 'gemini-3.6-flash', displayName: 'Gemini 3.6 Flash' },
      { id: 'gemini-3-flash-preview', displayName: 'Gemini 3 Flash (preview)' },
      { id: 'gemini-2.5-flash', displayName: 'Gemini 2.5 Flash' },
    ],
  },
  {
    label: 'Flash-Lite',
    models: [
      { id: 'gemini-3.5-flash-lite', displayName: 'Gemini 3.5 Flash-Lite' },
      { id: 'gemini-3.1-flash-lite', displayName: 'Gemini 3.1 Flash-Lite' },
      { id: 'gemini-2.5-flash-lite', displayName: 'Gemini 2.5 Flash-Lite' },
    ],
  },
];

const DEFAULT_CONFIG: RunConfig = {
  model: 'gemini-3.8-flash',
  systemInstruction: '',
  context: 'Napiš jednu větu o tom, proč je rychlá odezva důležitá.',
  calls: 10,
  pauseMs: 100,
  stream: false,
  generationConfig: '',
};

// localStorage – vše jen v prohlížeči, chyby přístupu se tiše ignorují
const LS_KEY = 'gemini-tester:apiKey';
const LS_CONFIG = 'gemini-tester:config';
const LS_RUNS = 'gemini-tester:runs';
function lsGet<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    return v === null ? fallback : (JSON.parse(v) as T);
  } catch {
    return fallback;
  }
}
function lsSet(key: string, value: unknown) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* plné nebo blokované úložiště */
  }
}

const sleep = (msDelay: number, signal: AbortSignal) =>
  new Promise<void>(resolve => {
    if (msDelay <= 0 || signal.aborted) return resolve();
    const t = setTimeout(resolve, msDelay);
    signal.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
  });

export default function App() {
  const [chartTheme, setChartTheme] = useState<ChartTheme>(readChartTheme);
  useEffect(() => {
    const onThemeChange = () => setChartTheme(readChartTheme());
    document.addEventListener('jk-themechange', onThemeChange);
    return () => document.removeEventListener('jk-themechange', onThemeChange);
  }, []);

  const [apiKey, setApiKey] = useState<string>(() => lsGet(LS_KEY, ''));
  const [rememberKey, setRememberKey] = useState<boolean>(() => lsGet(LS_KEY, '') !== '');
  const [showKey, setShowKey] = useState(false);
  useEffect(() => lsSet(LS_KEY, rememberKey && apiKey ? apiKey : null), [apiKey, rememberKey]);

  const [config, setConfig] = useState<RunConfig>(() => ({ ...DEFAULT_CONFIG, ...lsGet(LS_CONFIG, {}) }));
  useEffect(() => lsSet(LS_CONFIG, config), [config]);
  const set = <K extends keyof RunConfig>(k: K, v: RunConfig[K]) => setConfig(c => ({ ...c, [k]: v }));

  const [runs, setRuns] = useState<Run[]>(() =>
    lsGet<Run[]>(LS_RUNS, []).map(r => (r.status === 'running' ? { ...r, status: 'aborted' as const } : r)),
  );
  useEffect(() => {
    if (!runs.some(r => r.status === 'running')) lsSet(LS_RUNS, runs);
  }, [runs]);
  const [selectedId, setSelectedId] = useState<string | null>(() => runs[0]?.id ?? null);
  const selected = runs.find(r => r.id === selectedId) ?? runs[0] ?? null;
  const activeRun = runs.find(r => r.status === 'running') ?? null;

  const abortRef = useRef<AbortController | null>(null);

  // Vložení proměnné na pozici kurzoru do naposledy aktivního pole
  const sysRef = useRef<HTMLTextAreaElement>(null);
  const ctxRef = useRef<HTMLTextAreaElement>(null);
  const lastField = useRef<'systemInstruction' | 'context'>('context');
  const insertVariable = (token: string) => {
    const field = lastField.current;
    const el = field === 'context' ? ctxRef.current : sysRef.current;
    const value = config[field];
    const start = el?.selectionStart ?? value.length;
    const end = el?.selectionEnd ?? value.length;
    set(field, value.slice(0, start) + token + value.slice(end));
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(start + token.length, start + token.length);
    });
  };
  const [running, setRunning] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const start = async () => {
    setFormError(null);
    if (!apiKey.trim()) return setFormError('Vyplňte API klíč.');
    if (!config.model.trim()) return setFormError('Vyberte model.');
    if (!config.context.trim()) return setFormError('Vyplňte kontext (zprávu pro model).');
    if (!(config.calls >= 1 && config.calls <= 1000)) return setFormError('Počet volání musí být 1–1000.');
    if (!(config.pauseMs >= 0)) return setFormError('Pauza nesmí být záporná.');
    const badVars = [...invalidVariables(config.systemInstruction), ...invalidVariables(config.context)];
    if (badVars.length) return setFormError(`Neplatná proměnná: ${badVars.join(', ')}`);
    try {
      parseGenerationConfig(config.generationConfig);
    } catch (e) {
      return setFormError((e as Error).message);
    }

    const run: Run = {
      id: `run-${Date.now().toString(36)}`,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      status: 'running',
      config: { ...config },
      results: [],
    };
    setRuns(rs => [run, ...rs]);
    setSelectedId(run.id);
    setRunning(true);
    const ctrl = new AbortController();
    abortRef.current = ctrl;

    for (let i = 1; i <= run.config.calls; i++) {
      if (ctrl.signal.aborted) break;
      // Proměnné se dosazují před každým voláním zvlášť
      const cfg = run.config;
      const tctx = { i, n: cfg.calls, now: new Date() };
      const sysDynamic = hasVariables(cfg.systemInstruction);
      const ctxDynamic = hasVariables(cfg.context);
      const sys = sysDynamic ? renderTemplate(cfg.systemInstruction, tctx) : cfg.systemInstruction;
      const ctxText = ctxDynamic ? renderTemplate(cfg.context, tctx) : cfg.context;
      const res = await callOnce(apiKey.trim(), cfg, buildBody(cfg, sys, ctxText), i, ctrl.signal);
      if (sysDynamic) res.renderedSystemInstruction = sys;
      if (ctxDynamic) res.renderedContext = ctxText;
      if (ctrl.signal.aborted && res.error === 'Přerušeno') break;
      setRuns(rs => rs.map(r => (r.id === run.id ? { ...r, results: [...r.results, res] } : r)));
      if (i < run.config.calls) await sleep(run.config.pauseMs, ctrl.signal);
    }

    const aborted = ctrl.signal.aborted;
    setRuns(rs =>
      rs.map(r => (r.id === run.id ? { ...r, status: aborted ? 'aborted' : 'done', finishedAt: new Date().toISOString() } : r)),
    );
    abortRef.current = null;
    setRunning(false);
  };
  const stop = () => abortRef.current?.abort();

  const deleteRun = (id: string) => setRuns(rs => rs.filter(r => r.id !== id));
  const clearRuns = () => {
    if (confirm('Smazat všechny uložené běhy?')) setRuns(rs => rs.filter(r => r.status === 'running'));
  };

  const stamp = () => new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  const finishedRuns = runs.filter(r => r.results.length > 0);

  const modelInList = MODEL_GROUPS.some(g => g.models.some(m => m.id === config.model));

  return (
    <div className="min-h-screen flex flex-col">
      {/* Horní lišta */}
      <header className="topbar sticky top-0 z-20 h-14 flex items-center gap-3 px-4 sm:px-5">
        <div className="flex items-center gap-2.5 min-w-0">
          <a href="https://www.jan-kuchar.cz" aria-label="jan-kuchar.cz" className="mark">JK</a>
          <span className="text-fg-subtle text-lg font-light" aria-hidden="true">/</span>
          <img src="/favicon.svg" alt="" className="size-[26px] shrink-0" />
          <span className="text-[15px] font-light tracking-[-0.01em] whitespace-nowrap max-[380px]:sr-only">
            Gemini <b className="font-semibold">Tester</b>
          </span>
        </div>
        <div className="flex-1" />
        <div className="flex items-center gap-2">
          {finishedRuns.length > 0 && (
            <ExportMenu
              onCalls={() => download(callsCsv(finishedRuns), `gemini-volani-${stamp()}.csv`, 'text/csv;charset=utf-8')}
              onSummary={() => download(summaryCsv(finishedRuns), `gemini-souhrn-${stamp()}.csv`, 'text/csv;charset=utf-8')}
              onJson={() => download(runsJson(finishedRuns), `gemini-test-${stamp()}.json`, 'application/json')}
              onSelected={
                selected && selected.results.length
                  ? () => download(callsCsv([selected]), `gemini-${selected.config.model}-${stamp()}.csv`, 'text/csv;charset=utf-8')
                  : null
              }
            />
          )}
          {/* Přepínač režimu – vždy poslední; klik, ⌘⇧L i uložení volby řeší brand/theme.js */}
          <button
            type="button"
            className="theme-toggle"
            data-theme-toggle
            aria-label="Přepnout světlý / tmavý režim"
            title="Přepnout režim (⌘⇧L)"
          >
            <svg className="sun" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>
            <svg className="moon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M20.5 14.5A8.5 8.5 0 0 1 9.5 3.5a8.5 8.5 0 1 0 11 11z"/></svg>
          </button>
        </div>
      </header>

      <main className="flex-1 w-full max-w-[1200px] mx-auto px-4 sm:px-6 pt-7 pb-8 space-y-4">
        <div className="pb-1">
          <h1 className="text-2xl sm:text-[32px] sm:leading-[1.15] font-semibold tracking-[-0.02em] text-fg">Testování odezvy Gemini</h1>
          <p className="text-[13px] text-fg-muted mt-1">Opakovaná volání Gemini API, měření latence a statistiky</p>
        </div>

        {/* Nastavení testu */}
        <section className="panel p-4 sm:p-5 space-y-4">
          <div className="grid gap-3 md:grid-cols-2">
            <label className="space-y-1.5 block">
              <span className="field-label"><KeyRound size={13} /> API klíč Gemini</span>
              <div className="flex gap-2">
                <div className="relative flex-1">
                  <input
                    className="input pr-9 font-mono text-[13px]"
                    type={showKey ? 'text' : 'password'}
                    autoComplete="off"
                    spellCheck={false}
                    placeholder="AIza…"
                    value={apiKey}
                    onChange={e => setApiKey(e.target.value)}
                  />
                  <button
                    type="button"
                    className="absolute right-1.5 top-1/2 -translate-y-1/2 p-1.5 text-fg-subtle hover:text-fg"
                    onClick={() => setShowKey(v => !v)}
                    aria-label={showKey ? 'Skrýt klíč' : 'Zobrazit klíč'}
                  >
                    {showKey ? <EyeOff size={15} /> : <Eye size={15} />}
                  </button>
                </div>
              </div>
              <span className="flex items-center gap-2 text-xs text-fg-muted">
                <input type="checkbox" checked={rememberKey} onChange={e => setRememberKey(e.target.checked)} className="accent-[var(--color-accent)]" />
                Zapamatovat v tomto prohlížeči
              </span>
            </label>

            <div className="space-y-1.5">
              <span className="field-label">Model</span>
              <select
                className="input"
                value={modelInList ? config.model : '__custom'}
                onChange={e => set('model', e.target.value === '__custom' ? '' : e.target.value)}
                disabled={running}
              >
                {MODEL_GROUPS.map(g => (
                  <optgroup key={g.label} label={g.label}>
                    {g.models.map(m => (
                      <option key={m.id} value={m.id}>{m.displayName} · {m.id}</option>
                    ))}
                  </optgroup>
                ))}
                <option value="__custom">Vlastní…</option>
              </select>
              {!modelInList && (
                <input
                  className="input font-mono text-[13px]"
                  placeholder="např. gemini-3.8-flash"
                  value={config.model}
                  onChange={e => set('model', e.target.value.trim())}
                  disabled={running}
                />
              )}
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-3">
            <label className="space-y-1.5 block">
              <span className="field-label">Počet volání</span>
              <input className="input tabular-nums" type="number" min={1} max={1000} value={config.calls}
                onChange={e => set('calls', Math.floor(Number(e.target.value)))} disabled={running} />
            </label>
            <label className="space-y-1.5 block">
              <span className="field-label">Pauza mezi voláními (ms)</span>
              <input className="input tabular-nums" type="number" min={0} step={50} value={config.pauseMs}
                onChange={e => set('pauseMs', Math.floor(Number(e.target.value)))} disabled={running} />
            </label>
            <div className="space-y-1.5">
              <span className="field-label">Režim odpovědi</span>
              <div className="seg">
                <button type="button" aria-pressed={!config.stream} onClick={() => set('stream', false)} disabled={running}>Celá odpověď</button>
                <button type="button" aria-pressed={config.stream} onClick={() => set('stream', true)} disabled={running}>Streaming + TTFT</button>
              </div>
            </div>
          </div>

          <label className="space-y-1.5 block">
            <span className="field-label">System instruction <span className="text-fg-subtle font-normal">· volitelné</span></span>
            <textarea ref={sysRef} className="input h-auto min-h-[84px] py-2.5 font-mono text-[13px] leading-relaxed resize-y"
              value={config.systemInstruction} onChange={e => set('systemInstruction', e.target.value)}
              onFocus={() => (lastField.current = 'systemInstruction')}
              placeholder="Jsi stručný asistent…" disabled={running} />
          </label>

          <label className="space-y-1.5 block">
            <span className="field-label">Kontext <span className="text-fg-subtle font-normal">· obsah zprávy odeslané modelu</span></span>
            <textarea ref={ctxRef} className="input h-auto min-h-[120px] py-2.5 font-mono text-[13px] leading-relaxed resize-y"
              value={config.context} onChange={e => set('context', e.target.value)}
              onFocus={() => (lastField.current = 'context')} disabled={running} />
            <span className="text-xs text-fg-subtle tabular-nums">{nf(config.context.length)} znaků</span>
          </label>

          <TemplateHelp
            onInsert={insertVariable}
            disabled={running}
            systemInstruction={config.systemInstruction}
            context={config.context}
            calls={config.calls}
          />

          <details className="group">
            <summary className="cursor-pointer select-none text-[13px] text-fg-muted hover:text-fg inline-flex items-center gap-1.5">
              <ChevronDown size={14} className="-rotate-90 group-open:rotate-0 transition-transform" />
              Pokročilé: generationConfig
            </summary>
            <div className="mt-2 space-y-1.5">
              <textarea className="input h-auto min-h-[84px] py-2.5 font-mono text-[13px] leading-relaxed resize-y"
                value={config.generationConfig} onChange={e => set('generationConfig', e.target.value)} disabled={running}
                placeholder={'{\n  "temperature": 0.2,\n  "maxOutputTokens": 256,\n  "thinkingConfig": { "thinkingBudget": 0 }\n}'} />
              <p className="text-xs text-fg-subtle">JSON objekt předaný beze změny jako <code>generationConfig</code>. Prázdné = výchozí nastavení modelu.</p>
            </div>
          </details>

          <div className="flex items-center gap-3 flex-wrap pt-1">
            {running ? (
              <button type="button" className="btn btn-danger" onClick={stop}><Square /> Zastavit</button>
            ) : (
              <button type="button" className="btn btn-primary" onClick={start}><Play /> Spustit test</button>
            )}
            {activeRun && (
              <Progress done={activeRun.results.length} total={activeRun.config.calls} />
            )}
            {formError && <span className="badge badge-dot b-err">{formError}</span>}
            <span className="text-xs text-fg-subtle ml-auto">Volání jdou přímo z prohlížeče do Google API, nic dalšího se nikam neodesílá</span>
          </div>
        </section>

        {runs.length === 0 ? (
          <div className="dropzone grid justify-items-center text-center gap-2.5 px-3.5 py-10">
            <Gauge className="text-accent" size={28} />
            <h2 className="text-xl font-semibold">Zatím žádné měření</h2>
            <p className="text-fg-muted text-[15px] max-w-md">Vyplňte API klíč, vyberte model a spusťte test. Výsledky se uloží do historie a můžete je porovnat a exportovat.</p>
          </div>
        ) : (
          <>
            {selected && <RunDetail run={selected} theme={chartTheme} />}
            <RunHistory
              runs={runs}
              selectedId={selected?.id ?? null}
              onSelect={setSelectedId}
              onDelete={deleteRun}
              onClear={clearRuns}
              running={running}
            />
          </>
        )}
      </main>

      <footer className="flex justify-between gap-3 flex-wrap px-4 sm:px-5 py-2.5 border-t-[0.5px] border-line text-xs text-fg-subtle">
        <span>Gemini Tester · měření odezvy Gemini API</span>
        <span>AI Statistiky · © {new Date().getFullYear()} Jan Kuchař</span>
      </footer>
    </div>
  );
}

function TemplateHelp({ onInsert, disabled, systemInstruction, context, calls }: {
  onInsert: (token: string) => void; disabled: boolean; systemInstruction: string; context: string; calls: number;
}) {
  const dynamic = hasVariables(systemInstruction) || hasVariables(context);
  const invalid = [...invalidVariables(systemInstruction), ...invalidVariables(context)];
  const [seed, setSeed] = useState(0);
  const preview = useMemo(() => {
    const ctx = { i: 1, n: Math.max(1, calls || 1), now: new Date() };
    return { sys: renderTemplate(systemInstruction, ctx), ctx: renderTemplate(context, ctx) };
    // seed jen vynutí nové náhodné hodnoty
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [systemInstruction, context, calls, seed]);
  return (
    <div className="sunken p-3 space-y-2">
      <div className="flex items-baseline justify-between gap-3 flex-wrap">
        <span className="field-label">Dynamické proměnné</span>
        <span className="text-xs text-fg-subtle">Klikněte pro vložení na pozici kurzoru · dosazují se před každým voláním</span>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {TEMPLATE_VARS.map(v => (
          <button key={v.token} type="button" className="btn btn-secondary btn-sm font-mono" title={v.description}
            onMouseDown={e => e.preventDefault()} onClick={() => onInsert(v.insert)} disabled={disabled}>
            {v.token}
          </button>
        ))}
      </div>
      {invalid.length > 0 && <p className="text-xs text-danger">Neplatná proměnná: {invalid.join(', ')}</p>}
      {dynamic && (
        <details>
          <summary className="cursor-pointer select-none text-[13px] text-fg-muted hover:text-fg">Náhled prvního volání</summary>
          <div className="mt-2 space-y-2">
            {systemInstruction.trim() && (
              <div>
                <div className="section-label mb-1">System instruction</div>
                <pre className="card p-2.5 text-[12px] font-mono whitespace-pre-wrap break-words max-h-40 overflow-auto">{preview.sys}</pre>
              </div>
            )}
            <div>
              <div className="section-label mb-1">Kontext</div>
              <pre className="card p-2.5 text-[12px] font-mono whitespace-pre-wrap break-words max-h-40 overflow-auto">{preview.ctx}</pre>
            </div>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setSeed(x => x + 1)}>Vygenerovat znovu</button>
          </div>
        </details>
      )}
    </div>
  );
}

function Progress({ done, total }: { done: number; total: number }) {
  const pct = total ? (done / total) * 100 : 0;
  return (
    <div className="flex items-center gap-2.5 min-w-[180px]">
      <div className="h-1.5 flex-1 rounded-full bg-fill overflow-hidden">
        <div className="h-full bg-accent transition-[width] duration-200" style={{ width: `${pct}%` }} />
      </div>
      <span className="text-xs text-fg-muted tabular-nums">{nf(done)} / {nf(total)}</span>
    </div>
  );
}

function ExportMenu(props: { onCalls: () => void; onSummary: () => void; onJson: () => void; onSelected: (() => void) | null }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', esc); };
  }, [open]);
  const item = (label: string, hint: string, fn: () => void) => (
    <button type="button" className="w-full text-left px-3 py-2 rounded-[8px] hover:bg-fill-hover" onClick={() => { fn(); setOpen(false); }}>
      <div className="text-[13px] font-medium text-fg">{label}</div>
      <div className="text-xs text-fg-subtle">{hint}</div>
    </button>
  );
  return (
    <div className="relative" ref={ref}>
      <button type="button" className="btn btn-secondary btn-sm" onClick={() => setOpen(o => !o)} aria-expanded={open} title="Exportovat výsledky">
        <Download /><span className="max-sm:sr-only">Exportovat</span><ChevronDown className="max-sm:hidden" />
      </button>
      {open && (
        <div className="popover absolute right-0 top-[calc(100%+6px)] w-64 p-1.5 z-30">
          {props.onSelected && item('Vybraný běh · CSV', 'Všechna volání zobrazeného běhu', props.onSelected)}
          {item('Všechna volání · CSV', 'Řádek za každé volání ze všech běhů', props.onCalls)}
          {item('Souhrn běhů · CSV', 'Statistiky každého běhu na řádek', props.onSummary)}
          {item('Kompletní export · JSON', 'Nastavení, volání i statistiky', props.onJson)}
        </div>
      )}
    </div>
  );
}

function Kpi({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: 'danger' }) {
  return (
    <div className="card p-3.5 sm:p-4 min-w-0">
      <div className="section-label">{label}</div>
      <div className={cn('text-[22px] font-semibold tracking-[-0.01em] tabular-nums mt-1 truncate', tone === 'danger' && 'text-danger')}>{value}</div>
      {sub && <div className="text-xs text-fg-subtle mt-0.5 tabular-nums truncate">{sub}</div>}
    </div>
  );
}

function RunDetail({ run, theme }: { run: Run; theme: ChartTheme }) {
  const s = useMemo(() => runStats(run.results), [run.results]);
  const okLat = useMemo(() => run.results.filter(r => r.ok).map(r => r.latencyMs), [run.results]);
  const hist = useMemo(() => histogram(okLat, 12), [okLat]);
  const series = useMemo(
    () => run.results.map(r => ({
      call: r.index,
      latence: r.ok ? Math.round(r.latencyMs) : null,
      ttft: r.ok && r.ttftMs !== null ? Math.round(r.ttftMs) : null,
      chyba: r.ok ? null : Math.round(r.latencyMs),
    })),
    [run.results],
  );
  const [openRow, setOpenRow] = useState<number | null>(null);
  const l = s.latency;
  const axis = { stroke: theme.axis, fontSize: 11, tickLine: false, axisLine: false };

  return (
    <section className="space-y-4">
      <div className="flex items-center gap-2 flex-wrap">
        <h2 className="text-xl font-semibold tracking-[-0.01em] font-mono">{run.config.model}</h2>
        <StatusBadge run={run} />
        <span className="badge b-neutral">{run.config.stream ? 'Streaming' : 'Celá odpověď'}</span>
        <span className="text-xs text-fg-subtle tabular-nums">
          {fmtDate(run.startedAt)} · {nf(run.config.calls)} volání · pauza {nf(run.config.pauseMs)} ms
        </span>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
        <Kpi label="Medián" value={ms(l?.median)} sub={l ? `průměr ${ms(l.mean)}` : undefined} />
        <Kpi label="P95" value={ms(l?.p95)} sub={l ? `P90 ${ms(l.p90)} · P99 ${ms(l.p99)}` : undefined} />
        <Kpi label="Min / Max" value={l ? `${ms(l.min)}` : '–'} sub={l ? `max ${ms(l.max)} · σ ${ms(l.stddev)}` : undefined} />
        {run.config.stream ? (
          <Kpi label="TTFT medián" value={ms(s.ttft?.median)} sub={s.ttft ? `P95 ${ms(s.ttft.p95)}` : undefined} />
        ) : (
          <Kpi label="Výstupní tokeny" value={s.avgOutputTokens !== null ? nf(s.avgOutputTokens) : '–'}
            sub={s.avgPromptTokens !== null ? `vstup ${nf(s.avgPromptTokens)}${s.avgThoughtsTokens ? ` · myšlení ${nf(s.avgThoughtsTokens)}` : ''}` : 'průměr'} />
        )}
        <Kpi label="Rychlost" value={s.tokensPerSec !== null ? `${nf(s.tokensPerSec, 1)} tok/s` : '–'} sub="výstupní tokeny" />
        <Kpi label="Úspěšnost" value={`${nf(s.ok)} / ${nf(s.total)}`}
          sub={s.errors ? `${nf(s.errorRate * 100, 1)} % chyb` : 'bez chyb'} tone={s.errors ? 'danger' : undefined} />
      </div>

      <div className="grid gap-4 lg:grid-cols-5">
        <div className="card p-4 lg:col-span-3">
          <h3 className="text-[15px] font-semibold mb-3">Latence podle volání</h3>
          <div className="h-[240px]">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={series} margin={{ top: 4, right: 4, bottom: 0, left: 0 }} barCategoryGap="20%">
                <CartesianGrid vertical={false} stroke={theme.grid} />
                <XAxis dataKey="call" {...axis} />
                <YAxis {...axis} tickFormatter={axisMs} width={60} />
                <Tooltip cursor={{ fill: theme.cursor }} contentStyle={TOOLTIP_STYLE} labelStyle={TOOLTIP_LABEL_STYLE} itemStyle={TOOLTIP_ITEM_STYLE}
                  labelFormatter={v => `Volání ${v}`} formatter={(v: number) => `${nf(v)} ms`} />
                <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 12 }} />
                {l && <ReferenceLine y={l.median} stroke={CHART[2]} strokeDasharray="4 4" />}
                <Bar dataKey="latence" name="Latence" fill={CHART[0]} radius={[3, 3, 0, 0]} />
                {run.config.stream && <Bar dataKey="ttft" name="TTFT" fill={CHART[1]} radius={[3, 3, 0, 0]} />}
                {s.errors > 0 && <Bar dataKey="chyba" name="Chyba" fill={theme.danger} radius={[3, 3, 0, 0]} />}
              </BarChart>
            </ResponsiveContainer>
          </div>
          {l && <p className="text-xs text-fg-subtle mt-2">Přerušovaná čára = medián {ms(l.median)}</p>}
        </div>
        <div className="card p-4 lg:col-span-2">
          <h3 className="text-[15px] font-semibold mb-3">Rozložení latence</h3>
          <div className="h-[240px]">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={hist} margin={{ top: 4, right: 4, bottom: 0, left: -24 }} barCategoryGap={2}>
                <CartesianGrid vertical={false} stroke={theme.grid} />
                <XAxis dataKey="label" {...axis} interval="preserveStartEnd" />
                <YAxis {...axis} allowDecimals={false} />
                <Tooltip cursor={{ fill: theme.cursor }} contentStyle={TOOLTIP_STYLE} labelStyle={TOOLTIP_LABEL_STYLE} itemStyle={TOOLTIP_ITEM_STYLE}
                  labelFormatter={v => `${v} ms`} formatter={(v: number) => [nf(v), 'Volání']} />
                <Bar dataKey="count" radius={[3, 3, 0, 0]}>
                  {hist.map((_, i) => <Cell key={i} fill={CHART[0]} />)}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      </div>

      <div className="card overflow-hidden">
        <div className="px-4 pt-4 pb-2 flex items-baseline justify-between gap-3">
          <h3 className="text-[15px] font-semibold">Jednotlivá volání</h3>
          <span className="text-xs text-fg-subtle">Klikněte na řádek pro zobrazení odpovědi</span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-[13px]">
            <thead>
              <tr className="text-left section-label border-b-[0.5px] border-line">
                <th className="px-4 py-2 font-semibold">#</th>
                <th className="px-3 py-2 font-semibold">Čas</th>
                <th className="px-3 py-2 font-semibold text-right">Latence</th>
                {run.config.stream && <th className="px-3 py-2 font-semibold text-right">TTFT</th>}
                <th className="px-3 py-2 font-semibold text-right">Vstup</th>
                <th className="px-3 py-2 font-semibold text-right">Výstup</th>
                <th className="px-3 py-2 font-semibold text-right">Myšlení</th>
                <th className="px-4 py-2 font-semibold">Stav</th>
              </tr>
            </thead>
            <tbody>
              {run.results.map(r => (
                <CallRow key={r.index} r={r} stream={run.config.stream} median={l?.median ?? null}
                  open={openRow === r.index} onToggle={() => setOpenRow(o => (o === r.index ? null : r.index))} />
              ))}
              {run.results.length === 0 && (
                <tr><td colSpan={8} className="px-4 py-6 text-center text-fg-subtle">Čeká se na první odpověď…</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}

function StatusBadge({ run }: { run: Run }) {
  if (run.status === 'running') return <span className="badge badge-dot b-info">Probíhá</span>;
  if (run.status === 'aborted') return <span className="badge badge-dot b-warn">Přerušeno</span>;
  const errors = run.results.filter(r => !r.ok).length;
  return errors ? <span className="badge badge-dot b-warn">Hotovo s chybami</span> : <span className="badge badge-dot b-ok">Hotovo</span>;
}

function CallRow({ r, stream, median, open, onToggle }: {
  r: CallResult; stream: boolean; median: number | null; open: boolean; onToggle: () => void;
}) {
  const slow = r.ok && median !== null && r.latencyMs > median * 1.5;
  const cols = stream ? 8 : 7;
  return (
    <>
      <tr className={cn('border-b-[0.5px] border-line cursor-pointer hover:bg-fill', open && 'bg-fill')} onClick={onToggle}>
        <td className="px-4 py-2 tabular-nums text-fg-muted">{r.index}</td>
        <td className="px-3 py-2 tabular-nums text-fg-muted whitespace-nowrap">{new Date(r.startedAt).toLocaleTimeString('cs-CZ')}</td>
        <td className={cn('px-3 py-2 text-right tabular-nums whitespace-nowrap font-medium', slow && 'text-warning')}>{ms(r.latencyMs)}</td>
        {stream && <td className="px-3 py-2 text-right tabular-nums whitespace-nowrap">{ms(r.ttftMs)}</td>}
        <td className="px-3 py-2 text-right tabular-nums whitespace-nowrap text-fg-muted">{r.promptTokens !== null ? nf(r.promptTokens) : '–'}</td>
        <td className="px-3 py-2 text-right tabular-nums whitespace-nowrap text-fg-muted">{r.outputTokens !== null ? nf(r.outputTokens) : '–'}</td>
        <td className="px-3 py-2 text-right tabular-nums whitespace-nowrap text-fg-muted">{r.thoughtsTokens !== null ? nf(r.thoughtsTokens) : '–'}</td>
        <td className="px-4 py-2">
          {r.ok ? <span className="badge badge-dot b-ok">{r.finishReason ?? 'OK'}</span>
            : <span className="badge badge-dot b-err" title={r.error ?? ''}>{r.httpStatus ?? 'Chyba'}</span>}
        </td>
      </tr>
      {open && (
        <tr className="border-b-[0.5px] border-line">
          <td colSpan={cols} className="px-4 py-3">
            {r.error && (
              <p className="flex items-start gap-1.5 text-danger text-[13px] mb-2"><AlertTriangle size={14} className="mt-0.5 shrink-0" />{r.error}</p>
            )}
            {r.modelVersion && <p className="text-xs text-fg-subtle mb-1.5">modelVersion: <code>{r.modelVersion}</code></p>}
            {r.renderedSystemInstruction && (
              <div className="mb-2">
                <div className="section-label mb-1">Odeslaná system instruction</div>
                <pre className="sunken p-3 text-[12px] font-mono whitespace-pre-wrap break-words max-h-40 overflow-auto">{r.renderedSystemInstruction}</pre>
              </div>
            )}
            {r.renderedContext && (
              <div className="mb-2">
                <div className="section-label mb-1">Odeslaný kontext</div>
                <pre className="sunken p-3 text-[12px] font-mono whitespace-pre-wrap break-words max-h-40 overflow-auto">{r.renderedContext}</pre>
              </div>
            )}
            {(r.renderedSystemInstruction || r.renderedContext) && r.text && <div className="section-label mb-1">Odpověď</div>}
            {r.text ? (
              <pre className="sunken p-3 text-[12px] font-mono whitespace-pre-wrap break-words max-h-72 overflow-auto">{r.text}</pre>
            ) : !r.error && <p className="text-fg-subtle text-[13px]">Prázdná odpověď</p>}
          </td>
        </tr>
      )}
    </>
  );
}

function RunHistory({ runs, selectedId, onSelect, onDelete, onClear, running }: {
  runs: Run[]; selectedId: string | null; onSelect: (id: string) => void; onDelete: (id: string) => void; onClear: () => void; running: boolean;
}) {
  return (
    <section className="card overflow-hidden">
      <div className="px-4 pt-4 pb-2 flex items-center justify-between gap-3">
        <div>
          <h3 className="text-[15px] font-semibold">Porovnání běhů</h3>
          <p className="text-xs text-fg-subtle">Historie se ukládá v tomto prohlížeči · klikněte na řádek pro detail</p>
        </div>
        <button type="button" className="btn btn-danger btn-sm" onClick={onClear} disabled={running}>
          <Trash2 /><span className="max-sm:sr-only">Smazat vše</span>
        </button>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-[13px]">
          <thead>
            <tr className="text-left section-label border-b-[0.5px] border-line">
              <th className="px-4 py-2 font-semibold">Model</th>
              <th className="px-3 py-2 font-semibold">Spuštěno</th>
              <th className="px-3 py-2 font-semibold text-right">Volání</th>
              <th className="px-3 py-2 font-semibold text-right">Medián</th>
              <th className="px-3 py-2 font-semibold text-right">Průměr</th>
              <th className="px-3 py-2 font-semibold text-right">P95</th>
              <th className="px-3 py-2 font-semibold text-right">TTFT</th>
              <th className="px-3 py-2 font-semibold text-right">tok/s</th>
              <th className="px-3 py-2 font-semibold text-right">Chyby</th>
              <th className="px-4 py-2" />
            </tr>
          </thead>
          <tbody>
            {runs.map(run => {
              const s = runStats(run.results);
              const active = run.id === selectedId;
              return (
                <tr key={run.id} onClick={() => onSelect(run.id)}
                  className={cn('border-b-[0.5px] border-line cursor-pointer hover:bg-fill', active && 'bg-accent-soft hover:bg-accent-soft')}>
                  <td className="px-4 py-2 font-mono whitespace-nowrap">
                    {run.config.model}
                    {run.config.stream && <span className="badge b-neutral ml-2 align-middle">stream</span>}
                  </td>
                  <td className="px-3 py-2 tabular-nums text-fg-muted whitespace-nowrap">{fmtDate(run.startedAt)}</td>
                  <td className="px-3 py-2 text-right tabular-nums whitespace-nowrap">{nf(s.total)}{run.status !== 'done' && <span className="text-fg-subtle"> / {nf(run.config.calls)}</span>}</td>
                  <td className="px-3 py-2 text-right tabular-nums whitespace-nowrap font-medium">{ms(s.latency?.median)}</td>
                  <td className="px-3 py-2 text-right tabular-nums whitespace-nowrap">{ms(s.latency?.mean)}</td>
                  <td className="px-3 py-2 text-right tabular-nums whitespace-nowrap">{ms(s.latency?.p95)}</td>
                  <td className="px-3 py-2 text-right tabular-nums whitespace-nowrap">{ms(s.ttft?.median)}</td>
                  <td className="px-3 py-2 text-right tabular-nums whitespace-nowrap">{s.tokensPerSec !== null ? nf(s.tokensPerSec, 1) : '–'}</td>
                  <td className={cn('px-3 py-2 text-right tabular-nums whitespace-nowrap', s.errors > 0 && 'text-danger')}>{nf(s.errors)}</td>
                  <td className="px-4 py-2 text-right">
                    <button type="button" className="p-1 text-fg-subtle hover:text-danger disabled:opacity-40" disabled={run.status === 'running'}
                      onClick={e => { e.stopPropagation(); onDelete(run.id); }} aria-label="Smazat běh" title="Smazat běh">
                      <Trash2 size={14} />
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
