import { useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { Tile as TileT } from '../shared/types';
import { STATUS_LABEL } from '../shared/types';
import { DATE_KIND_LABEL, fmtDate, relDays, relTime } from './format';
import { AlertIcon, LockIcon, PinIcon, StatusIcon } from './icons';

export function StatusChip({ status }: { status: TileT['status'] }) {
  return (
    <span class={`chip ${status}`}>
      <StatusIcon status={status} />
      {STATUS_LABEL[status]}
    </span>
  );
}

export function Meter({ p }: { p: TileT['progress'] }) {
  if (p.percent === null) {
    return (
      <div class="meter" title={p.reasons.join(' ')}>
        <div class="bar unassessed" role="img" aria-label="Progress unassessed" />
        <div class="pct muted">{p.proposed ? 'Proposed plan' : 'Unassessed'}</div>
      </div>
    );
  }
  const provisional = p.assessment === 'provisional';
  return (
    <div class="meter" title={p.reasons.join(' ') || `${p.completed} of ${p.total} milestones complete`}>
      <div class={`bar${provisional ? ' provisional' : ''}`} role="progressbar" aria-valuenow={p.percent} aria-valuemin={0} aria-valuemax={100} aria-label="Milestone progress">
        <i style={{ width: `${Math.max(p.percent, p.percent > 0 ? 2 : 0)}%` }} />
      </div>
      <div class="pct">
        {p.percent}%{provisional && <small>provisional</small>}
      </div>
    </div>
  );
}

export function DateChip({ d, today }: { d: NonNullable<NonNullable<TileT['next_milestone']>['date']>; today: string }) {
  return (
    <span class="date" title={d.basis ? `Basis: ${d.basis}` : undefined}>
      <span class={`dk ${d.kind}`}>{DATE_KIND_LABEL[d.kind]}</span>
      <span class={d.overdue ? 'overdue' : ''}>
        {fmtDate(d.date, today)} · {relDays(d.days)}
      </span>
    </span>
  );
}

export function Tile({ t, today, onOpen, isNew, now }: { t: TileT; today: string; onOpen: (id: string) => void; isNew: boolean; now: number }) {
  const urgent = t.flags.find((f) => f.severity === 'urgent');
  const warn = t.flags.find((f) => f.severity === 'warn');
  const topFlag = urgent ?? warn;
  const showFlagRow = !t.blocker && topFlag && topFlag.kind !== 'source_error';
  const f = t.freshness;
  // Progressive compaction: if a dense tile's content does not fit, drop the least important lines first.
  const inner = useRef<HTMLDivElement>(null);
  const [level, setLevel] = useState(0);
  useLayoutEffect(() => {
    const el = inner.current;
    if (!el) return;
    const check = () => {
      const fits = el.scrollHeight <= el.clientHeight + 1;
      if (!fits && level < 5) setLevel(level + 1);
    };
    check();
    const ro = new ResizeObserver(() => {
      // Re-evaluate from scratch when the tile size changes (e.g. window resize).
      if (level !== 0 && el.scrollHeight < el.clientHeight * 0.8) setLevel(0);
      else check();
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [level, t.version]);
  const cls = [`tile c${level}`, ...Array.from({ length: level }, (_, i) => `c${i + 1}`), t.attention === 'urgent' ? 'urgent' : t.attention === 'attention' ? 'attention' : '', t.lifecycle === 'paused' ? 'paused' : '', isNew ? 'fresh-update' : ''].join(' ');
  return (
    <button class={cls} onClick={() => onOpen(t.id)} aria-label={`${t.name}: ${STATUS_LABEL[t.status]}. Open details.`}>
      <div class="tile-in" ref={inner}>
        <div class="t-top">
          <StatusChip status={t.status} />
          {t.lifecycle === 'paused' && <span class="flag prio">Paused</span>}
          <span class="t-badges">
            {urgent ? <span class="flag urgent">{flagShort(urgent.kind)}</span> : warn ? <span class="flag attention">{flagShort(warn.kind)}</span> : null}
            {t.priority === 'high' && <span class="flag prio high">High</span>}
            {t.only_me && (
              <span class="icon-badge" title="Only me">
                <LockIcon />
              </span>
            )}
            {t.pinned && (
              <span class="icon-badge" title="Pinned">
                <PinIcon />
              </span>
            )}
          </span>
        </div>
        <div class="t-name">{t.name}</div>
        {t.phrase && <div class="t-phrase">{t.phrase}</div>}
        {t.status_summary && <div class="t-summary">{t.status_summary}</div>}
        <Meter p={t.progress} />
        <div class="t-row">
          <span class="t-label">Next</span>
          <span class="t-val">{t.next_action ? t.next_action.title : <span class="muted">No next action recorded</span>}</span>
        </div>
        <div class="t-row">
          <span class="t-label">Milestone</span>
          <span class="t-val one">
            {t.next_milestone ? (
              <>
                {t.next_milestone.date && <DateChip d={t.next_milestone.date} today={today} />} {t.next_milestone.title}
                {t.next_milestone.proposed && <span class="muted"> (proposed)</span>}
              </>
            ) : (
              <span class="muted">{t.progress.total ? 'All milestones complete' : 'None defined'}</span>
            )}
          </span>
        </div>
        {t.blocker ? (
          <div class="t-blocker">
            <AlertIcon />
            <span>
              {t.blocker.basis === 'suggestion' ? 'Possible blocker: ' : 'Blocked: '}
              {t.blocker.title}
            </span>
          </div>
        ) : showFlagRow ? (
          <div class={`t-blocker${urgent ? '' : ' warn'}`}>
            <AlertIcon />
            <span>{topFlag!.label}</span>
          </div>
        ) : null}
        <div class="t-foot">
          <Freshness f={f} updatedAt={t.updated_at} now={now} />
        </div>
      </div>
    </button>
  );
}

function Freshness({ f, updatedAt, now }: { f: TileT['freshness']; updatedAt: string; now: number }) {
  if (f.state === 'manual_only') {
    return (
      <>
        <span>{f.label}</span>
        <span class="sep">·</span>
        <span>updated {relTime(updatedAt, now)}</span>
      </>
    );
  }
  if (!f.last_checked_at) return <span>{f.label || 'Not checked yet'}</span>;
  const right =
    f.state === 'error' ? <span class="state-error">{f.label}</span> : f.state === 'stale' ? <span class="state-stale">{f.label}</span> : <span>{f.last_evidence_at ? `last change ${relTime(f.last_evidence_at, now)}` : 'no changes found'}</span>;
  return (
    <>
      <span>Checked {relTime(f.last_checked_at, now)}</span>
      <span class="sep">·</span>
      {right}
    </>
  );
}

function flagShort(kind: string): string {
  return (
    {
      overdue_deadline: 'Overdue',
      target_missed: 'Target missed',
      step_overdue: 'Step overdue',
      blocked: 'Blocked',
      decision: 'Decision needed',
      attention: 'Needs you',
      source_error: 'Source issue',
    } as Record<string, string>
  )[kind] ?? 'Attention';
}

/** Chooses columns × rows so `n` tiles fill the area without scrolling, keeping tiles near a pleasant aspect ratio. */
export function fitGrid(n: number, w: number, h: number, gap: number, aspect = 1.5): { cols: number; rows: number; tileW: number; tileH: number } {
  let best = { cols: 1, rows: n, tileW: w, tileH: (h - gap * (n - 1)) / n, score: -1 };
  for (let cols = 1; cols <= Math.max(1, n); cols++) {
    const rows = Math.ceil(n / cols);
    const tileW = (w - gap * (cols - 1)) / cols;
    const tileH = (h - gap * (rows - 1)) / rows;
    if (tileW <= 0 || tileH <= 0) continue;
    // Usable size is limited by whichever dimension is short relative to the target aspect.
    const score = Math.min(tileW, tileH * aspect) * Math.min(tileH, tileW / aspect) - (rows * cols - n) * 0.001;
    if (score > best.score) best = { cols, rows, tileW, tileH, score };
  }
  return best;
}
