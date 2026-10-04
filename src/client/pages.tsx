import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { CommandResponse, MapResponse, Me, Space, SummaryItem, SummaryResponse, Tile as TileT } from '../shared/types';
import { STATUS_LABEL } from '../shared/types';
import { api, runOp } from './api';
import { fmtDate, hkDateTime, relTime } from './format';
import { Tile } from './Tile';

// ---------------- relationship map ----------------

export function MapView({ space, onOpen }: { space: Space; onOpen: (id: string) => void }) {
  const [data, setData] = useState<MapResponse | null>(null);
  useEffect(() => {
    api<MapResponse>(`/api/map?space=${space}`).then(setData).catch(() => setData({ nodes: [], edges: [] }));
  }, [space]);
  const layout = useMemo(() => {
    if (!data) return null;
    const linked = new Set(data.edges.flatMap((e) => [e.from, e.to]));
    const nodes = data.nodes.filter((n) => linked.has(n.id));
    // Column = longest chain of prerequisites (prerequisites on the left, dependents to the right).
    const prereq = new Map<string, string[]>();
    for (const e of data.edges) prereq.set(e.from, [...(prereq.get(e.from) ?? []), e.to]);
    const depth = new Map<string, number>();
    const visit = (id: string, seen = new Set<string>()): number => {
      if (depth.has(id)) return depth.get(id)!;
      if (seen.has(id)) return 0;
      seen.add(id);
      const d = Math.max(-1, ...(prereq.get(id) ?? []).map((p) => visit(p, seen))) + 1;
      depth.set(id, d);
      return d;
    };
    nodes.forEach((n) => visit(n.id));
    const cols = new Map<number, typeof nodes>();
    for (const n of nodes) cols.set(depth.get(n.id)!, [...(cols.get(depth.get(n.id)!) ?? []), n]);
    const W = 250, H = 64, GX = 110, GY = 26;
    const pos = new Map<string, { x: number; y: number }>();
    for (const [c, list] of cols) list.forEach((n, i) => pos.set(n.id, { x: 24 + c * (W + GX), y: 24 + i * (H + GY) }));
    const width = 48 + (Math.max(0, ...cols.keys()) + 1) * (W + GX) - GX;
    const height = 48 + Math.max(1, ...[...cols.values()].map((l) => l.length)) * (H + GY) - GY;
    return { nodes, pos, W, H, width, height, isolated: data.nodes.filter((n) => !linked.has(n.id)) };
  }, [data]);
  if (!data || !layout) return <div class="page muted">Loading map…</div>;
  return (
    <div class="page" style={{ maxWidth: 'none' }}>
      <h2>Relationship map</h2>
      <p class="muted small">Only dependencies that were explicitly recorded are shown. Arrows point from a prerequisite to the project that depends on it.</p>
      {data.edges.length === 0 ? (
        <div class="card muted">No dependencies recorded in this space. Add genuine dependencies from a project’s details.</div>
      ) : (
        <div class="card map-wrap">
          <svg width={layout.width} height={layout.height} role="img" aria-label="Project dependency map">
            <defs>
              <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                <path d="M0 0L10 5L0 10z" fill="#5b616e" />
              </marker>
            </defs>
            {data.edges.map((e) => {
              const a = layout.pos.get(e.to)!; // prerequisite
              const b = layout.pos.get(e.from)!; // dependent
              if (!a || !b) return null;
              const x1 = a.x + layout.W, y1 = a.y + layout.H / 2, x2 = b.x, y2 = b.y + layout.H / 2;
              const mx = (x1 + x2) / 2;
              return (
                <path class="map-edge" d={`M${x1} ${y1} C${mx} ${y1} ${mx} ${y2} ${x2 - 4} ${y2}`} marker-end="url(#arrow)">
                  <title>{e.note || 'Dependency'}</title>
                </path>
              );
            })}
            {layout.nodes.map((n) => {
              const p = layout.pos.get(n.id)!;
              return (
                <g class={`map-node ${n.attention}`} transform={`translate(${p.x} ${p.y})`} onClick={() => onOpen(n.id)} style={{ cursor: 'pointer' }}>
                  <rect width={layout.W} height={layout.H} rx="10" stroke-width="1.5" />
                  <circle cx="22" cy="32" r="7" class={`map-dot ${n.status}`} />
                  <text x="40" y="28">{n.name.length > 26 ? n.name.slice(0, 25) + '…' : n.name}</text>
                  <text class="sub" x="40" y="47">
                    {STATUS_LABEL[n.status]}
                    {n.lifecycle === 'paused' ? ' · paused' : ''}
                  </text>
                </g>
              );
            })}
          </svg>
        </div>
      )}
      {layout.isolated.length > 0 && data.edges.length > 0 && <p class="small muted">Not connected: {layout.isolated.map((n) => n.name).join(', ')}</p>}
    </div>
  );
}

