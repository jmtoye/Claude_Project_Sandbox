// SYNTHETIC test data only — used by tests, the local dev server and screenshots.
// Never import this into the live dashboard.
import { addDays } from '../src/server/time';

type M = { title: string; state?: 'not_started' | 'in_progress' | 'done'; weight?: number; deadline?: string | null; target_date?: string | null; evidence?: string; evidence_basis?: '' | 'owner_confirmed' | 'source_fact'; confirmed?: boolean; checklist?: { title: string; done: boolean }[] };

export function syntheticProjects(today: string) {
  const d = (n: number) => addDays(today, n);
  const done = (title: string, w = 1): M => ({ title, state: 'done', weight: w, evidence: 'Synthetic evidence: signed-off record', evidence_basis: 'owner_confirmed' });
  const P = (space: 'work' | 'personal', name: string, o: Record<string, unknown>, milestones: M[], steps: { title: string; assignee?: string; due_date?: string | null; needs_decision?: boolean; is_primary?: boolean }[] = [], issues: { kind: 'blocker' | 'risk' | 'tip'; title: string; severity?: 'high' | 'medium' | 'low' }[] = []) => ({
    space,
    name,
    canonical_url: `https://example.test/synthetic/${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
    history_note: 'Synthetic test project',
    status: 'in_progress',
    priority: 'medium',
    ...o,
    milestones: milestones.map((m) => ({ confirmed: true, ...m })),
    next_steps: steps.map((s, i) => ({ is_primary: i === 0, ...s })),
    issues,
    sources: [{ kind: 'web', title: 'Synthetic tracker', url: `https://example.test/tracker/${encodeURIComponent(name)}` }],
  });

  const work = [
    P('work', 'Warehouse Robotics Pilot', { pinned: true, status: 'on_track', priority: 'high', phrase: 'Small automations, compounding gains.', status_summary: 'Pilot cell running two shifts; throughput +14% vs baseline.' },
      [done('Site survey'), done('Vendor selection', 2), { title: 'Pilot cell live', state: 'in_progress', weight: 3, target_date: d(9), checklist: [{ title: 'Safety sign-off', done: true }, { title: 'Shift training', done: true }, { title: 'KPI baseline', done: false }] }, { title: 'Go/no-go review', target_date: d(30) }],
      [{ title: 'Confirm KPI baseline with operations lead', assignee: 'Ops lead' }]),
    P('work', 'Customer Portal Redesign', { status: 'blocked', priority: 'high', phrase: 'Clarity is a feature.', status_summary: 'Design approved; build blocked on identity provider contract.' },
      [done('Discovery'), done('Design system'), { title: 'Build & integrate SSO', state: 'in_progress', weight: 3, deadline: d(12) }, { title: 'Beta launch', deadline: d(40) }],
      [{ title: 'Escalate IdP contract signature', needs_decision: true }], [{ kind: 'blocker', title: 'Identity provider contract unsigned', severity: 'high' }, { kind: 'risk', title: 'Beta date at risk if SSO slips 2+ weeks' }]),
    P('work', 'Quarterly Board Pack Automation', { status: 'at_risk', phrase: 'Let the numbers speak, on time.', status_summary: 'Finance data feed late; Q3 pack may need manual assembly.' },
      [done('Template agreed'), { title: 'Automated data pull', state: 'in_progress', deadline: d(-3) }, { title: 'Q3 pack issued', deadline: d(6) }],
      [{ title: 'Decide: manual fallback for Q3?', needs_decision: true }], [{ kind: 'risk', title: 'Finance feed schema still changing' }]),
    P('work', 'Supplier Onboarding Workflow', { status: 'on_track', status_summary: 'Forms digitised; approvals routing in test.' },
      [done('Process map'), done('Forms digitised'), { title: 'Approval routing', state: 'in_progress', target_date: d(4) }, { title: 'Rollout to procurement', target_date: d(21) }],
      [{ title: 'Run UAT with two buyers', due_date: d(2) }]),
    P('work', 'Data Retention Policy Refresh', { status: 'in_progress', priority: 'low', status_summary: 'Draft policy with legal for comment.' },
      [{ title: 'Draft policy', state: 'done', evidence: 'Synthetic: draft v1 circulated', evidence_basis: 'owner_confirmed' }, { title: 'Legal review', state: 'in_progress', target_date: d(14) }, { title: 'Policy approved' }],
      [{ title: 'Chase legal comments', due_date: d(-1) }]),
    P('work', 'Field Service Scheduling', { status: 'on_track', status_summary: 'Optimiser cut travel time 9% in region A.' },
      [done('Region A trial', 2), { title: 'Region B rollout', state: 'in_progress', weight: 2, target_date: d(18) }, { title: 'All regions', weight: 2 }], [{ title: 'Schedule region B training' }]),
    P('work', 'Executive Dashboard KPIs', { status: 'unassessed', status_summary: 'Scope being defined with leadership team.' },
      [{ title: 'Agree KPI set', confirmed: false }, { title: 'Prototype dashboard', confirmed: false }, { title: 'Launch', confirmed: false }], [{ title: 'Workshop with leadership', due_date: d(5) }]),
    P('work', 'Contract Renewal — Facilities', { status: 'at_risk', priority: 'high', status_summary: 'Incumbent proposal 18% above budget.' },
      [done('Requirements'), { title: 'Negotiation', state: 'in_progress', deadline: d(3) }, { title: 'Contract signed', deadline: d(25) }], [{ title: 'Decide negotiation mandate', needs_decision: true }]),
    P('work', 'Incident Response Runbooks', { status: 'on_track', status_summary: '9 of 14 runbooks reviewed.' },
      [{ title: 'Runbooks reviewed', state: 'in_progress', weight: 3, checklist: Array.from({ length: 14 }, (_, i) => ({ title: `Runbook ${i + 1}`, done: i < 9 })) }, { title: 'Tabletop exercise', target_date: d(20) }], [{ title: 'Review runbooks 10–14' }]),
    P('work', 'Travel Expense Policy Bot', { lifecycle: 'paused', status: 'in_progress', status_summary: 'Paused until Q1 budget confirmed.' }, [done('Prototype'), { title: 'Pilot' }], [{ title: 'Revisit after budget' }]),
    P('work', 'Learning Platform Migration', { status: 'in_progress', status_summary: 'Content export 60% complete.' },
      [done('Platform chosen'), { title: 'Content migrated', state: 'in_progress', weight: 2, target_date: d(11) }, { title: 'Old platform retired', deadline: d(45) }], [{ title: 'Validate SCORM packages' }]),
    P('work', 'Fleet Telematics Tender', { status: 'in_progress', status_summary: 'Three bids received; scoring under way.' },
      [done('RFP issued'), { title: 'Bids evaluated', state: 'in_progress', target_date: d(7) }, { title: 'Award' }], [{ title: 'Complete scoring matrix' }]),
    P('work', 'Office Move Planning', { status: 'on_track', priority: 'low', status_summary: 'Floor plan agreed; IT survey booked.' }, [done('Floor plan'), { title: 'IT fit-out', target_date: d(35) }, { title: 'Move weekend', deadline: d(60) }], [{ title: 'Book IT survey' }]),
    P('work', 'Revenue Forecast Model v2', { status: 'in_progress', status_summary: 'Seasonality features added; backtest pending.' }, [done('Data prep'), { title: 'Backtest', state: 'in_progress', target_date: d(8) }, { title: 'Sign-off by CFO' }], [{ title: 'Run 24-month backtest' }]),
    P('work', 'Accessibility Audit Remediation', { status: 'at_risk', status_summary: '27 issues open; 6 critical.' }, [done('Audit'), { title: 'Critical fixes', state: 'in_progress', target_date: d(-2) }, { title: 'Re-audit' }], [{ title: 'Assign remaining critical fixes', due_date: d(0) }], [{ kind: 'risk', title: 'Shared component fixes touch many pages' }]),
    P('work', 'Knowledge Base Consolidation', { status: 'in_progress', priority: 'low', status_summary: 'Two of four wikis merged.' }, [done('Inventory'), { title: 'Merge wikis', state: 'in_progress', checklist: [{ title: 'Ops wiki', done: true }, { title: 'IT wiki', done: true }, { title: 'HR wiki', done: false }, { title: 'Sales wiki', done: false }] }], [{ title: 'Merge HR wiki' }]),
    P('work', 'Vendor Risk Questionnaires', { status: 'on_track', status_summary: '42 of 60 suppliers responded.' }, [{ title: 'Questionnaires returned', state: 'in_progress', target_date: d(16) }, { title: 'Risk ratings published' }], [{ title: 'Second reminder to 18 suppliers' }]),
    P('work', 'Sales Proposal Generator', { status: 'in_progress', status_summary: 'Template library 70% built; legal clauses pending.' }, [done('Template audit'), { title: 'Generator MVP', state: 'in_progress', target_date: d(13) }], [{ title: 'Get approved clause list from legal' }], [{ kind: 'blocker', title: 'Approved legal clause list not yet provided', severity: 'medium' }]),
    P('work', 'Energy Usage Reporting', { status: 'on_track', priority: 'low', status_summary: 'Meters connected at 5 of 7 sites.' }, [{ title: 'All sites connected', state: 'in_progress', target_date: d(24) }, { title: 'First monthly report' }], [{ title: 'Install meters at last two sites' }]),
    P('work', 'Procurement Analytics Programme — Phase 2 Spend Cube & Category Insights', { status: 'at_risk', priority: 'high', phrase: 'Know the spend, shape the choices.', status_summary: 'Spend cube built for 3 of 8 categories; data quality issues in services spend are slowing the remaining five categories.' },
      [done('Phase 1 foundations', 2), { title: 'Spend cube for all categories', state: 'in_progress', weight: 3, target_date: d(27), checklist: Array.from({ length: 8 }, (_, i) => ({ title: `Category ${i + 1}`, done: i < 3 })) }, { title: 'Category insight packs', weight: 2 }], [{ title: 'Clean services spend vendor mapping and confirm the category owners for the remaining five categories with procurement leads' }], [{ kind: 'blocker', title: 'Services spend vendor master has 1,200 unmapped suppliers awaiting data owner review', severity: 'high' }]),
  ];

  const personal = [
    P('personal', 'Kitchen Renovation', { pinned: true, status: 'blocked', phrase: 'Make room for good evenings.', status_summary: 'Cabinets delayed at supplier.' }, [done('Design'), { title: 'Cabinets installed', state: 'in_progress', target_date: d(10) }], [{ title: 'Call supplier about delivery date' }], [{ kind: 'blocker', title: 'Waiting for the cabinet supplier', severity: 'high' }]),
    P('personal', 'Marathon Training', { status: 'on_track', phrase: 'One steady mile at a time.', status_summary: 'Week 9 of 16 complete.' }, [{ title: 'Training block', state: 'in_progress', checklist: Array.from({ length: 16 }, (_, i) => ({ title: `Week ${i + 1}`, done: i < 9 })) }, { title: 'Race day', deadline: d(49) }], [{ title: 'Long run 28 km Sunday' }]),
    P('personal', 'Family Photo Archive', { status: 'in_progress', priority: 'low', status_summary: 'Scanning 2001–2005 albums.' }, [{ title: 'Albums scanned', state: 'in_progress' }, { title: 'Shared album published' }], [{ title: 'Scan 2004 album' }]),
    P('personal', 'Tax Return 2026', { status: 'at_risk', priority: 'high', status_summary: 'Two receipts missing.' }, [{ title: 'Documents gathered', state: 'in_progress', deadline: d(-1) }, { title: 'Return filed', deadline: d(20) }], [{ title: 'Find missing receipts', needs_decision: false }]),
  ];
  return { work, personal };
}
