// Date helpers. "Calendar dates" (YYYY-MM-DD) are always Asia/Hong_Kong dates.

export const HK_TZ = 'Asia/Hong_Kong';

const partsFmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: HK_TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

export function hkParts(d: Date): { date: string; hour: number; minute: number } {
  const p = Object.fromEntries(partsFmt.formatToParts(d).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour), minute: Number(p.minute) };
}

export function hkDate(d: Date): string {
  return hkParts(d).date;
}

export function hkHour(d: Date): number {
  return hkParts(d).hour;
}

export function isIsoDate(s: unknown): boolean {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/** Whole days from date `a` to date `b` (b - a). */
export function daysBetween(a: string, b: string): number {
  const ms = Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`);
  return Math.round(ms / 86_400_000);
}

export function addDays(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function nowIso(d: Date): string {
  return d.toISOString();
}

const MONTH_NAMES = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

function monthOf(word: string): number | null {
  if (word.length < 3) return null;
  const i = MONTH_NAMES.findIndex((n) => n.startsWith(word) || (word === 'sept' && n === 'september'));
  return i >= 0 ? i + 1 : null;
}

/**
 * Parses user-entered dates such as "15 October", "Oct 15", "15 Oct 2026",
 * "2026-10-15", "15/10" (day/month, as used in Hong Kong), "today", "tomorrow".
 * Dates without a year resolve to the next occurrence on or after `today`.
 */
export function parseHumanDate(input: string, today: string): string | null {
  const s = input.trim().toLowerCase().replace(/(\d)(st|nd|rd|th)\b/g, '$1').replace(/,/g, ' ').replace(/\s+/g, ' ');
  if (s === 'today') return today;
  if (s === 'tomorrow') return addDays(today, 1);
  if (isIsoDate(s)) return s;
  const year = Number(today.slice(0, 4));
  const build = (y: number | null, m: number, d: number): string | null => {
    const mk = (yy: number) => `${yy}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    if (y !== null) return isIsoDate(mk(y)) ? mk(y) : null;
    const cand = mk(year);
    if (!isIsoDate(cand)) return isIsoDate(mk(year + 1)) ? mk(year + 1) : null;
    return cand >= today ? cand : mk(year + 1);
  };
  let m = s.match(/^(\d{1,2}) ([a-z]+)(?: (\d{4}))?$/);
  if (m && monthOf(m[2])) return build(m[3] ? Number(m[3]) : null, monthOf(m[2])!, Number(m[1]));
  m = s.match(/^([a-z]+) (\d{1,2})(?: (\d{4}))?$/);
  if (m && monthOf(m[1])) return build(m[3] ? Number(m[3]) : null, monthOf(m[1])!, Number(m[2]));
  m = s.match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{4}))?$/);
  if (m) return build(m[3] ? Number(m[3]) : null, Number(m[2]), Number(m[1]));
  return null;
}
