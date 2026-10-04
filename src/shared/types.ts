// Types shared by the Worker API and the browser client.

export type Space = 'personal' | 'work';
export const SPACES: Space[] = ['personal', 'work'];
export type Status = 'on_track' | 'in_progress' | 'at_risk' | 'blocked' | 'unassessed';
export const STATUSES: Status[] = ['on_track', 'in_progress', 'at_risk', 'blocked', 'unassessed'];
export type Lifecycle = 'active' | 'paused' | 'completed' | 'archived';
export type Priority = 'high' | 'medium' | 'low';
/** Where a value came from: a person, a fact found in a source, or an inference/suggestion. */
export type Basis = 'manual' | 'source_fact' | 'suggestion';
export type DateKind = 'deadline' | 'target' | 'suggested';
export type MilestoneState = 'not_started' | 'in_progress' | 'done';
export type EvidenceBasis = '' | 'owner_confirmed' | 'source_fact' | 'auto_evidence';
export type IssueKind = 'blocker' | 'risk' | 'tip';
export type SourceKind = 'web' | 'github' | 'notion' | 'snapshot' | 'reference';
export type SourceRole = 'canonical' | 'supporting' | 'decision' | 'workstream';
export type Connection = 'pending' | 'connected' | 'reference_only' | 'needs_setup' | 'error';

export const STATUS_LABEL: Record<Status, string> = {
  on_track: 'On track',
  in_progress: 'In progress',
  at_risk: 'At risk',
  blocked: 'Blocked',
  unassessed: 'Unassessed',
};

export interface Citation {
  source_id: string;
  quote: string;
  source_title?: string;
}

export interface ProgressInfo {
  /** Overall milestone-weighted completion, or null when it cannot be assessed honestly. */
  percent: number | null;
  assessment: 'assessed' | 'provisional' | 'unassessed';
  reasons: string[];
  completed: number;
  total: number;
  proposed: number;
  current: { milestone_id: string; title: string; percent: number | null } | null;
}

export interface DateInfo {
  date: string;
  kind: DateKind;
  /** Days from today (HK). Negative = in the past. */
  days: number;
  overdue: boolean;
  basis?: string;
}

export type FlagKind =
  | 'overdue_deadline'
  | 'target_missed'
  | 'step_overdue'
  | 'blocked'
  | 'decision'
  | 'attention'
  | 'due_soon'
  | 'source_error'
  | 'stale'
  | 'needs_review'
  | 'suggestions';

export interface Flag {
  kind: FlagKind;
  label: string;
  severity: 'urgent' | 'warn' | 'info';
}

export interface Freshness {
  state: 'fresh' | 'stale' | 'error' | 'manual_only' | 'never_checked';
  label: string;
  last_checked_at: string | null;
  last_evidence_at: string | null;
  connected: number;
  reference_only: number;
  snapshots: number;
  problems: number;
}

export type OrderGroup = 'pinned' | 'action' | 'upcoming' | 'other' | 'paused';

export interface Tile {
  id: string;
  space: Space;
  name: string;
  phrase: string;
  status: Status;
  status_summary: string;
  status_basis: Basis;
  priority: Priority;
  pinned: boolean;
  only_me: boolean;
  lifecycle: Lifecycle;
  canonical_url: string;
  progress: ProgressInfo;
  next_action: { title: string; assignee: string; due_date: string | null; needs_decision: boolean; basis: Basis } | null;
  next_milestone: { id: string; title: string; date: DateInfo | null; proposed: boolean } | null;
  blocker: { title: string; severity: Priority; basis: Basis } | null;
  flags: Flag[];
  attention: 'urgent' | 'attention' | 'normal';
  freshness: Freshness;
  order_group: OrderGroup;
  version: number;
  updated_at: string;
}

export interface Checklist {
  id: string;
  title: string;
  done: boolean;
}

export interface MilestoneDTO {
  id: string;
  position: number;
  title: string;
  description: string;
  weight: number;
  state: MilestoneState;
  confirmed: boolean;
  evidence: string;
  evidence_basis: EvidenceBasis;
  evidence_source_id: string | null;
  completed_at: string | null;
  checklist: Checklist[];
  deadline: string | null;
  deadline_note: string;
  target_date: string | null;
  suggested_date: string | null;
  suggested_basis: string;
  effective_date: DateInfo | null;
  completion: number;
  overridden: string[];
}

