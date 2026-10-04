// Database row shapes (as returned by SQLite / D1).
import type { Basis, Connection, EvidenceBasis, IssueKind, Lifecycle, MilestoneState, Priority, SourceKind, SourceRole, Space, Status } from '../shared/types';

export interface ProjectRow {
  id: string;
  space: Space;
  name: string;
  phrase: string;
  status: Status;
  status_summary: string;
  status_detail: string;
  status_basis: Basis;
  priority: Priority;
  needs_attention: number;
  attention_note: string;
  pinned: number;
  pinned_at: string | null;
  only_me: number;
  lifecycle: Lifecycle;
  lifecycle_changed_at: string | null;
  canonical_url: string;
  needs_review: number;
  last_checked_at: string | null;
  last_evidence_at: string | null;
  created_at: string;
  updated_at: string;
  version: number;
}

export interface MilestoneRow {
  id: string;
  project_id: string;
  position: number;
  title: string;
  description: string;
  weight: number;
  state: MilestoneState;
  confirmed: number;
  evidence: string;
  evidence_basis: EvidenceBasis;
  evidence_source_id: string | null;
  completed_at: string | null;
  checklist: string;
  deadline: string | null;
  deadline_note: string;
  target_date: string | null;
  suggested_date: string | null;
  suggested_basis: string;
  created_at: string;
  updated_at: string;
}

export interface NextStepRow {
  id: string;
  project_id: string;
  position: number;
  title: string;
  assignee: string;
  due_date: string | null;
  needs_decision: number;
  is_primary: number;
  done: number;
  done_at: string | null;
  origin: 'manual' | 'auto';
  basis: Basis;
  citation: string;
  created_at: string;
  updated_at: string;
}

export interface IssueRow {
  id: string;
  project_id: string;
  kind: IssueKind;
  title: string;
  detail: string;
  severity: Priority;
  resolved: number;
  resolved_at: string | null;
  origin: 'manual' | 'auto';
  basis: Basis;
  citation: string;
  created_at: string;
  updated_at: string;
}

export interface SourceRow {
  id: string;
  project_id: string;
  kind: SourceKind;
  role: SourceRole;
  title: string;
  url: string;
  config: string;
  snapshot_text: string;
  as_of: string | null;
  connection: Connection;
  last_checked_at: string | null;
  last_success_at: string | null;
  last_changed_at: string | null;
  content_hash: string | null;
  last_error: string;
  consecutive_failures: number;
  created_at: string;
  updated_at: string;
}

export interface OverrideRow {
  project_id: string;
  field: string;
  set_by: string;
  set_at: string;
  note: string;
}

export interface SuggestionRow {
  id: string;
  project_id: string;
  kind: 'deadline' | 'dependency' | 'milestone' | 'override_conflict';
  payload: string;
  rationale: string;
  citation: string;
  status: string;
  dedupe_key: string;
  created_at: string;
}

export interface ProjectBundle {
  project: ProjectRow;
  milestones: MilestoneRow[];
  steps: NextStepRow[];
  issues: IssueRow[];
  sources: SourceRow[];
  overrides: OverrideRow[];
  pendingSuggestions: number;
}
