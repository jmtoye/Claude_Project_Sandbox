// Natural-language commands ("Pin this project", "Change the target to 15 October").
// A deterministic rule parser handles common phrasings without any API key; Claude
// (when configured) handles the rest. Both only *propose* operations; nothing changes
// until the user confirms, and execution goes through ops.ts with the requesting
// user's own permissions.
import { z } from 'zod';
import type { CommandResponse, OpPreview, Space } from '../../shared/types';
import { canEdit, canOwnerWrite, projectScope, type Principal } from '../auth/principal';
import type { Deps } from '../config';
import { OPS, executeOp, type OpName } from '../ops';
import { hkDate, parseHumanDate } from '../time';

interface MilestoneLite {
  id: string;
  title: string;
  state: string;
}
interface ProjectLite {
  id: string;
  name: string;
  space: Space;
  lifecycle: string;
  only_me: number;
  milestones: MilestoneLite[];
}

async function loadContext(deps: Deps, principal: Principal): Promise<ProjectLite[]> {
  const scope = projectScope(principal, 'p');
  const projects = await deps.db.all<Omit<ProjectLite, 'milestones'>>(`SELECT p.id, p.name, p.space, p.lifecycle, p.only_me FROM projects p WHERE ${scope.sql} ORDER BY p.name`, scope.params);
  const ms = await deps.db.all<MilestoneLite & { project_id: string }>(
    `SELECT m.id, m.title, m.state, m.project_id FROM milestones m JOIN projects p ON p.id = m.project_id WHERE ${scope.sql} ORDER BY m.position`,
    scope.params,
  );
  return projects.map((p) => ({ ...p, milestones: ms.filter((m) => m.project_id === p.id).map(({ project_id: _, ...m }) => m) }));
}

