-- Project dashboard schema (Cloudflare D1 / SQLite).
-- All timestamps are ISO-8601 UTC strings. Date-only fields (YYYY-MM-DD) are
-- calendar dates in Asia/Hong_Kong.

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL DEFAULT '',
  is_owner INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  summary_email INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  last_seen_at TEXT
);
CREATE UNIQUE INDEX users_single_owner ON users(is_owner) WHERE is_owner = 1;

-- Space-level access for invited users. The owner needs no rows here.
CREATE TABLE grants (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  space TEXT NOT NULL CHECK (space IN ('personal', 'work')),
  can_edit INTEGER NOT NULL DEFAULT 0,
  granted_at TEXT NOT NULL,
  PRIMARY KEY (user_id, space)
);

-- Personal access tokens for assistants / scripts. Only a SHA-256 hash is stored.
CREATE TABLE api_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  prefix TEXT NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN ('read', 'write')),
  created_at TEXT NOT NULL,
  last_used_at TEXT,
  revoked_at TEXT
);

CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  space TEXT NOT NULL CHECK (space IN ('personal', 'work')),
  name TEXT NOT NULL,
  phrase TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'unassessed'
    CHECK (status IN ('on_track', 'in_progress', 'at_risk', 'blocked', 'unassessed')),
  status_summary TEXT NOT NULL DEFAULT '',
  status_detail TEXT NOT NULL DEFAULT '',
  status_basis TEXT NOT NULL DEFAULT 'manual'
    CHECK (status_basis IN ('manual', 'source_fact', 'suggestion')),
  priority TEXT NOT NULL DEFAULT 'medium' CHECK (priority IN ('high', 'medium', 'low')),
  needs_attention INTEGER NOT NULL DEFAULT 0,
  attention_note TEXT NOT NULL DEFAULT '',
  pinned INTEGER NOT NULL DEFAULT 0,
  pinned_at TEXT,
  only_me INTEGER NOT NULL DEFAULT 0,
  lifecycle TEXT NOT NULL DEFAULT 'active'
    CHECK (lifecycle IN ('active', 'paused', 'completed', 'archived')),
  lifecycle_changed_at TEXT,
  canonical_url TEXT NOT NULL DEFAULT '',
  needs_review INTEGER NOT NULL DEFAULT 0,
  last_checked_at TEXT,
  last_evidence_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX projects_space_lifecycle ON projects(space, lifecycle);