export interface NextStepDTO {
  id: string;
  title: string;
  assignee: string;
  due_date: string | null;
  needs_decision: boolean;
  is_primary: boolean;
  done: boolean;
  origin: 'manual' | 'auto';
  basis: Basis;
  citation: Citation[];
}

export interface IssueDTO {
  id: string;
  kind: IssueKind;
  title: string;
  detail: string;
  severity: Priority;
  resolved: boolean;
  origin: 'manual' | 'auto';
  basis: Basis;
  citation: Citation[];
  created_at: string;
}

export interface SourceDTO {
  id: string;
  kind: SourceKind;
  role: SourceRole;
  title: string;
  url: string;
  as_of: string | null;
  snapshot_text: string;
  connection: Connection;
  status_note: string;
  last_checked_at: string | null;
  last_success_at: string | null;
  last_changed_at: string | null;
  last_error: string;
}

export interface HistoryDTO {
  id: string;
  at: string;
  actor_type: 'user' | 'auto' | 'assistant' | 'system';
  actor_label: string;
  kind: string;
  summary: string;
  detail: Record<string, unknown>;
}

export interface SuggestionDTO {
  id: string;
  kind: 'deadline' | 'dependency' | 'milestone' | 'override_conflict';
  payload: Record<string, unknown>;
  rationale: string;
  citation: Citation[];
  created_at: string;
}

export interface DependencyDTO {
  project_id: string;
  name: string;
  status: Status;
  lifecycle: Lifecycle;
  note: string;
}

export interface OverrideDTO {
  field: string;
  set_by: string;
  set_at: string;
  note: string;
}

export interface ProjectDetail extends Tile {
  status_detail: string;
  needs_attention: boolean;
  attention_note: string;
  needs_review: boolean;
  created_at: string;
  milestones: MilestoneDTO[];
  next_steps: NextStepDTO[];
  issues: IssueDTO[];
  sources: SourceDTO[];
  depends_on: DependencyDTO[];
  dependents: DependencyDTO[];
  overrides: OverrideDTO[];
  suggestions: SuggestionDTO[];
  history: HistoryDTO[];
  can_edit: boolean;
  is_owner: boolean;
}

export interface Me {
  id: string;
  email: string;
  name: string;
  is_owner: boolean;
  spaces: { space: Space; can_edit: boolean }[];
  via: 'access' | 'token' | 'dev';
  summary_email: boolean;
}

export interface DashboardResponse {
  space: Space;
  tiles: Tile[];
  counts: { active: number; paused: number; archive: number };
  etag: string;
  generated_at: string;
  today: string;
  system: SystemHealth;
}

export interface SystemHealth {
  last_run: { at: string; status: string; trigger: string } | null;
  last_cron_at: string | null;
  llm_configured: boolean;
  email_configured: boolean;
}

export interface MapResponse {
  nodes: { id: string; name: string; status: Status; lifecycle: Lifecycle; attention: Tile['attention'] }[];
  edges: { from: string; to: string; note: string }[];
}

export interface SummaryItem {
  project_id: string;
  project_name: string;
  title: string;
  detail?: string;
  date?: string;
  kind?: string;
}

export interface SummaryContent {
  hk_date: string;
  generated_at: string;
  overdue: SummaryItem[];
  priorities: SummaryItem[];
  upcoming: SummaryItem[];
  changes: SummaryItem[];
  decisions: SummaryItem[];
}

export interface SummaryResponse {
  hk_date: string;
  stored: boolean;
  late: boolean;
  delivery: string;
  delivery_error: string;
  content: SummaryContent;
  next_scheduled: string;
}

export interface OpPreview {
  op: string;
  args: Record<string, unknown>;
  description: string;
}

export interface CommandResponse {
  interpreter: 'rules' | 'llm' | 'none';
  operations: OpPreview[];
  clarification: string | null;
  applied?: { op: string; ok: boolean; message: string }[];
}
