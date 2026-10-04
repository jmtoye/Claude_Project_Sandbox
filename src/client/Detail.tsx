import { useEffect, useState } from 'preact/hooks';
import type { Citation, IssueDTO, MilestoneDTO, NextStepDTO, ProjectDetail, SourceDTO, Tile } from '../shared/types';
import { STATUS_LABEL, STATUSES } from '../shared/types';
import { api, runOp } from './api';
import { BASIS_LABEL, fmtDate, hkDateTime, relDays, relTime } from './format';
import { DateChip, Meter, StatusChip } from './Tile';

interface Props {
  id: string;
  today: string;
  readonly: boolean;
  explanation: string;
  spaceTiles: Tile[];
  onClose: () => void;
  onChanged: (msg?: string) => void;
  onError: (msg: string) => void;
  onAsk?: () => void;
}

function Basis({ b, cites }: { b: keyof typeof BASIS_LABEL; cites?: Citation[] }) {
  return (
    <span class={`basis ${b}`} title={cites?.length ? cites.map((c) => `“${c.quote}” — ${c.source_title ?? 'source'}`).join('\n') : undefined}>
      {BASIS_LABEL[b]}
    </span>
  );
}

function Quotes({ cites }: { cites: Citation[] }) {
  if (!cites?.length) return null;
  return (
    <>
      {cites.slice(0, 3).map((c) => (
        <blockquote class="quote">
          “{c.quote}” <span class="muted">— {c.source_title ?? 'source'}</span>
        </blockquote>
      ))}
    </>
  );
}

