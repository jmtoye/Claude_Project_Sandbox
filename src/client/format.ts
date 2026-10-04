import type { DateInfo } from '../shared/types';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function fmtDate(iso: string | null | undefined, today?: string): string {
  if (!iso) return '';
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  const sameYear = today ? Number(today.slice(0, 4)) === y : true;
  return `${d} ${MONTHS[m - 1]}${sameYear ? '' : ` ${y}`}`;
}

export function relDays(days: number): string {
  if (days === 0) return 'today';
  if (days === 1) return 'tomorrow';
  if (days === -1) return 'yesterday';
  if (days < 0) return `${-days}d overdue`;
  if (days < 14) return `in ${days}d`;
  return `in ${Math.round(days / 7)}w`;
}

export function relTime(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return 'never';
  const s = Math.round((now - Date.parse(iso)) / 1000);
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  const d = Math.round(s / 86400);
  return d === 1 ? 'yesterday' : `${d} days ago`;
}

export function hkTime(d = new Date()): string {
  return new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Hong_Kong', hour: '2-digit', minute: '2-digit', weekday: 'short', day: 'numeric', month: 'short' }).format(d);
}

export function hkDateTime(iso: string): string {
  return new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Hong_Kong', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(iso));
}

export const DATE_KIND_LABEL: Record<DateInfo['kind'], string> = { deadline: 'Deadline', target: 'Target', suggested: 'Suggested' };
export const BASIS_LABEL = { manual: 'Manual', source_fact: 'From source', suggestion: 'Suggested' } as const;