// ---------------- archive ----------------

export function ArchiveView({ space, me, today, onOpen }: { space: Space; me: Me; today: string; onOpen: (id: string) => void }) {
  const [tiles, setTiles] = useState<TileT[] | null>(null);
  const load = () => api<{ tiles: TileT[] }>(`/api/archive?space=${space}`).then((r) => setTiles(r.tiles));
  useEffect(() => void load(), [space]);
  return (
    <div class="page">
      <h2>Archive</h2>
      <p class="muted small">Completed and archived projects. {me.is_owner ? 'Open one to reopen it.' : ''}</p>
      {!tiles ? (
        <p class="muted">Loading…</p>
      ) : tiles.length === 0 ? (
        <div class="card muted">Nothing archived yet.</div>
      ) : (
        <div class="grid flow">
          {tiles.map((t) => (
            <div style={{ position: 'relative' }}>
              <Tile t={t} today={today} onOpen={onOpen} isNew={false} now={Date.now()} />
              {me.is_owner && (
                <button class="btn small primary" style={{ position: 'absolute', right: '10px', bottom: '10px' }} onClick={async () => (await runOp('set_lifecycle', { project_id: t.id, lifecycle: 'active' }), load())}>
                  Reopen
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------- daily summary ----------------

const SECTIONS: [keyof SummaryResponse['content'], string][] = [
  ['overdue', 'Overdue'],
  ['priorities', "Today's priorities"],
  ['upcoming', 'Upcoming milestones (next 14 days)'],
  ['changes', 'Significant changes (last 24 h)'],
  ['decisions', 'Decisions and actions needed from you'],
];

export function SummaryView({ me, onOpen, onToggleEmail }: { me: Me; onOpen: (id: string) => void; onToggleEmail: (v: boolean) => void }) {
  const [date, setDate] = useState<string | undefined>(undefined);
  const [s, setS] = useState<SummaryResponse | null>(null);
  useEffect(() => {
    setS(null);
    api<SummaryResponse>(`/api/summary${date ? `?date=${date}` : ''}`).then(setS);
  }, [date]);
  const shift = (n: number) => {
    const d = new Date(`${s!.hk_date}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + n);
    setDate(d.toISOString().slice(0, 10));
  };
  return (
    <div class="page">
      <h2>Daily summary</h2>
      {!s ? (
        <p class="muted">Loading…</p>
      ) : (
        <>
          <div class="row" style={{ marginBottom: '12px' }}>
            <button class="btn small" onClick={() => shift(-1)}>
              ← Previous day
            </button>
            <strong>{fmtDate(s.hk_date)}</strong>
            <button class="btn small" onClick={() => shift(1)}>
              Next day →
            </button>
            <span class="small muted">
              {s.stored ? `Generated ${hkDateTime(s.content.generated_at)} HKT${s.late ? ' (late — the 07:00 run was missed)' : ''}` : 'Live preview — not yet generated for this date'}
              {' · '}Next scheduled: 07:00 HKT {fmtDate(s.next_scheduled.slice(0, 10))}
            </span>
          </div>
          <div class="card small">
            <label class="row">
              <input type="checkbox" checked={me.summary_email} onChange={(e) => onToggleEmail((e.target as HTMLInputElement).checked)} /> Email me this summary each morning ({me.email})
            </label>
            {s.stored && <div class="muted" style={{ marginTop: '4px' }}>Delivery for this day: {deliveryLabel(s.delivery)}{s.delivery_error ? ` — ${s.delivery_error}` : ''}</div>}
          </div>
          {SECTIONS.map(([key, label]) => {
            const items = s.content[key] as SummaryItem[];
            return (
              <div class="card sum-sec">
                <h3>
                  {label} <span class="muted">({items.length})</span>
                </h3>
                {items.length === 0 ? (
                  <div class="muted small">None.</div>
                ) : (
                  <ul>
                    {items.map((i) => (
                      <li>
                        <a href="#" onClick={(e) => (e.preventDefault(), onOpen(i.project_id))}>
                          {i.project_name}
                        </a>
                        : {i.title}
                        {i.date && key !== 'changes' && <span class="muted"> ({fmtDate(i.date)})</span>}
                        {key === 'changes' && i.date && <span class="muted"> · {relTime(i.date)}</span>}
                        {i.detail && <span class="muted"> — {i.detail}</span>}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            );
          })}
        </>
      )}
    </div>
  );
}

function deliveryLabel(d: string) {
  return { sent: 'emailed', failed: 'email failed (will retry until noon)', not_configured: 'email not configured on the server — in-app only', disabled: 'email off for you — in-app only', pending: 'pending' }[d] ?? d;
}

// ---------------- settings ----------------

export function SettingsView({ me, onError, onToast }: { me: Me; onError: (m: string) => void; onToast: (m: string) => void }) {
  const [tokens, setTokens] = useState<any[]>([]);
  const [newToken, setNewToken] = useState<string | null>(null);
  const [users, setUsers] = useState<any | null>(null);
  const [status, setStatus] = useState<any | null>(null);
  const [inv, setInv] = useState({ email: '', name: '', work: 'view', personal: 'none' });
  const loadAll = async () => {
    try {
      setTokens((await api('/api/tokens')).tokens);
      if (me.is_owner) {
        setUsers(await api('/api/admin/users'));
        setStatus(await api('/api/admin/status'));
      }
    } catch (e: any) {
      onError(e.message);
    }
  };
  useEffect(() => void loadAll(), []);
  const call = async (fn: () => Promise<unknown>, ok: string) => {
    try {
      await fn();
      onToast(ok);
      await loadAll();
    } catch (e: any) {
      onError(e.message);
    }
  };
  const fileRef = useRef<HTMLInputElement>(null);
  return (
    <div class="page">
      <h2>Settings</h2>
      {me.is_owner && users && (
        <div class="card">
          <h3>People &amp; access</h3>
          <p class="small muted">
            Invited people are view-only by default; editing is granted separately per space. Personal access is limited to: {users.personal_allowed.join(', ') || 'nobody (set PERSONAL_ALLOWED_EMAILS)'}. “Only me” projects are never visible to anyone else. People also need to pass the Cloudflare Access login
            for this site.
          </p>
          <table class="t">
            <thead>
              <tr>
                <th>Person</th>
                <th>Work</th>
                <th>Personal</th>
                <th>Last seen</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {users.users.map((u: any) => {
                const g = (s: Space) => {
                  const x = u.grants.find((y: any) => y.space === s);
                  return x ? (x.can_edit ? 'edit' : 'view') : 'none';
                };
                return (
                  <tr>
                    <td>
                      {u.name || u.email}
                      <div class="small muted">{u.email}</div>
                    </td>
                    {(['work', 'personal'] as Space[]).map((s) => (
                      <td>
                        {u.is_owner ? (
                          'owner'
                        ) : u.status === 'revoked' ? (
                          <span class="muted">revoked</span>
                        ) : (
                          <select class="in small" value={g(s)} onChange={(e) => call(() => api('/api/admin/grants', { method: 'POST', body: { user_id: u.id, space: s, access: (e.target as HTMLSelectElement).value } }), 'Access updated')}>
                            <option value="none">No access</option>
                            <option value="view">View only</option>
                            <option value="edit">Can edit</option>
                          </select>
                        )}
                      </td>
                    ))}
                    <td class="small muted">{u.last_seen_at ? relTime(u.last_seen_at) : 'never'}</td>
                    <td>{!u.is_owner && u.status !== 'revoked' && <button class="btn small danger" onClick={() => confirm(`Revoke all access for ${u.email}?`) && call(() => api(`/api/admin/users/${u.id}`, { method: 'DELETE' }), 'Access revoked')}>Revoke</button>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <form
            class="inline"
            onSubmit={(e) => {
              e.preventDefault();
              const spaces = [inv.work !== 'none' && { space: 'work', can_edit: inv.work === 'edit' }, inv.personal !== 'none' && { space: 'personal', can_edit: inv.personal === 'edit' }].filter(Boolean);
              if (!spaces.length) return onError('Choose at least one space.');
              void call(() => api('/api/admin/users', { method: 'POST', body: { email: inv.email, name: inv.name, spaces } }), `Invited ${inv.email}`).then(() => setInv({ email: '', name: '', work: 'view', personal: 'none' }));
            }}
          >
            <label class="grow">
              Invite by email
              <input class="in" type="email" required value={inv.email} onInput={(e) => setInv({ ...inv, email: (e.target as HTMLInputElement).value })} />
            </label>
            <label>
              Name
              <input class="in" value={inv.name} onInput={(e) => setInv({ ...inv, name: (e.target as HTMLInputElement).value })} />
            </label>
            <label>
              Work
              <select class="in" value={inv.work} onChange={(e) => setInv({ ...inv, work: (e.target as HTMLSelectElement).value })}>
                <option value="none">No access</option>
                <option value="view">View only</option>
                <option value="edit">Can edit</option>
              </select>
            </label>
            <label>
              Personal
              <select class="in" value={inv.personal} onChange={(e) => setInv({ ...inv, personal: (e.target as HTMLSelectElement).value })}>
                <option value="none">No access</option>
                <option value="view">View only</option>
                <option value="edit">Can edit</option>
              </select>
            </label>
            <button class="btn primary">Invite</button>
          </form>
        </div>
      )}

      {me.is_owner && status && (
        <div class="card">
          <h3>Integrations &amp; schedule</h3>
          <table class="t">
            <tbody>
              {(['auth', 'llm', 'email', 'github', 'notion', 'chatgpt'] as const).map((k) => (
                <tr>
                  <td style={{ width: '150px' }}>{{ auth: 'Sign-in', llm: 'AI summaries', email: 'Email delivery', github: 'GitHub sources', notion: 'Notion sources', chatgpt: 'ChatGPT Pages' }[k]}</td>
                  <td>
                    <span class={status[k].configured ? 'ok' : 'no'}>{status[k].configured ? 'Connected' : 'Not connected'}</span>
                    <div class="small muted">{status[k].note ?? status[k].provider}{k === 'llm' && status.llm.configured ? ` (${status.llm.model})` : ''}</div>
                  </td>
                </tr>
              ))}
              <tr>
                <td>Schedule</td>
                <td>
                  {status.schedule.cron}
                  <div class="small muted">
                    Last scheduled run: {status.schedule.last_cron_at ? `${relTime(status.schedule.last_cron_at)} (${hkDateTime(status.schedule.last_cron_at)} HKT)` : 'none yet'}
                  </div>
                </td>
              </tr>
            </tbody>
          </table>
          <h3 style={{ marginTop: '14px' }}>Recent source checks</h3>
          <table class="t small">
            <thead>
              <tr>
                <th>When (HKT)</th>
                <th>Trigger</th>
                <th>Result</th>
                <th>Details</th>
              </tr>
            </thead>
            <tbody>
              {status.runs.map((r: any) => {
                const st = JSON.parse(r.stats || '{}');
                return (
                  <tr>
                    <td>{hkDateTime(r.started_at)}</td>
                    <td>{r.trigger}</td>
                    <td class={r.status === 'succeeded' ? 'ok' : r.status === 'failed' ? 'no' : ''}>{r.status}</td>
                    <td class="muted">
                      {st.sources_checked ?? 0} checked, {st.sources_changed ?? 0} changed, {st.sources_failed ?? 0} failed{st.deferred ? `, ${st.deferred} deferred` : ''}
                      {r.error ? ` — ${r.error}` : ''}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <div class="card">
        <h3>Assistant access tokens</h3>
        <p class="small muted">
          A token lets an assistant act as you through the REST API or the MCP endpoint (<span class="mono">{location.origin}/mcp</span>). It carries your own permissions; a read token can never change anything. See docs/ASSISTANTS.md.
        </p>
        {newToken && (
          <div class="banner">
            Copy now — shown once: <span class="mono">{newToken}</span>
          </div>
        )}
        <table class="t small">
          <tbody>
            {tokens.map((t) => (
              <tr>
                <td>{t.name}</td>
                <td class="mono">{t.prefix}…</td>
                <td>{t.scope}</td>
                <td class="muted">{t.revoked_at ? 'revoked' : t.last_used_at ? `used ${relTime(t.last_used_at)}` : 'never used'}</td>
                <td>{!t.revoked_at && <button class="btn small" onClick={() => call(() => api(`/api/tokens/${t.id}`, { method: 'DELETE' }), 'Token revoked')}>Revoke</button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <form
          class="inline"
          onSubmit={async (e) => {
            e.preventDefault();
            const form = e.target as HTMLFormElement;
            const name = (form.elements.namedItem('name') as HTMLInputElement).value;
            const scope = (form.elements.namedItem('scope') as HTMLSelectElement).value;
            try {
              const r = await api('/api/tokens', { method: 'POST', body: { name, scope } });
              setNewToken(r.token);
              form.reset();
              await loadAll();
            } catch (err: any) {
              onError(err.message);
            }
          }}
        >
          <label class="grow">
            Token name
            <input class="in" name="name" required placeholder="Claude Code on my laptop" />
          </label>
          <label>
            Scope
            <select class="in" name="scope">
              <option value="read">Read only</option>
              <option value="write">Read &amp; write (with your permissions)</option>
            </select>
          </label>
          <button class="btn">Create token</button>
        </form>
      </div>

      {me.is_owner && (
        <div class="card">
          <h3>Import / export</h3>
          <p class="small muted">Export all project records as JSON (your portable canonical record), or import projects from the same format.</p>
          <div class="row">
            <button
              class="btn"
              onClick={async () => {
                const data = await api('/api/admin/export');
                const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
                const a = document.createElement('a');
                a.href = URL.createObjectURL(blob);
                a.download = `projects-${new Date().toISOString().slice(0, 10)}.json`;
                a.click();
              }}
            >
              Export JSON
            </button>
            <input ref={fileRef} type="file" accept="application/json" style={{ display: 'none' }} onChange={async (e) => {
              const f = (e.target as HTMLInputElement).files?.[0];
              if (!f) return;
              try {
                const body = JSON.parse(await f.text());
                const r = await api('/api/admin/import', { method: 'POST', body });
                onToast(`Imported ${r.created.length} project(s)${r.skipped.length ? `, skipped ${r.skipped.length} existing` : ''}`);
              } catch (err: any) {
                onError(err.message);
              }
              (e.target as HTMLInputElement).value = '';
            }} />
            <button class="btn" onClick={() => fileRef.current?.click()}>
              Import JSON…
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------- natural-language command bar ----------------

export function CommandBar({ projectId, onClose, onApplied, onError }: { projectId: string | null; onClose: () => void; onApplied: (msg: string) => void; onError: (m: string) => void }) {
  const [text, setText] = useState('');
  const [res, setRes] = useState<CommandResponse | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, []);
  return (
    <div class="cmd" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div class="cmd-box" role="dialog" aria-label="Ask the assistant">
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            if (!text.trim()) return;
            setBusy(true);
            try {
              setRes(await api<CommandResponse>('/api/assistant/command', { method: 'POST', body: { text, project_id: projectId ?? undefined } }));
            } catch (err: any) {
              onError(err.message);
            } finally {
              setBusy(false);
            }
          }}
        >
          <input class="in" autoFocus value={text} placeholder={projectId ? 'e.g. “Change the target to 15 October”' : 'e.g. “Add project Office move to Work”'} onInput={(e) => (setText((e.target as HTMLInputElement).value), setRes(null))} />
        </form>
        <div class="small muted" style={{ marginTop: '6px' }}>
          {projectId ? '“This project” means the one you have open. ' : ''}Nothing changes until you confirm.
        </div>
        {busy && <div class="cmd-ops muted">Thinking…</div>}
        {res && (
          <div class="cmd-ops">
            {res.clarification && <div class="banner" style={{ margin: '0 0 8px' }}>{res.clarification}</div>}
            {res.operations.length > 0 && (
              <>
                <ul class="list">
                  {res.operations.map((o) => (
                    <li class="item">{o.description}</li>
                  ))}
                </ul>
                <div class="row" style={{ marginTop: '10px' }}>
                  <button
                    class="btn primary"
                    disabled={busy}
                    onClick={async () => {
                      setBusy(true);
                      try {
                        const r = await api('/api/assistant/apply', { method: 'POST', body: { operations: res.operations.map((o) => ({ op: o.op, args: o.args })) } });
                        const failed = r.applied.filter((a: any) => !a.ok);
                        if (failed.length) onError(failed.map((f: any) => f.message).join(' '));
                        else onApplied(r.applied.map((a: any) => a.message).join(' '));
                      } catch (err: any) {
                        onError(err.message);
                      } finally {
                        setBusy(false);
                      }
                    }}
                  >
                    Confirm
                  </button>
                  <button class="btn" onClick={onClose}>
                    Cancel
                  </button>
                  <span class="small muted">Interpreted by {res.interpreter === 'llm' ? 'Claude' : 'built-in rules'}</span>
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------- add project (owner) ----------------

export function AddProject({ space, onClose, onDone, onError }: { space: Space; onClose: () => void; onDone: (id: string) => void; onError: (m: string) => void }) {
  const [f, setF] = useState({ space, name: '', phrase: '', canonical_url: '', priority: 'medium', status_summary: '', only_me: false });
  return (
    <div class="cmd" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <form
        class="cmd-box"
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            const r = await api('/api/ops', { method: 'POST', body: { op: 'create_project', args: { ...f, canonical_url: f.canonical_url || undefined, phrase: f.phrase || undefined } } });
            onDone(r.project_id);
          } catch (err: any) {
            onError(err.message);
          }
        }}
      >
        <h3 style={{ marginTop: 0 }}>Add a project</h3>
        <div class="row">
          <label class="field">
            Space
            <select class="in" value={f.space} onChange={(e) => setF({ ...f, space: (e.target as HTMLSelectElement).value as Space })}>
              <option value="work">Work</option>
              <option value="personal">Personal</option>
            </select>
          </label>
          <label class="field grow">
            Name
            <input class="in" required autoFocus value={f.name} onInput={(e) => setF({ ...f, name: (e.target as HTMLInputElement).value })} />
          </label>
        </div>
        <label class="field" style={{ marginTop: '8px' }}>
          Canonical project page / document (optional)
          <input class="in" type="url" value={f.canonical_url} onInput={(e) => setF({ ...f, canonical_url: (e.target as HTMLInputElement).value })} placeholder="https://…" />
        </label>
        <label class="field" style={{ marginTop: '8px' }}>
          Inspirational phrase (optional)
          <input class="in" maxLength={140} value={f.phrase} onInput={(e) => setF({ ...f, phrase: (e.target as HTMLInputElement).value })} />
        </label>
        <label class="field" style={{ marginTop: '8px' }}>
          Current status in a sentence (optional)
          <input class="in" maxLength={300} value={f.status_summary} onInput={(e) => setF({ ...f, status_summary: (e.target as HTMLInputElement).value })} />
        </label>
        <div class="row" style={{ marginTop: '8px' }}>
          <label class="field">
            Priority
            <select class="in" value={f.priority} onChange={(e) => setF({ ...f, priority: (e.target as HTMLSelectElement).value })}>
              <option value="high">High</option>
              <option value="medium">Medium</option>
              <option value="low">Low</option>
            </select>
          </label>
          <label class="row small" style={{ marginTop: '14px' }}>
            <input type="checkbox" checked={f.only_me} onChange={() => setF({ ...f, only_me: !f.only_me })} /> Only me
          </label>
        </div>
        <div class="row" style={{ marginTop: '12px' }}>
          <button class="btn primary">Add project</button>
          <button class="btn" type="button" onClick={onClose}>
            Cancel
          </button>
          <span class="small muted">Add milestones and sources from the project’s details.</span>
        </div>
      </form>
    </div>
  );
}
