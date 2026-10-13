// Dynamické proměnné v system instruction a kontextu: {{nazev}} nebo {{nazev:parametr}}

export interface TemplateContext {
  /** Pořadí volání od 1 */
  i: number;
  /** Celkový počet volání v běhu */
  n: number;
  now: Date;
}

export interface TemplateVar {
  token: string;
  insert: string;
  description: string;
}

export const TEMPLATE_VARS: TemplateVar[] = [
  { token: '{{i}}', insert: '{{i}}', description: 'pořadí volání (1, 2, 3…)' },
  { token: '{{n}}', insert: '{{n}}', description: 'celkový počet volání' },
  { token: '{{datum}}', insert: '{{datum}}', description: 'dnešní datum, např. 13. 10. 2026' },
  { token: '{{cas}}', insert: '{{cas}}', description: 'aktuální čas, např. 14:05:09' },
  { token: '{{den}}', insert: '{{den}}', description: 'den v týdnu, např. úterý' },
  { token: '{{nahodne:a|b|c}}', insert: '{{nahodne:pračka|lednička|televize}}', description: 'náhodně jedna z hodnot' },
  { token: '{{cislo:od-do}}', insert: '{{cislo:1000-50000}}', description: 'náhodné celé číslo v rozsahu' },
  { token: '{{uuid}}', insert: '{{uuid}}', description: 'unikátní ID' },
];

const PATTERN = /\{\{\s*([a-z]+)\s*(?::([^}]*))?\}\}/gi;

const randInt = (min: number, max: number) => Math.floor(Math.random() * (max - min + 1)) + min;

function uuid(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

/** Vrátí hodnotu proměnné, nebo null pokud proměnná/parametr není platný */
function resolve(name: string, arg: string | undefined, ctx: TemplateContext): string | null {
  switch (name.toLowerCase()) {
    case 'i':
      return String(ctx.i);
    case 'n':
      return String(ctx.n);
    case 'datum':
      return ctx.now.toLocaleDateString('cs-CZ');
    case 'cas':
      return ctx.now.toLocaleTimeString('cs-CZ');
    case 'den':
      return ctx.now.toLocaleDateString('cs-CZ', { weekday: 'long' });
    case 'uuid':
      return uuid();
    case 'nahodne': {
      const items = (arg ?? '').split('|').map(s => s.trim()).filter(Boolean);
      return items.length ? items[randInt(0, items.length - 1)] : null;
    }
    case 'cislo': {
      const m = /^\s*(-?\d+)\s*-\s*(-?\d+)\s*$/.exec(arg ?? '');
      if (!m) return null;
      const a = Number(m[1]);
      const b = Number(m[2]);
      return String(randInt(Math.min(a, b), Math.max(a, b)));
    }
    default:
      return null;
  }
}

export function hasVariables(text: string): boolean {
  PATTERN.lastIndex = 0;
  return PATTERN.test(text);
}

/** Dosadí proměnné; neplatné ponechá beze změny */
export function renderTemplate(text: string, ctx: TemplateContext): string {
  return text.replace(PATTERN, (whole, name: string, arg?: string) => resolve(name, arg, ctx) ?? whole);
}

/** Seznam neplatných proměnných v textu (pro upozornění ve formuláři) */
export function invalidVariables(text: string): string[] {
  const ctx: TemplateContext = { i: 1, n: 1, now: new Date() };
  const bad = new Set<string>();
  for (const m of text.matchAll(PATTERN)) {
    if (resolve(m[1], m[2], ctx) === null) bad.add(m[0]);
  }
  return [...bad];
}
