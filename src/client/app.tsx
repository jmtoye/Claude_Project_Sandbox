import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { DashboardResponse, Me, Space } from '../shared/types';
import { api, ApiError } from './api';
import { Detail } from './Detail';
import { hkTime, relTime } from './format';
import { Logo, PlusIcon, RefreshIcon, ScreenIcon, SparkIcon } from './icons';
import { AddProject, ArchiveView, CommandBar, MapView, SettingsView, SummaryView } from './pages';
import { Tile, fitGrid } from './Tile';

type View = 'tiles' | 'map' | 'archive' | 'summary' | 'settings';
const POLL_MS = 30_000;

function readUrl() {
  const q = new URLSearchParams(location.search);
  const path = location.pathname.replace(/^\//, '');
  return {
    space: (q.get('space') as Space | null) ?? null,
    view: ((['map', 'archive', 'summary', 'settings'].includes(path) ? path : 'tiles') as View),
    projector: q.get('projector') === '1',
    project: q.get('project'),
  };
}

const storage = {
  get: (k: string) => {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set: (k: string, v: string) => {
    try {
      localStorage.setItem(k, v);
    } catch {
      /* private mode */
    }
  },
};

export function App() {
  const init = readUrl();
  const [me, setMe] = useState<(Me & { progress_explanation: string }) | null>(null);
  const [fatal, setFatal] = useState<string | null>(null);
  const [space, setSpace] = useState<Space | null>(init.space);
  const [view, setView] = useState<View>(init.view);
  const [projector, setProjector] = useState(init.projector);
  const [openId, setOpenId] = useState<string | null>(init.project);
  const [dash, setDash] = useState<DashboardResponse | null>(null);
  const [changed, setChanged] = useState<Set<string>>(new Set());
  const [online, setOnline] = useState(true);
  const [authLost, setAuthLost] = useState(false);
  const [lastSync, setLastSync] = useState<number>(Date.now());
  const [now, setNow] = useState(Date.now());
  const [toast, setToast] = useState<{ msg: string; error?: boolean } | null>(null);
  const [cmd, setCmd] = useState(false);
  const [adding, setAdding] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<any[]>([]);
  const [idle, setIdle] = useState(false);
  const dashRef = useRef(dash);
  dashRef.current = dash;

  const notify = (msg: string, error = false) => {
    setToast({ msg, error });
    setTimeout(() => setToast(null), error ? 7000 : 3500);
  };

  // Who am I?
  useEffect(() => {
    api<Me & { progress_explanation: string }>('/api/me')
      .then((m) => {
        setMe(m);
        const allowed = m.spaces.map((s) => s.space);
        const remembered = storage.get('space') as Space | null;
        setSpace((cur) => (cur && allowed.includes(cur) ? cur : remembered && allowed.includes(remembered) ? remembered : (allowed.includes('work') ? 'work' : allowed[0]) ?? null));
      })
      .catch((e: ApiError) => setFatal(e.status === 401 ? 'Your sign-in has expired. Reload the page to sign in again.' : e.message));
  }, []);

  // Keep the URL shareable / bookmarkable (e.g. a projector bookmark).
  useEffect(() => {
    const q = new URLSearchParams();
    if (space) q.set('space', space);
    if (projector) q.set('projector', '1');
    if (openId) q.set('project', openId);
    const path = view === 'tiles' ? '/' : `/${view}`;
    history.replaceState(null, '', `${path}${q.toString() ? `?${q}` : ''}`);
    if (space) storage.set('space', space);
  }, [space, view, projector, openId]);

  const load = async (s: Space, markChanges = false) => {
    try {
      const d = await api<DashboardResponse>(`/api/dashboard?space=${s}`);
      if (markChanges && dashRef.current?.space === s) {
        const prev = new Map(dashRef.current.tiles.map((t) => [t.id, t.version]));
        setChanged(new Set(d.tiles.filter((t) => prev.get(t.id) !== t.version).map((t) => t.id)));
        setTimeout(() => setChanged(new Set()), 2500);
      }
      setDash(d);
      setOnline(true);
      setLastSync(Date.now());
    } catch (e: any) {
      if (e.status === 401) setAuthLost(true);
      else setOnline(false);
    }
  };

  useEffect(() => {
    if (!space) return;
    setDash(null);
    void load(space);
  }, [space]);

  // Live updates: poll a cheap per-user etag; reload when the visible data changed.
  useEffect(() => {
    if (!space) return;
    const tick = async () => {
      setNow(Date.now());
      try {
        const v = await api<{ etag: string }>(`/api/version?space=${space}`);
        setOnline(true);
        if (v.etag !== dashRef.current?.etag || Date.now() - lastSync > 10 * 60_000) await load(space, true);
      } catch (e: any) {
        if (e.status === 401) setAuthLost(true);
        else setOnline(false);
      }
    };
    const id = setInterval(tick, POLL_MS);
    const vis = () => document.visibilityState === 'visible' && tick();
    document.addEventListener('visibilitychange', vis);
    return () => (clearInterval(id), document.removeEventListener('visibilitychange', vis));
  }, [space, lastSync]);

  // Projector: hide the cursor when idle; Esc exits.
  useEffect(() => {
    if (!projector) return;
    let t: ReturnType<typeof setTimeout>;
    const move = () => {
      setIdle(false);
      clearTimeout(t);
      t = setTimeout(() => setIdle(true), 3000);
    };
    const key = (e: KeyboardEvent) => e.key === 'Escape' && !openId && setProjector(false);
    move();
    window.addEventListener('mousemove', move);
    window.addEventListener('keydown', key);
    return () => (window.removeEventListener('mousemove', move), window.removeEventListener('keydown', key), clearTimeout(t));
  }, [projector, openId]);

  // Search (server-side, permission-filtered).
  useEffect(() => {
    if (query.trim().length < 2) return setHits([]);
    const t = setTimeout(() => api(`/api/search?q=${encodeURIComponent(query)}`).then((r) => setHits(r.results)).catch(() => setHits([])), 250);
    return () => clearTimeout(t);
  }, [query]);

  const canEditSpace = me?.spaces.find((s) => s.space === space)?.can_edit ?? false;
  const refreshNow = async () => {
    if (!space) return;
    if (!canEditSpace) return void load(space, true);
    setRefreshing(true);
    try {
      const r = await api('/api/refresh', { method: 'POST', body: {}, headers: { 'idempotency-key': `ui-${Date.now()}` } });
      notify(r.status === 'skipped' ? 'A refresh is already running — showing latest data.' : r.status === 'partial' ? 'Checked — some sources could not be read (see tiles).' : 'Sources checked.');
      await load(space, true);
    } catch (e: any) {
      notify(e.message, true);
    } finally {
      setRefreshing(false);
    }
  };

  if (fatal) {
    return (
      <div class="page">
        <h2>Project dashboard</h2>
        <div class="banner error">{fatal}</div>
      </div>
    );
  }
  if (!me) return <div class="page muted">Loading…</div>;
  if (!space) {
    return (
      <div class="page">
        <h2>Project dashboard</h2>
        <div class="card">You are signed in as {me.email}, but no projects have been shared with you yet.</div>
      </div>
    );
  }

  const ro = projector;
  const tabs = me.spaces.map((s) => s.space).sort((a) => (a === 'personal' ? -1 : 1));
  return (
    <div class={`app${projector ? ' projector' : ''}${projector && idle ? ' hide-cursor' : ''}`}>
      <header class="topbar" id="topbar">
        <div class="brand">
          <Logo /> <span class="hide-sm">Projects</span>
        </div>
        <div class="tabs" role="tablist" aria-label="Space">
          {tabs.map((s) => (
            <button class="tab" role="tab" aria-selected={s === space} onClick={() => (setSpace(s), setOpenId(null))}>
              {s === 'personal' ? 'Personal' : 'Work'}
              {s === space && dash && <span class="count">{dash.counts.active + dash.counts.paused}</span>}
            </button>
          ))}
        </div>
        {!projector && (
          <div class="views">
            {(['tiles', 'map', 'archive', 'summary'] as View[]).map((v) => (
              <button class="btn ghost" aria-pressed={view === v} onClick={() => setView(v)}>
                {{ tiles: 'Tiles', map: 'Map', archive: `Archive${dash?.counts.archive ? ` (${dash.counts.archive})` : ''}`, summary: 'Summary', settings: 'Settings' }[v]}
              </button>
            ))}
          </div>
        )}
        <div class="spacer" />
        {!projector && (
          <div style={{ position: 'relative' }} class="hide-sm">
            <input class="search" type="search" placeholder="Search projects…" value={query} onInput={(e) => setQuery((e.target as HTMLInputElement).value)} aria-label="Search projects" />
            {hits.length > 0 && (
              <div class="card" style={{ position: 'absolute', right: 0, top: '38px', width: '360px', zIndex: 30, maxHeight: '60vh', overflow: 'auto' }}>
                {hits.map((h) => (
                  <div style={{ padding: '6px 0', cursor: 'pointer' }} onClick={() => (setSpace(h.space), setOpenId(h.id), setQuery(''), setHits([]))}>
                    <div>{h.name}</div>
                    <div class="small muted">
                      {h.space} · {h.match}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
        <div class="meta" title={dash?.system.last_run ? `Last source check: ${dash.system.last_run.status}` : undefined}>
          <span class={`live-dot${online && !authLost ? '' : ' off'}`} />
          {projector && <span class="projector-clock">{hkTime(new Date(now))} HKT</span>}
          <span class="hide-sm">{online ? `Updated ${relTime(new Date(lastSync).toISOString(), now)}` : 'Offline — showing last data'}</span>
        </div>
        {!projector && (
          <>
            <button class="btn" onClick={refreshNow} disabled={refreshing} title={canEditSpace ? 'Check all tracked sources now' : 'Reload the latest data'}>
              <RefreshIcon /> <span class="hide-sm">{refreshing ? 'Checking…' : 'Refresh now'}</span>
            </button>
            {canEditSpace && (
              <button class="btn" onClick={() => setCmd(true)} title="Ask (natural-language changes)">
                <SparkIcon /> <span class="hide-sm">Ask</span>
              </button>
            )}
            {me.is_owner && (
              <button class="btn" onClick={() => setAdding(true)} title="Add project">
                <PlusIcon /> <span class="hide-sm">Add</span>
              </button>
            )}
            <button class="btn" onClick={() => (setView('tiles'), setOpenId(null), setProjector(true), document.documentElement.requestFullscreen?.().catch(() => undefined))} title="Projector mode">
              <ScreenIcon /> <span class="hide-sm">Projector</span>
            </button>
            <button class="btn ghost" aria-pressed={view === 'settings'} onClick={() => setView('settings')}>
              Settings
            </button>
          </>
        )}
      </header>
      {projector && (
        <button class="btn small exit-projector" onClick={() => (setProjector(false), document.fullscreenElement && document.exitFullscreen())}>
          Exit projector (Esc)
        </button>
      )}
      {authLost && <div class="banner error">Your sign-in has expired; the screen shows the last data received. Reload the page to sign in again.</div>}
      {!online && !authLost && <div class="banner">Connection lost — showing the last data received. Retrying automatically.</div>}
      {dash?.system.last_run?.status === 'failed' && me.is_owner && !projector && <div class="banner">The last source check failed. See Settings → Recent source checks.</div>}

      {view === 'tiles' || projector ? (
        <Board dash={dash} projector={projector} changed={changed} now={now} onOpen={setOpenId} />
      ) : view === 'map' ? (
        <MapView space={space} onOpen={setOpenId} />
      ) : view === 'archive' ? (
        <ArchiveView space={space} me={me} today={dash?.today ?? ''} onOpen={setOpenId} />
      ) : view === 'summary' ? (
        <SummaryView
          me={me}
          onOpen={(id) => setOpenId(id)}
          onToggleEmail={async (v) => {
            await api('/api/me/preferences', { method: 'POST', body: { summary_email: v } });
            setMe({ ...me, summary_email: v });
          }}
        />
      ) : (
        <SettingsView me={me} onError={(m) => notify(m, true)} onToast={notify} />
      )}

      {openId && (
        <Detail
          id={openId}
          today={dash?.today ?? ''}
          readonly={ro}
          explanation={me.progress_explanation}
          spaceTiles={dash?.tiles ?? []}
          onClose={() => setOpenId(null)}
          onChanged={(m) => (m && notify(m), space && load(space))}
          onError={(m) => notify(m, true)}
          onAsk={canEditSpace && !ro ? () => setCmd(true) : undefined}
        />
      )}
      {cmd && (
        <CommandBar
          projectId={openId}
          onClose={() => setCmd(false)}
          onApplied={(m) => (setCmd(false), notify(m), space && load(space, true))}
          onError={(m) => notify(m, true)}
        />
      )}
      {adding && (
        <AddProject
          space={space}
          onClose={() => setAdding(false)}
          onDone={(id) => (setAdding(false), setView('tiles'), notify('Project added'), load(space), setOpenId(id))}
          onError={(m) => notify(m, true)}
        />
      )}
      {toast && <div class={`toast${toast.error ? ' error' : ''}`} role="status">{toast.msg}</div>}
    </div>
  );
}

function Board({ dash, projector, changed, now, onOpen }: { dash: DashboardResponse | null; projector: boolean; changed: Set<string>; now: number; onOpen: (id: string) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  useLayoutEffect(() => {
    const measure = () => {
      const el = ref.current;
      if (!el || !el.isConnected) return;
      const top = document.getElementById('topbar')?.getBoundingClientRect().height ?? 56;
      document.documentElement.style.setProperty('--topbar-h', `${Math.ceil(top)}px`);
      const style = getComputedStyle(el);
      const padX = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight);
      const padY = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
      const banners = [...document.querySelectorAll('.app > .banner')].reduce((s, b) => s + (b as HTMLElement).offsetHeight + 10, 0);
      const w = el.clientWidth - (padX || 0);
      const h = window.innerHeight - top - (padY || 0) - banners;
      if (Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0) setSize((s) => (s && Math.abs(s.w - w) < 0.5 && Math.abs(s.h - h) < 0.5 ? s : { w, h }));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(document.body);
    window.addEventListener('resize', measure);
    return () => (ro.disconnect(), window.removeEventListener('resize', measure));
  }, [projector, Boolean(dash)]);

  if (!dash) {
    return (
      <main class="board muted" ref={ref}>
        Loading…
      </main>
    );
  }
  const n = dash.tiles.length;
  const gap = projector ? Math.max(10, Math.round(window.innerHeight * 0.009)) : 14;
  let fit = null as ReturnType<typeof fitGrid> | null;
  if (size && n > 0) {
    const g = fitGrid(n, size.w, size.h, gap);
    // Fill the screen without scrolling whenever tiles stay readable (always in projector mode).
    if (projector || (g.tileW >= 300 && g.tileH >= 230 && size.w >= 900)) fit = g;
  }
  return (
    <main class="board" ref={ref} style={fit ? { height: `${size!.h + 32}px`, overflow: 'hidden' } : undefined}>
      {n === 0 ? (
        <div class="empty">No active projects in this space yet.</div>
      ) : (
        <div class={`grid ${fit ? 'fit' : 'flow'}`} style={fit ? { gridTemplateColumns: `repeat(${fit.cols}, minmax(0, 1fr))`, gridTemplateRows: `repeat(${fit.rows}, minmax(0, 1fr))`, gap: `${gap}px`, height: `${size!.h}px` } : undefined}>
          {dash.tiles.map((t) => (
            <Tile t={t} today={dash.today} onOpen={onOpen} isNew={changed.has(t.id)} now={now} />
          ))}
        </div>
      )}
    </main>
  );
}