export function Detail(props: Props) {
  const [d, setD] = useState<ProjectDetail | null>(null);
  const [busy, setBusy] = useState(false);
  const [missing, setMissing] = useState(false);
  const load = async () => {
    try {
      setD(await api<ProjectDetail>(`/api/projects/${props.id}`));
    } catch (e: any) {
      if (e.status === 404) setMissing(true);
      else props.onError(e.message);
    }
  };
  useEffect(() => {
    setD(null);
    setMissing(false);
    void load();
  }, [props.id]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && props.onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  // Reload when the dashboard data changes underneath (auto-refresh).
  const tileVersion = props.spaceTiles.find((t) => t.id === props.id)?.version;
  useEffect(() => {
    if (d && tileVersion && tileVersion !== d.version) void load();
  }, [tileVersion]);

  const op = async (name: string, args: Record<string, unknown>, ok?: string) => {
    setBusy(true);
    try {
      const r = await runOp(name, { project_id: props.id, ...args });
      await load();
      props.onChanged(ok ?? r.message);
      return true;
    } catch (e: any) {
      props.onError(e.message);
      return false;
    } finally {
      setBusy(false);
    }
  };

  if (missing) {
    return (
      <Shell onClose={props.onClose}>
        <div class="d-body">
          <p class="muted">This project is not available.</p>
        </div>
      </Shell>
    );
  }
  if (!d) {
    return (
      <Shell onClose={props.onClose}>
        <div class="d-body">
          <p class="muted">Loading…</p>
        </div>
      </Shell>
    );
  }
  const edit = d.can_edit && !props.readonly;
  const owner = d.is_owner && !props.readonly;
  const overridden = (f: string) => d.overrides.find((o) => o.field === f);
  const blockers = d.issues.filter((i) => i.kind === 'blocker');
  const risks = d.issues.filter((i) => i.kind === 'risk');
  const tips = d.issues.filter((i) => i.kind === 'tip');

  return (
    <Shell onClose={props.onClose}>
      <div class="d-head">
        <div class="d-title">
          <h2>{d.name}</h2>
          <button class="btn ghost" onClick={props.onClose} aria-label="Close">
            ✕
          </button>
        </div>
        {d.phrase && <div class="d-phrase">{d.phrase}</div>}
        <div class="d-actions">
          <StatusChip status={d.status} />
          <span class="basis">{d.space === 'work' ? 'Work' : 'Personal'}</span>
          <span class={`flag prio ${d.priority}`}>{d.priority} priority</span>
          {d.lifecycle !== 'active' && <span class="flag prio">{d.lifecycle}</span>}
          {d.only_me && <span class="basis override">Only me</span>}
          {d.canonical_url && (
            <a class="btn small" href={d.canonical_url} target="_blank" rel="noopener noreferrer">
              Open project page ↗
            </a>
          )}
        </div>
        {edit && (
          <div class="d-actions">
            <button class="btn small" disabled={busy} onClick={() => op('set_pinned', { pinned: !d.pinned })}>
              {d.pinned ? 'Unpin' : 'Pin'}
            </button>
            {d.lifecycle === 'active' && (
              <button class="btn small" disabled={busy} onClick={() => op('set_lifecycle', { lifecycle: 'paused' })}>
                Pause
              </button>
            )}
            {d.lifecycle === 'paused' && (
              <button class="btn small" disabled={busy} onClick={() => op('set_lifecycle', { lifecycle: 'active' })}>
                Resume
              </button>
            )}
            {owner && (d.lifecycle === 'active' || d.lifecycle === 'paused') && (
              <>
                <button class="btn small" disabled={busy} onClick={() => confirm('Mark this project complete and move it to the archive?') && op('set_lifecycle', { lifecycle: 'completed' })}>
                  Complete
                </button>
                <button class="btn small" disabled={busy} onClick={() => confirm('Archive this project?') && op('set_lifecycle', { lifecycle: 'archived' })}>
                  Archive
                </button>
              </>
            )}
            {owner && (d.lifecycle === 'completed' || d.lifecycle === 'archived') && (
              <button class="btn small primary" disabled={busy} onClick={() => op('set_lifecycle', { lifecycle: 'active' })}>
                Reopen
              </button>
            )}
            <button class="btn small" disabled={busy} onClick={() => op('update_project', { needs_attention: !d.needs_attention })}>
              {d.needs_attention ? 'Clear attention flag' : 'Flag for my attention'}
            </button>
            <RefreshOne id={d.id} onDone={() => (load(), props.onChanged('Sources checked'))} onError={props.onError} />
            {props.onAsk && (
              <button class="btn small" onClick={props.onAsk} title="Natural-language change to this project">
                Ask about this project
              </button>
            )}
            {owner && (
              <label class="row small" style={{ marginLeft: 'auto' }} title="When on, only you can see this project — everywhere.">
                <input type="checkbox" checked={d.only_me} disabled={busy} onChange={(e) => op('set_only_me', { enabled: (e.target as HTMLInputElement).checked })} />
                Only me
              </label>
            )}
          </div>
        )}
      </div>

      <div class="d-body">
        {d.flags.length > 0 && (
          <section class="d">
            <h3>Needs attention</h3>
            <ul class="list">
              {d.flags.map((f) => (
                <li class="item small">
                  <span class={`flag ${f.severity === 'urgent' ? 'urgent' : f.severity === 'warn' ? 'attention' : 'prio'}`}>{f.severity}</span> {f.label}
                </li>
              ))}
            </ul>
          </section>
        )}

        <StatusSection d={d} edit={edit} busy={busy} op={op} overridden={overridden} />

        <section class="d">
          <h3>
            Progress &amp; milestones
            {edit && d.milestones.some((m) => !m.confirmed) && (
              <button class="btn small primary" onClick={() => op('confirm_milestones', {})}>
                Confirm proposed milestones
              </button>
            )}
          </h3>
          <Meter p={d.progress} />
          <div class="small muted" style={{ marginTop: '6px' }}>
            {d.progress.percent !== null ? `${d.progress.completed} of ${d.progress.total} confirmed milestones done.` : ''} {d.progress.reasons.join(' ')}
            {d.progress.current && ` Current: ${d.progress.current.title}${d.progress.current.percent !== null ? ` (${d.progress.current.percent}% of its sub-steps)` : ''}.`}
          </div>
          <details>
            <summary class="small muted" style={{ cursor: 'pointer', marginTop: '6px' }}>
              How is progress calculated?
            </summary>
            <div class="explain">{props.explanation}</div>
          </details>
          <ul class="list" style={{ marginTop: '12px' }}>
            {d.milestones.map((m, i) => (
              <Milestone m={m} i={i} today={props.today} edit={edit} busy={busy} op={op} sources={d.sources} />
            ))}
          </ul>
          {edit && <AddMilestone op={op} />}
        </section>

        <section class="d">
          <h3>Next steps</h3>
          <ul class="list">
            {d.next_steps.length === 0 && <li class="muted small">No next steps recorded.</li>}
            {d.next_steps.map((s) => (
              <Step s={s} edit={edit} busy={busy} op={op} today={props.today} />
            ))}
          </ul>
          {edit && <AddStep op={op} />}
          {overridden('next_steps') && <OverrideNote o={overridden('next_steps')!} edit={edit} op={op} label="Automatic next steps paused" />}
        </section>

        <section class="d">
          <h3>Blockers, risks &amp; tips</h3>
          <div class="small muted" style={{ marginBottom: '8px' }}>
            Blockers are actual impediments now; risks are anticipated problems; tips are practical advice.
          </div>
          <IssueGroup title="Actual blockers" items={blockers} edit={edit} op={op} />
          <IssueGroup title="Anticipated risks" items={risks} edit={edit} op={op} />
          <IssueGroup title="Tips" items={tips} edit={edit} op={op} />
          {edit && <AddIssue op={op} />}
          {overridden('issues') && <OverrideNote o={overridden('issues')!} edit={edit} op={op} label="Automatic blockers/risks paused" />}
        </section>

        {d.suggestions.length > 0 && (
          <section class="d">
            <h3>Suggestions to review</h3>
            <ul class="list">
              {d.suggestions.map((s) => (
                <li class="item">
                  <div class="row">
                    <span class="basis suggestion">{s.kind.replace('_', ' ')}</span>
                    <span class="grow">{s.rationale}</span>
                  </div>
                  {s.kind === 'override_conflict' && <div class="small muted">Your manual value is kept unless you accept.</div>}
                  <Quotes cites={s.citation} />
                  {edit && (
                    <div class="row" style={{ marginTop: '8px' }}>
                      <button class="btn small primary" disabled={busy} onClick={() => op('resolve_suggestion', { suggestion_id: s.id, accept: true })}>
                        Accept
                      </button>
                      <button class="btn small" disabled={busy} onClick={() => op('resolve_suggestion', { suggestion_id: s.id, accept: false })}>
                        Dismiss
                      </button>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          </section>
        )}

        <section class="d">
          <h3>Sources</h3>
          <div class="small muted" style={{ marginBottom: '8px' }}>
            Dashboard access shows these summaries; opening a source still requires access from its own provider.
          </div>
          <ul class="list">
            {d.sources.length === 0 && <li class="muted small">No sources attached.</li>}
            {d.sources.map((s) => (
              <Source s={s} edit={edit} op={op} />
            ))}
          </ul>
          {edit && <AddSource op={op} />}
        </section>

        <Dependencies d={d} edit={edit} op={op} spaceTiles={props.spaceTiles} />

        <section class="d">
          <h3>Update history</h3>
          <ul class="timeline">
            {d.history.map((h) => (
              <li class={h.actor_type}>
                <div class="small muted">
                  {hkDateTime(h.at)} · {h.actor_label || h.actor_type}
                </div>
                <div>{h.summary}</div>
                <HistoryDetail detail={h.detail} />
              </li>
            ))}
          </ul>
        </section>

        {owner && (
          <section class="d">
            <h3>Danger zone</h3>
            <button
              class="btn small danger"
              onClick={async () => {
                const name = prompt(`Permanently delete this project and its history? Type its name to confirm:\n${d.name}`);
                if (name && (await op('delete_project', { confirm_name: name }, 'Project deleted'))) props.onClose();
              }}
            >
              Delete project…
            </button>
          </section>
        )}
      </div>
    </Shell>
  );
}

function Shell({ children, onClose }: { children: any; onClose: () => void }) {
  return (
    <>
      <div class="scrim" onClick={onClose} />
      <div class="drawer" role="dialog" aria-modal="true">
        {children}
      </div>
    </>
  );
}

type OpFn = (name: string, args: Record<string, unknown>, ok?: string) => Promise<boolean>;

function OverrideNote({ o, edit, op, label }: { o: { field: string; set_by: string; set_at: string }; edit: boolean; op: OpFn; label?: string }) {
  return (
    <div class="row small" style={{ marginTop: '6px' }}>
      <span class="basis override">Manual override</span>
      <span class="muted">
        {label ?? 'Protected from automatic updates'} · set by {o.set_by} {relTime(o.set_at)}
      </span>
      {edit && (
        <button class="btn small" onClick={() => op('release_override', { field: o.field }, 'Override released')}>
          Release
        </button>
      )}
    </div>
  );
}

function StatusSection({ d, edit, busy, op, overridden }: { d: ProjectDetail; edit: boolean; busy: boolean; op: OpFn; overridden: (f: string) => any }) {
  const [editing, setEditing] = useState(false);
  const [f, setF] = useState({ status: d.status, status_summary: d.status_summary, status_detail: d.status_detail, phrase: d.phrase, priority: d.priority, name: d.name, attention_note: d.attention_note });
  useEffect(() => setF({ status: d.status, status_summary: d.status_summary, status_detail: d.status_detail, phrase: d.phrase, priority: d.priority, name: d.name, attention_note: d.attention_note }), [d.version]);
  const ov = ['status', 'status_summary', 'status_detail', 'phrase'].map(overridden).filter(Boolean);
  return (
    <section class="d">
      <h3>
        Status
        {edit && !editing && (
          <button class="btn small" onClick={() => setEditing(true)}>
            Edit
          </button>
        )}
      </h3>
      {!editing ? (
        <>
          <div class="row">
            <StatusChip status={d.status} /> <Basis b={d.status_basis} />
          </div>
          <p style={{ margin: '8px 0 4px', fontWeight: 600 }}>{d.status_summary || <span class="muted">No status update yet.</span>}</p>
          {d.status_detail && <p style={{ whiteSpace: 'pre-wrap', margin: 0, color: 'var(--text-2)' }}>{d.status_detail}</p>}
          {d.attention_note && <p class="small">Attention note: {d.attention_note}</p>}
          {ov.map((o: any) => (
            <OverrideNote o={o} edit={edit} op={op} label={`${o.field.replace('_', ' ')} protected from automatic updates`} />
          ))}
        </>
      ) : (
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            if (await op('update_project', { ...f, expected_version: d.version }, 'Saved (manual changes are protected from automatic updates)')) setEditing(false);
          }}
        >
          <div class="row">
            <label class="field grow">
              Name
              <input class="in" value={f.name} onInput={(e) => setF({ ...f, name: (e.target as HTMLInputElement).value })} />
            </label>
            <label class="field">
              Status
              <select class="in" value={f.status} onChange={(e) => setF({ ...f, status: (e.target as HTMLSelectElement).value as any })}>
                {STATUSES.map((s) => (
                  <option value={s}>{STATUS_LABEL[s]}</option>
                ))}
              </select>
            </label>
            <label class="field">
              Priority
              <select class="in" value={f.priority} onChange={(e) => setF({ ...f, priority: (e.target as HTMLSelectElement).value as any })}>
                <option value="high">High</option>
                <option value="medium">Medium</option>
                <option value="low">Low</option>
              </select>
            </label>
          </div>
          <label class="field" style={{ marginTop: '8px' }}>
            Inspirational phrase
            <input class="in" maxLength={140} value={f.phrase} onInput={(e) => setF({ ...f, phrase: (e.target as HTMLInputElement).value })} />
          </label>
          <label class="field" style={{ marginTop: '8px' }}>
            Concise status update (shown on the tile)
            <input class="in" maxLength={300} value={f.status_summary} onInput={(e) => setF({ ...f, status_summary: (e.target as HTMLInputElement).value })} />
          </label>
          <label class="field" style={{ marginTop: '8px' }}>
            Full status &amp; recent changes
            <textarea class="in" value={f.status_detail} onInput={(e) => setF({ ...f, status_detail: (e.target as HTMLTextAreaElement).value })} />
          </label>
          <label class="field" style={{ marginTop: '8px' }}>
            Attention note
            <input class="in" maxLength={300} value={f.attention_note} onInput={(e) => setF({ ...f, attention_note: (e.target as HTMLInputElement).value })} />
          </label>
          <div class="row" style={{ marginTop: '10px' }}>
            <button class="btn primary" disabled={busy}>
              Save
            </button>
            <button class="btn" type="button" onClick={() => setEditing(false)}>
              Cancel
            </button>
            <span class="small muted">Edited status fields become manual overrides that automatic updates won’t change until you release them.</span>
          </div>
        </form>
      )}
    </section>
  );
}

function Milestone({ m, i, today, edit, busy, op, sources }: { m: MilestoneDTO; i: number; today: string; edit: boolean; busy: boolean; op: OpFn; sources: SourceDTO[] }) {
  const [editing, setEditing] = useState(false);
  const [f, setF] = useState({ title: m.title, weight: m.weight, target_date: m.target_date ?? '', deadline: m.deadline ?? '', note: '', evidence: m.evidence });
  const src = sources.find((s) => s.id === m.evidence_source_id);
  const evidenceLabel = { owner_confirmed: 'Confirmed by you', source_fact: 'From source', auto_evidence: 'Automatic, from source', '': '' }[m.evidence_basis];
  const save = async (e: Event) => {
    e.preventDefault();
    let ok = true;
    if (f.title !== m.title || Number(f.weight) !== m.weight || (f.target_date || null) !== m.target_date || f.evidence !== m.evidence) {
      ok = await op('update_milestone', { milestone_id: m.id, title: f.title, weight: Number(f.weight), target_date: f.target_date || null, ...(f.evidence !== m.evidence ? { evidence: f.evidence } : {}) });
    }
    if (ok && (f.deadline || null) !== m.deadline) ok = await op('set_target_date', { milestone_id: m.id, date: f.deadline || null, kind: 'deadline', note: f.note || undefined });
    if (ok) setEditing(false);
  };
  return (
    <li class={`item${m.state === 'done' ? ' done' : ''}`}>
      <div class="ms-head">
        <span class={`ms-num${m.state === 'done' ? ' done' : ''}`}>{m.state === 'done' ? '✓' : i + 1}</span>
        <span class="title grow">{m.title}</span>
        {!m.confirmed && <span class="basis suggestion">Proposed</span>}
        <span class="small muted">weight {m.weight}</span>
        {m.effective_date && <DateChip d={m.effective_date} today={today} />}
        {edit && (
          <select class="in small" disabled={busy} value={m.state} onChange={(e) => op('update_milestone', { milestone_id: m.id, state: (e.target as HTMLSelectElement).value })}>
            <option value="not_started">Not started</option>
            <option value="in_progress">In progress</option>
            <option value="done">Done</option>
          </select>
        )}
        {!edit && <span class="small">{m.state.replace('_', ' ')}</span>}
      </div>
      <div class="small muted" style={{ marginLeft: '36px', marginTop: '4px' }}>
        {m.deadline && (
          <span>
            Deadline (confirmed) {fmtDate(m.deadline, today)}
            {m.deadline_note && ` — ${m.deadline_note}`}.{' '}
          </span>
        )}
        {m.target_date && <span>Your target {fmtDate(m.target_date, today)}. </span>}
        {m.suggested_date && (
          <span>
            Suggested {fmtDate(m.suggested_date, today)}
            {m.suggested_basis && ` — ${m.suggested_basis}`}.{' '}
          </span>
        )}
        {m.description && <div>{m.description}</div>}
      </div>
      {m.evidence && (
        <div class="small" style={{ marginLeft: '36px', marginTop: '4px' }}>
          <span class={`basis ${m.evidence_basis === 'owner_confirmed' ? 'manual' : 'source_fact'}`}>{evidenceLabel || 'Evidence'}</span> {m.evidence}
          {src && <span class="muted"> — {src.title}</span>}
        </div>
      )}
      {m.state === 'done' && !m.evidence && <div class="small" style={{ marginLeft: '36px', color: '#ffd98a' }}>Done without recorded evidence — progress is provisional.</div>}
      {m.overridden.length > 0 && <div class="small muted" style={{ marginLeft: '36px' }}>Manual override on {m.overridden.join(', ')} — release via the project’s overrides.</div>}
      {m.checklist.length > 0 && (
        <ul class="checklist small">
          {m.checklist.map((c) => (
            <li>
              <label>
                <input
                  type="checkbox"
                  checked={c.done}
                  disabled={!edit || busy}
                  onChange={() => op('update_milestone', { milestone_id: m.id, checklist: m.checklist.map((x) => (x.id === c.id ? { ...x, done: !x.done } : x)) })}
                />
                {c.title}
              </label>
            </li>
          ))}
        </ul>
      )}
      {edit && (
        <div class="row small" style={{ marginLeft: '36px', marginTop: '6px' }}>
          {m.state !== 'done' && (
            <button
              class="btn small"
              disabled={busy}
              onClick={() => {
                const ev = prompt('Completion evidence (what shows this is actually done — not just drafted)?', '');
                if (ev !== null) void op('complete_milestone', { milestone_id: m.id, evidence: ev || undefined });
              }}
            >
              Mark complete…
            </button>
          )}
          <button class="btn small" onClick={() => setEditing(!editing)}>
            {editing ? 'Close' : 'Edit'}
          </button>
          <button
            class="btn small"
            onClick={() => {
              const t = prompt('Add a sub-step to this milestone:');
              if (t) void op('update_milestone', { milestone_id: m.id, checklist: [...m.checklist, { title: t, done: false }] });
            }}
          >
            + Sub-step
          </button>
          <button class="btn small ghost" onClick={() => confirm(`Remove milestone "${m.title}"?`) && op('delete_milestone', { milestone_id: m.id })}>
            Remove
          </button>
        </div>
      )}
      {editing && (
        <form class="inline" onSubmit={save} style={{ marginLeft: '36px' }}>
          <label class="grow">
            Title
            <input class="in" value={f.title} onInput={(e) => setF({ ...f, title: (e.target as HTMLInputElement).value })} />
          </label>
          <label>
            Weight
            <input class="in" type="number" min="0.1" step="0.1" style={{ width: '80px' }} value={f.weight} onInput={(e) => setF({ ...f, weight: Number((e.target as HTMLInputElement).value) })} />
          </label>
          <label>
            My target
            <input class="in" type="date" value={f.target_date} onInput={(e) => setF({ ...f, target_date: (e.target as HTMLInputElement).value })} />
          </label>
          <label>
            Confirmed deadline
            <input class="in" type="date" value={f.deadline} onInput={(e) => setF({ ...f, deadline: (e.target as HTMLInputElement).value })} />
          </label>
          {m.deadline && f.deadline !== (m.deadline ?? '') && (
            <label class="grow">
              Reason for moving the deadline (kept in history)
              <input class="in" required value={f.note} onInput={(e) => setF({ ...f, note: (e.target as HTMLInputElement).value })} />
            </label>
          )}
          <label class="grow" style={{ flexBasis: '100%' }}>
            Completion evidence
            <input class="in" value={f.evidence} onInput={(e) => setF({ ...f, evidence: (e.target as HTMLInputElement).value })} />
          </label>
          <button class="btn primary">Save milestone</button>
        </form>
      )}
    </li>
  );
}

function AddMilestone({ op }: { op: OpFn }) {
  const [t, setT] = useState('');
  const [w, setW] = useState('1');
  const [date, setDate] = useState('');
  return (
    <form
      class="inline"
      onSubmit={async (e) => {
        e.preventDefault();
        if (t.trim() && (await op('add_milestone', { title: t.trim(), weight: Number(w) || 1, target_date: date || undefined }))) (setT(''), setDate(''));
      }}
    >
      <label class="grow">
        New milestone
        <input class="in" value={t} onInput={(e) => setT((e.target as HTMLInputElement).value)} placeholder="e.g. Pilot launched" />
      </label>
      <label>
        Weight
        <input class="in" type="number" min="0.1" step="0.1" style={{ width: '80px' }} value={w} onInput={(e) => setW((e.target as HTMLInputElement).value)} />
      </label>
      <label>
        My target
        <input class="in" type="date" value={date} onInput={(e) => setDate((e.target as HTMLInputElement).value)} />
      </label>
      <button class="btn">Add</button>
    </form>
  );
}

function Step({ s, edit, busy, op, today }: { s: NextStepDTO; edit: boolean; busy: boolean; op: OpFn; today: string }) {
  return (
    <li class={`item${s.done ? ' done' : ''}`}>
      <div class="row">
        {edit && <input type="checkbox" checked={s.done} disabled={busy} onChange={() => op('update_next_step', { step_id: s.id, done: !s.done })} aria-label="Done" />}
        <span class="title grow">
          {s.is_primary && '★ '}
          {s.title}
        </span>
        {s.needs_decision && <span class="flag attention">Decision</span>}
        {s.assignee && <span class="small muted">{s.assignee}</span>}
        {s.due_date && <span class={`small ${s.due_date < today && !s.done ? 'overdue' : 'muted'}`}>due {fmtDate(s.due_date, today)}</span>}
        <Basis b={s.basis} cites={s.citation} />
        {edit && !s.is_primary && !s.done && (
          <button class="btn small ghost" onClick={() => op('update_next_step', { step_id: s.id, is_primary: true })} title="Make this the most important next action">
            ★
          </button>
        )}
        {edit && (
          <button class="btn small ghost" onClick={() => op('delete_next_step', { step_id: s.id })} aria-label="Remove">
            ✕
          </button>
        )}
      </div>
      <Quotes cites={s.citation} />
    </li>
  );
}

function AddStep({ op }: { op: OpFn }) {
  const [f, setF] = useState({ title: '', assignee: '', due_date: '', needs_decision: false, is_primary: false });
  return (
    <form
      class="inline"
      onSubmit={async (e) => {
        e.preventDefault();
        if (f.title.trim() && (await op('add_next_step', { ...f, title: f.title.trim(), due_date: f.due_date || undefined }))) setF({ title: '', assignee: '', due_date: '', needs_decision: false, is_primary: false });
      }}
    >
      <label class="grow">
        New next step
        <input class="in" value={f.title} onInput={(e) => setF({ ...f, title: (e.target as HTMLInputElement).value })} />
      </label>
      <label>
        Who
        <input class="in" style={{ width: '120px' }} value={f.assignee} onInput={(e) => setF({ ...f, assignee: (e.target as HTMLInputElement).value })} placeholder="me" />
      </label>
      <label>
        Due
        <input class="in" type="date" value={f.due_date} onInput={(e) => setF({ ...f, due_date: (e.target as HTMLInputElement).value })} />
      </label>
      <label class="row">
        <input type="checkbox" checked={f.is_primary} onChange={() => setF({ ...f, is_primary: !f.is_primary })} /> Most important
      </label>
      <label class="row">
        <input type="checkbox" checked={f.needs_decision} onChange={() => setF({ ...f, needs_decision: !f.needs_decision })} /> Needs my decision
      </label>
      <button class="btn">Add</button>
    </form>
  );
}

function IssueGroup({ title, items, edit, op }: { title: string; items: IssueDTO[]; edit: boolean; op: OpFn }) {
  if (!items.length) return null;
  return (
    <div style={{ marginBottom: '10px' }}>
      <div class="small" style={{ fontWeight: 650, marginBottom: '4px' }}>
        {title}
      </div>
      <ul class="list">
        {items.map((i) => (
          <li class={`item${i.resolved ? ' done' : ''}`}>
            <div class="row">
              <span class="title grow">{i.title}</span>
              <span class="small muted">{i.severity}</span>
              <Basis b={i.basis} cites={i.citation} />
              {edit && (
                <button class="btn small" onClick={() => op('update_issue', { issue_id: i.id, resolved: !i.resolved })}>
                  {i.resolved ? 'Reopen' : 'Resolve'}
                </button>
              )}
              {edit && (
                <button class="btn small ghost" onClick={() => op('delete_issue', { issue_id: i.id })} aria-label="Remove">
                  ✕
                </button>
              )}
            </div>
            {i.detail && <div class="small muted">{i.detail}</div>}
            <Quotes cites={i.citation} />
          </li>
        ))}
      </ul>
    </div>
  );
}

function AddIssue({ op }: { op: OpFn }) {
  const [f, setF] = useState({ kind: 'blocker', title: '', severity: 'medium' });
  return (
    <form
      class="inline"
      onSubmit={async (e) => {
        e.preventDefault();
        if (f.title.trim() && (await op('add_issue', { ...f, title: f.title.trim() }))) setF({ ...f, title: '' });
      }}
    >
      <label>
        Type
        <select class="in" value={f.kind} onChange={(e) => setF({ ...f, kind: (e.target as HTMLSelectElement).value })}>
          <option value="blocker">Actual blocker</option>
          <option value="risk">Anticipated risk</option>
          <option value="tip">Tip</option>
        </select>
      </label>
      <label class="grow">
        Description
        <input class="in" value={f.title} onInput={(e) => setF({ ...f, title: (e.target as HTMLInputElement).value })} />
      </label>
      <label>
        Severity
        <select class="in" value={f.severity} onChange={(e) => setF({ ...f, severity: (e.target as HTMLSelectElement).value })}>
          <option value="high">High</option>
          <option value="medium">Medium</option>
          <option value="low">Low</option>
        </select>
      </label>
      <button class="btn">Add</button>
    </form>
  );
}

function Source({ s, edit, op }: { s: SourceDTO; edit: boolean; op: OpFn }) {
  const [open, setOpen] = useState(false);
  return (
    <li class="item">
      <div class="row">
        <span class={`conn ${s.connection}`}>{s.connection.replace('_', ' ')}</span>
        <span class="title grow">
          {s.url ? (
            <a href={s.url} target="_blank" rel="noopener noreferrer">
              {s.title} ↗
            </a>
          ) : (
            s.title
          )}
        </span>
        <span class="small muted">
          {s.kind} · {s.role}
        </span>
        {edit && (
          <button class="btn small ghost" onClick={() => confirm('Detach this source?') && op('remove_source', { source_id: s.id })} aria-label="Remove source">
            ✕
          </button>
        )}
      </div>
      <div class="small muted" style={{ marginTop: '4px' }}>
        {s.status_note}
        {s.last_success_at && ` Last read ${relTime(s.last_success_at)}.`}
        {s.last_changed_at && ` Last changed ${relTime(s.last_changed_at)}.`}
      </div>
      {s.kind === 'snapshot' && (
        <>
          <button class="btn small ghost" onClick={() => setOpen(!open)}>
            {open ? 'Hide snapshot' : 'Show snapshot'}
          </button>
          {open && <pre class="explain" style={{ whiteSpace: 'pre-wrap' }}>{s.snapshot_text}</pre>}
        </>
      )}
    </li>
  );
}

function AddSource({ op }: { op: OpFn }) {
  const [mode, setMode] = useState<'url' | 'snapshot'>('url');
  const [f, setF] = useState({ url: '', title: '', role: 'supporting', snapshot_text: '', as_of: '' });
  return (
    <form
      class="inline"
      onSubmit={async (e) => {
        e.preventDefault();
        const args = mode === 'url' ? { url: f.url.trim(), title: f.title || undefined, role: f.role } : { snapshot_text: f.snapshot_text, as_of: f.as_of || undefined, title: f.title || undefined, role: f.role, url: f.url || undefined };
        if (await op('add_source', args, 'Source added')) setF({ url: '', title: '', role: 'supporting', snapshot_text: '', as_of: '' });
      }}
    >
      <label>
        Add
        <select class="in" value={mode} onChange={(e) => setMode((e.target as HTMLSelectElement).value as any)}>
          <option value="url">Link</option>
          <option value="snapshot">Pasted snapshot</option>
        </select>
      </label>
      <label class="grow">
        {mode === 'url' ? 'URL (web page, GitHub file, Notion page, or reference link)' : 'Reference URL (optional)'}
        <input class="in" type="url" required={mode === 'url'} value={f.url} onInput={(e) => setF({ ...f, url: (e.target as HTMLInputElement).value })} />
      </label>
      <label>
        Title
        <input class="in" value={f.title} onInput={(e) => setF({ ...f, title: (e.target as HTMLInputElement).value })} />
      </label>
      <label>
        Role
        <select class="in" value={f.role} onChange={(e) => setF({ ...f, role: (e.target as HTMLSelectElement).value })}>
          <option value="canonical">Canonical record</option>
          <option value="supporting">Supporting document</option>
          <option value="decision">Decision</option>
          <option value="workstream">Workstream</option>
        </select>
      </label>
      {mode === 'snapshot' && (
        <>
          <label>
            As of
            <input class="in" type="date" required value={f.as_of} onInput={(e) => setF({ ...f, as_of: (e.target as HTMLInputElement).value })} />
          </label>
          <label class="grow" style={{ flexBasis: '100%' }}>
            Snapshot text
            <textarea class="in" required value={f.snapshot_text} onInput={(e) => setF({ ...f, snapshot_text: (e.target as HTMLTextAreaElement).value })} />
          </label>
        </>
      )}
      <button class="btn">Add source</button>
    </form>
  );
}

function Dependencies({ d, edit, op, spaceTiles }: { d: ProjectDetail; edit: boolean; op: OpFn; spaceTiles: Tile[] }) {
  const [sel, setSel] = useState('');
  const candidates = spaceTiles.filter((t) => t.id !== d.id && !d.depends_on.some((x) => x.project_id === t.id));
  return (
    <section class="d">
      <h3>Dependencies</h3>
      <div class="kv small">
        <div>Depends on</div>
        <div>
          {d.depends_on.length === 0 && <span class="muted">None recorded</span>}
          {d.depends_on.map((x) => (
            <div class="row">
              <span>{x.name}</span>
              <span class="muted">{STATUS_LABEL[x.status]}</span>
              {x.note && <span class="muted">— {x.note}</span>}
              {edit && (
                <button class="btn small ghost" onClick={() => op('remove_dependency', { depends_on_id: x.project_id })}>
                  ✕
                </button>
              )}
            </div>
          ))}
        </div>
        <div>Needed by</div>
        <div>
          {d.dependents.length === 0 && <span class="muted">None recorded</span>}
          {d.dependents.map((x) => (
            <div>{x.name}</div>
          ))}
        </div>
      </div>
      {edit && candidates.length > 0 && (
        <form
          class="inline"
          onSubmit={async (e) => {
            e.preventDefault();
            if (sel && (await op('add_dependency', { depends_on_id: sel }))) setSel('');
          }}
        >
          <label class="grow">
            Add a genuine dependency (same space)
            <select class="in" value={sel} onChange={(e) => setSel((e.target as HTMLSelectElement).value)}>
              <option value="">Choose a project this one depends on…</option>
              {candidates.map((t) => (
                <option value={t.id}>{t.name}</option>
              ))}
            </select>
          </label>
          <button class="btn">Add</button>
        </form>
      )}
    </section>
  );
}

function RefreshOne({ id, onDone, onError }: { id: string; onDone: () => void; onError: (m: string) => void }) {
  const [busy, setBusy] = useState(false);
  return (
    <button
      class="btn small"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        try {
          await api('/api/refresh', { method: 'POST', body: { project_id: id } });
          onDone();
        } catch (e: any) {
          onError(e.message);
        } finally {
          setBusy(false);
        }
      }}
    >
      {busy ? 'Checking…' : 'Check sources now'}
    </button>
  );
}

function HistoryDetail({ detail }: { detail: Record<string, any> }) {
  const applied: string[] = detail.applied ?? [];
  const suppressed: string[] = detail.suppressed ?? [];
  const cites: Citation[] = detail.citations ?? [];
  if (!applied.length && !suppressed.length && !cites.length) return null;
  return (
    <details class="small">
      <summary class="muted" style={{ cursor: 'pointer' }}>
        Details
      </summary>
      {applied.length > 0 && (
        <div>
          Applied:
          <ul>
            {applied.map((a) => (
              <li>{a}</li>
            ))}
          </ul>
        </div>
      )}
      {suppressed.length > 0 && (
        <div>
          Not applied:
          <ul>
            {suppressed.map((a) => (
              <li>{a}</li>
            ))}
          </ul>
        </div>
      )}
      {cites.slice(0, 6).map((c) => (
        <blockquote class="quote">“{c.quote}”</blockquote>
      ))}
    </details>
  );
}

export { relDays };