const norm = (s: string) => s.toLowerCase().replace(/[“”"'’.,!?]/g, '').replace(/\s+/g, ' ').trim();

function matchByName<T extends { name?: string; title?: string }>(items: T[], phrase: string): T | null {
  const q = norm(phrase);
  if (!q) return null;
  const label = (x: T) => norm(x.name ?? x.title ?? '');
  return items.find((x) => label(x) === q) ?? items.find((x) => label(x).includes(q)) ?? (q.length >= 4 ? items.find((x) => q.includes(label(x))) : undefined) ?? null;
}

interface RuleResult {
  ops: { op: OpName; args: Record<string, unknown> }[];
  clarification?: string;
}

const THIS = /^(this|it|this project|the project|that)$/;

/** Deterministic parser for the most common commands. Returns null if it does not recognise the request. */
export function parseRules(text: string, ctx: { today: string; current: ProjectLite | null; projects: ProjectLite[] }): RuleResult | null {
  const t = text.trim().replace(/[.!]+$/, '');
  const lower = t.toLowerCase();

  const resolveProject = (ref: string | undefined): ProjectLite | null | 'ambiguous' => {
    const r = (ref ?? '').trim().replace(/^(the )?project /i, '').replace(/ project$/i, '');
    if (!r || THIS.test(r.toLowerCase())) return ctx.current ?? 'ambiguous';
    return matchByName(ctx.projects, r) ?? 'ambiguous';
  };
  const needProject = (ref?: string) => {
    const p = resolveProject(ref);
    return p === 'ambiguous' || !p ? null : p;
  };
  const which = (ref?: string): RuleResult => ({ ops: [], clarification: ref && !THIS.test(ref.trim().toLowerCase()) ? `I couldn't find a project matching "${ref.trim()}".` : 'Which project? Open it first or include its name.' });

  let m: RegExpMatchArray | null;

  // Add a project
  if ((m = t.match(/^add (?:a )?(?:new )?project(?: called| named)? ["“]?(.+?)["”]? to (work|personal)$/i))) {
    return { ops: [{ op: 'create_project', args: { name: m[1].trim(), space: m[2].toLowerCase() } }] };
  }
  if ((m = t.match(/^add (?:this|a|the|new)? ?project to (work|personal)(?:[:,]? (?:called|named)? ?["“]?(.+?)["”]?)?$/i))) {
    if (!m[2]) return { ops: [], clarification: `What should the new ${m[1]} project be called? e.g. "Add project Kitchen renovation to ${m[1]}".` };
    return { ops: [{ op: 'create_project', args: { name: m[2].trim(), space: m[1].toLowerCase() } }] };
  }

  // Pin / unpin
  if ((m = lower.match(/^(un)?pin(?: (.+))?$/))) {
    const p = needProject(m[2]);
    return p ? { ops: [{ op: 'set_pinned', args: { project_id: p.id, pinned: !m[1] } }] } : which(m[2]);
  }

  // Only me
  if ((m = lower.match(/^make (.+?) (?:visible )?only (?:to|for) me$/)) || (m = lower.match(/^(?:set )?only me(?: on)?(?: for (.+))?$/))) {
    const p = needProject(m[1]);
    return p ? { ops: [{ op: 'set_only_me', args: { project_id: p.id, enabled: true } }] } : which(m[1]);
  }
  if ((m = lower.match(/^make (.+?) visible to (?:others|everyone|everybody|renata|my team|people with access)(?: again)?$/)) || (m = lower.match(/^(?:turn )?only me off(?: for (.+))?$/))) {
    const p = needProject(m[1]);
    return p ? { ops: [{ op: 'set_only_me', args: { project_id: p.id, enabled: false } }] } : which(m[1]);
  }

  // Flag blocked
  if ((m = t.match(/^(?:flag|mark|set) (.+?) (?:as )?blocked(?:\s*(?:while|because|as|since|until|by|on|:|-|—)\s*(.+))?$/i))) {
    const p = needProject(m[1]);
    if (!p) return which(m[1]);
    const reason = (m[2] ?? '').trim();
    if (!reason) return { ops: [], clarification: 'What is it blocked by? e.g. "Flag this as blocked while we wait for the supplier".' };
    const fullReason = /^(we |waiting|wait)/i.test(reason) ? reason.replace(/^we /i, '').replace(/^wait /i, 'Waiting ').replace(/^waiting/i, 'Waiting') : reason;
    return { ops: [{ op: 'flag_blocked', args: { project_id: p.id, reason: fullReason.charAt(0).toUpperCase() + fullReason.slice(1) } }] };
  }

  // Milestone complete
  if ((m = t.match(/^(?:mark|set) (?:the )?(?:(.+?) )?milestone(?: ["“]?(.+?)["”]?)? (?:as )?(?:complete|completed|done|finished)$/i))) {
    const ref = (m[2] ?? m[1] ?? '').trim();
    const p = ctx.current;
    const projects = p ? [p, ...ctx.projects.filter((x) => x.id !== p.id)] : ctx.projects;
    if (!ref || /^(this|the current|current|next)$/i.test(ref)) {
      if (!p) return which();
      const next = p.milestones.find((x) => x.state !== 'done');
      if (!next) return { ops: [], clarification: 'All milestones in this project are already complete.' };
      return { ops: [{ op: 'complete_milestone', args: { project_id: p.id, milestone_id: next.id } }] };
    }
    for (const proj of projects) {
      const ms = matchByName(proj.milestones, ref);
      if (ms) return { ops: [{ op: 'complete_milestone', args: { project_id: proj.id, milestone_id: ms.id } }] };
    }
    return { ops: [], clarification: `I couldn't find a milestone matching "${ref}".` };
  }

  // Dates
  if ((m = t.match(/^(?:change|set|move|update) (?:the )?(target|deadline)(?: date)?(?: (?:for|of|on) (.+?))? to (.+?)(?:\s+(?:because|as|since|:|-)\s+(.+))?$/i))) {
    const kind = m[1].toLowerCase() === 'deadline' ? 'deadline' : 'target';
    const date = parseHumanDate(m[3], ctx.today);
    if (!date) return { ops: [], clarification: `I couldn't read the date "${m[3]}". Try "15 October" or "2026-10-15".` };
    let project = ctx.current;
    let milestoneId: string | undefined;
    if (m[2]) {
      const ref = m[2].trim();
      const inProject = project ? matchByName(project.milestones, ref) : null;
      if (inProject) milestoneId = inProject.id;
      else {
        const pr = matchByName(ctx.projects, ref);
        if (pr) project = pr;
        else {
          for (const proj of ctx.projects) {
            const ms = matchByName(proj.milestones, ref);
            if (ms) {
              project = proj;
              milestoneId = ms.id;
              break;
            }
          }
        }
        if (!project) return which(ref);
      }
    }
    if (!project) return which();
    const args: Record<string, unknown> = { project_id: project.id, date, kind };
    if (milestoneId) args.milestone_id = milestoneId;
    if (m[4]) args.note = m[4].trim();
    return { ops: [{ op: 'set_target_date', args }] };
  }

  // Lifecycle
  if ((m = lower.match(/^(pause|resume|unpause|archive|unarchive|reopen|complete|finish)(?: (.+))?$/)) || (m = lower.match(/^mark (.+?) (?:as )?(complete|completed|done|finished)$/))) {
    const verb = ['pause', 'resume', 'unpause', 'archive', 'unarchive', 'reopen', 'complete', 'finish'].includes(m[1]) ? m[1] : m[2];
    const ref = verb === m[1] ? m[2] : m[1];
    const p = needProject(ref);
    if (!p) return which(ref);
    const lifecycle = { pause: 'paused', resume: 'active', unpause: 'active', archive: 'archived', unarchive: 'active', reopen: 'active', complete: 'completed', completed: 'completed', done: 'completed', finish: 'completed', finished: 'completed' }[verb]!;
    return { ops: [{ op: 'set_lifecycle', args: { project_id: p.id, lifecycle } }] };
  }

  // Next step
  if ((m = t.match(/^add (?:a )?next (?:step|action)(?: to (.+?))?[:\-—]\s*(.+)$/i))) {
    const p = needProject(m[1]);
    return p ? { ops: [{ op: 'add_next_step', args: { project_id: p.id, title: m[2].trim() } }] } : which(m[1]);
  }
  return null;
}

export function describeOp(op: string, args: Record<string, unknown>, projects: ProjectLite[]): string {
  const p = projects.find((x) => x.id === args.project_id);
  const pn = p ? `"${p.name}"` : 'the project';
  const ms = p?.milestones.find((x) => x.id === args.milestone_id);
  switch (op) {
    case 'create_project':
      return `Add a new project "${args.name}" to ${args.space === 'work' ? 'Work' : 'Personal'}`;
    case 'set_pinned':
      return `${args.pinned ? 'Pin' : 'Unpin'} ${pn}`;
    case 'set_only_me':
      return args.enabled ? `Make ${pn} visible only to you` : `Make ${pn} visible to people with access again`;
    case 'flag_blocked':
      return `Flag ${pn} as blocked: ${args.reason}`;
    case 'complete_milestone':
      return `Mark milestone "${ms?.title ?? args.milestone_id}" in ${pn} complete${args.evidence ? ` (evidence: ${args.evidence})` : ''}`;
    case 'set_target_date':
      return `Set the ${args.kind === 'deadline' ? 'confirmed deadline' : 'target date'} for ${ms ? `"${ms.title}"` : 'the next open milestone'} in ${pn} to ${args.date}${args.note ? ` (${args.note})` : ''}`;
    case 'set_lifecycle':
      return `${{ active: 'Reopen/resume', paused: 'Pause', completed: 'Mark complete', archived: 'Archive' }[String(args.lifecycle)] ?? 'Change'} ${pn}`;
    case 'add_next_step':
      return `Add next step to ${pn}: ${args.title}`;
    case 'update_project':
      return `Update ${pn}: ${Object.keys(args).filter((k) => k !== 'project_id').join(', ')}`;
    default:
      return `${op.replace(/_/g, ' ')} ${p ? pn : ''}`.trim();
  }
}

const OWNER_ONLY: OpName[] = ['create_project', 'set_only_me', 'delete_project'];
const NOT_FOR_NL: OpName[] = ['delete_project'];

export function permittedOps(principal: Principal): OpName[] {
  const editsAnything = canEdit(principal, 'personal') || canEdit(principal, 'work');
  if (!editsAnything) return [];
  return (Object.keys(OPS) as OpName[]).filter((n) => !NOT_FOR_NL.includes(n) && (canOwnerWrite(principal) || !OWNER_ONLY.includes(n)));
}

export async function interpretCommand(deps: Deps, principal: Principal, text: string, currentProjectId?: string): Promise<CommandResponse> {
  const projects = await loadContext(deps, principal);
  const current = projects.find((p) => p.id === currentProjectId) ?? null;
  const today = hkDate(deps.now());
  const preview = (ops: { op: string; args: Record<string, unknown> }[]): OpPreview[] => ops.map((o) => ({ ...o, description: describeOp(o.op, o.args, projects) }));

  if (permittedOps(principal).length === 0) {
    return { interpreter: 'none', operations: [], clarification: 'You have view-only access, so commands that change projects are not available.' };
  }
  const rules = parseRules(text, { today, current, projects });
  if (rules && (rules.ops.length || !deps.llm)) return { interpreter: 'rules', operations: preview(rules.ops), clarification: rules.clarification ?? null };

  if (!deps.llm) {
    return {
      interpreter: 'none',
      operations: [],
      clarification:
        'I did not recognise that. Without an AI key configured I understand commands like: "Pin this project", "Pause <name>", "Flag this as blocked while we wait for the supplier", "Mark the <milestone> milestone complete", "Change the target to 15 October", "Make this project visible only to me", "Add project <name> to Work".',
    };
  }
  const allowed = permittedOps(principal);
  const tools = allowed.map((name) => ({ name, description: OPS[name].summary, input_schema: z.toJSONSchema(OPS[name].schema, { target: 'draft-2020-12', io: 'input' }) as Record<string, unknown> }));
  const context = {
    today,
    current_project_id: current?.id ?? null,
    projects: projects.map((p) => ({ id: p.id, name: p.name, space: p.space, lifecycle: p.lifecycle, milestones: p.milestones })),
  };
  const out = await deps.llm.interpretCommand({ text, context, tools });
  const ops: { op: string; args: Record<string, unknown> }[] = [];
  const problems: string[] = [];
  for (const c of out.calls) {
    if (!allowed.includes(c.name as OpName)) {
      problems.push(`"${c.name}" is not permitted`);
      continue;
    }
    const parsed = OPS[c.name as OpName].schema.safeParse(c.input);
    if (!parsed.success) {
      problems.push(`could not understand the arguments for ${c.name}`);
      continue;
    }
    const args = parsed.data as Record<string, unknown>;
    if (typeof args.project_id === 'string' && !projects.some((p) => p.id === args.project_id)) {
      problems.push('it referred to an unknown project');
      continue;
    }
    ops.push({ op: c.name, args });
  }
  const clarification = out.text && !ops.length ? out.text : problems.length ? `Some of that could not be done: ${problems.join('; ')}.` : null;
  return { interpreter: 'llm', operations: preview(ops), clarification };
}

/** Applies previously previewed operations, each re-validated and permission-checked. */
export async function applyCommand(deps: Deps, principal: Principal, operations: { op: string; args: unknown }[], via: 'user' | 'assistant' = 'assistant') {
  const applied: { op: string; ok: boolean; message: string }[] = [];
  for (const o of operations.slice(0, 10)) {
    try {
      const r = await executeOp({ deps, principal, actor: { type: via, label: via === 'assistant' ? `${principal.name} (via assistant)` : principal.name } }, o.op, o.args);
      applied.push({ op: o.op, ok: true, message: r.message });
    } catch (err) {
      applied.push({ op: o.op, ok: false, message: (err as Error).message });
    }
  }
  return applied;
}