CREATE TABLE milestones (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  weight REAL NOT NULL DEFAULT 1 CHECK (weight > 0),
  state TEXT NOT NULL DEFAULT 'not_started' CHECK (state IN ('not_started', 'in_progress', 'done')),
  confirmed INTEGER NOT NULL DEFAULT 1,
  evidence TEXT NOT NULL DEFAULT '',
  evidence_basis TEXT NOT NULL DEFAULT ''
    CHECK (evidence_basis IN ('', 'owner_confirmed', 'source_fact', 'auto_evidence')),
  evidence_source_id TEXT,
  completed_at TEXT,
  checklist TEXT NOT NULL DEFAULT '[]',
  deadline TEXT,
  deadline_note TEXT NOT NULL DEFAULT '',
  target_date TEXT,
  suggested_date TEXT,
  suggested_basis TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX milestones_project ON milestones(project_id, position);

CREATE TABLE next_steps (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  title TEXT NOT NULL,
  assignee TEXT NOT NULL DEFAULT '',
  due_date TEXT,
  needs_decision INTEGER NOT NULL DEFAULT 0,
  is_primary INTEGER NOT NULL DEFAULT 0,
  done INTEGER NOT NULL DEFAULT 0,
  done_at TEXT,
  origin TEXT NOT NULL DEFAULT 'manual' CHECK (origin IN ('manual', 'auto')),
  basis TEXT NOT NULL DEFAULT 'manual' CHECK (basis IN ('manual', 'source_fact', 'suggestion')),
  citation TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX next_steps_project ON next_steps(project_id, position);

-- Actual blockers, anticipated risks and useful tips are kept distinct by `kind`.
CREATE TABLE issues (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('blocker', 'risk', 'tip')),
  title TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  severity TEXT NOT NULL DEFAULT 'medium' CHECK (severity IN ('high', 'medium', 'low')),
  resolved INTEGER NOT NULL DEFAULT 0,
  resolved_at TEXT,
  origin TEXT NOT NULL DEFAULT 'manual' CHECK (origin IN ('manual', 'auto')),
  basis TEXT NOT NULL DEFAULT 'manual' CHECK (basis IN ('manual', 'source_fact', 'suggestion')),
  citation TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX issues_project ON issues(project_id);

CREATE TABLE sources (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('web', 'github', 'notion', 'snapshot', 'reference')),
  role TEXT NOT NULL DEFAULT 'supporting'
    CHECK (role IN ('canonical', 'supporting', 'decision', 'workstream')),
  title TEXT NOT NULL,
  url TEXT NOT NULL DEFAULT '',
  config TEXT NOT NULL DEFAULT '{}',
  snapshot_text TEXT NOT NULL DEFAULT '',
  as_of TEXT,
  connection TEXT NOT NULL DEFAULT 'pending'
    CHECK (connection IN ('pending', 'connected', 'reference_only', 'needs_setup', 'error')),
  last_checked_at TEXT,
  last_success_at TEXT,
  last_changed_at TEXT,
  content_hash TEXT,
  last_error TEXT NOT NULL DEFAULT '',
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX sources_project ON sources(project_id);

-- Last processed text of each source (used to describe what changed).
CREATE TABLE source_content (
  source_id TEXT PRIMARY KEY REFERENCES sources(id) ON DELETE CASCADE,
  content_hash TEXT NOT NULL,
  text TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  truncated INTEGER NOT NULL DEFAULT 0
);

-- Explicit, confirmed dependencies only (same space). "project_id depends on depends_on_id".
CREATE TABLE dependencies (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  depends_on_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  PRIMARY KEY (project_id, depends_on_id),
  CHECK (project_id <> depends_on_id)
);

-- Manually overridden fields are protected from automatic updates until released.
CREATE TABLE overrides (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  field TEXT NOT NULL,
  set_by TEXT NOT NULL,
  set_at TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (project_id, field)
);

CREATE TABLE history (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  at TEXT NOT NULL,
  actor_type TEXT NOT NULL CHECK (actor_type IN ('user', 'auto', 'assistant', 'system')),
  actor_id TEXT,
  actor_label TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL,
  summary TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '{}',
  run_id TEXT
);
CREATE INDEX history_project_at ON history(project_id, at);
CREATE INDEX history_at ON history(at);

-- Proposals that need a human decision (deadlines found in sources, dependencies,
-- milestone plans, automatic changes blocked by an override).
CREATE TABLE suggestions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('deadline', 'dependency', 'milestone', 'override_conflict')),
  payload TEXT NOT NULL DEFAULT '{}',
  rationale TEXT NOT NULL DEFAULT '',
  citation TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'dismissed')),
  dedupe_key TEXT NOT NULL,
  created_at TEXT NOT NULL,
  resolved_at TEXT,
  resolved_by TEXT,
  run_id TEXT
);
CREATE UNIQUE INDEX suggestions_pending_dedupe ON suggestions(project_id, dedupe_key) WHERE status = 'pending';

CREATE TABLE refresh_runs (
  id TEXT PRIMARY KEY,
  trigger TEXT NOT NULL CHECK (trigger IN ('cron', 'manual', 'api')),
  idem_key TEXT NOT NULL UNIQUE,
  requested_by TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'partial', 'failed', 'skipped')),
  stats TEXT NOT NULL DEFAULT '{}',
  error TEXT NOT NULL DEFAULT ''
);
CREATE INDEX refresh_runs_started ON refresh_runs(started_at);

CREATE TABLE daily_summaries (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  hk_date TEXT NOT NULL,
  generated_at TEXT NOT NULL,
  late INTEGER NOT NULL DEFAULT 0,
  content TEXT NOT NULL,
  delivery TEXT NOT NULL DEFAULT 'pending'
    CHECK (delivery IN ('pending', 'sent', 'failed', 'not_configured', 'disabled')),
  delivered_at TEXT,
  delivery_error TEXT NOT NULL DEFAULT '',
  UNIQUE (user_id, hk_date)
);

CREATE TABLE locks (
  name TEXT PRIMARY KEY,
  holder TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE app_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Inserting NULL here aborts a batch (used as an atomic optimistic-concurrency guard).
CREATE TABLE _guard (x INTEGER NOT NULL);
