// Daily summary at 07:00 Asia/Hong_Kong: schedule, catch-up, idempotency, visibility, delivery.
import { describe, expect, it } from 'vitest';
import { runDailySummaries, runScheduled } from '../src/server/summary';
import { harness, OWNER, RENATA, seed, WORK_VIEWER } from './helpers';

async function setup(env: Record<string, string> = {}) {
  // 2026-10-05 22:30 UTC = 2026-10-06 06:30 HKT
  const h = await harness({ start: '2026-10-05T22:30:00Z', env });
  await seed(h, [
    { space: 'work', name: 'Shared Work', milestones: [{ title: 'Overdue thing', deadline: '2026-10-01' }, { title: 'Soon', target_date: '2026-10-09' }], next_steps: [{ title: 'Do the shared step', is_primary: true }] },
    { space: 'work', name: 'Secret Merger', only_me: true, milestones: [{ title: 'Secret signing', deadline: '2026-10-02' }], next_steps: [{ title: 'Call secret banker', needs_decision: true }] },
    { space: 'personal', name: 'Family Trip', milestones: [{ title: 'Book flights', target_date: '2026-10-07' }] },
  ]);
  await h.db.run('UPDATE users SET summary_email = 1');
  return h;
}

describe('daily summary schedule (Asia/Hong_Kong)', () => {
  it('does nothing before 07:00 HKT, generates at 07:00, and never duplicates', async () => {
    const h = await setup();
    expect((await runDailySummaries(h.deps)).skipped).toBe('before_07');
    h.clock.now = new Date('2026-10-05T22:59:59Z'); // 06:59:59 HKT
    expect((await runDailySummaries(h.deps)).skipped).toBe('before_07');
    h.clock.now = new Date('2026-10-05T23:00:00Z'); // 07:00 HKT, 6 Oct
    const r = await runDailySummaries(h.deps);
    expect(r.generated).toBe(4); // owner, Renata, viewer, editor
    const rows = await h.db.all<{ hk_date: string; late: number }>('SELECT hk_date, late FROM daily_summaries');
    expect(new Set(rows.map((x) => x.hk_date))).toEqual(new Set(['2026-10-06']));
    expect(rows.every((x) => x.late === 0)).toBe(true);
    h.clock.now = new Date('2026-10-06T00:00:00Z'); // 08:00 HKT — hourly run again
    expect((await runDailySummaries(h.deps)).generated).toBe(0);
    expect((await h.db.first<{ n: number }>('SELECT COUNT(*) AS n FROM daily_summaries'))!.n).toBe(4);
  });

  it('catches up later in the day if the 07:00 run was missed, marking it late', async () => {
    const h = await setup();
    h.clock.now = new Date('2026-10-06T01:05:00Z'); // 09:05 HKT
    await runScheduled(h.deps);
    const rows = await h.db.all<{ late: number }>('SELECT late FROM daily_summaries');
    expect(rows.length).toBe(4);
    expect(rows.every((x) => x.late === 1)).toBe(true);
  });

  it('each summary only covers what that person may see; the owner includes Only me', async () => {
    const h = await setup();
    h.clock.now = new Date('2026-10-05T23:00:00Z');
    await runDailySummaries(h.deps);
    const owner = (await h.json(OWNER, 'GET', '/api/summary')).body;
    expect(owner.stored).toBe(true);
    expect(owner.hk_date).toBe('2026-10-06');
    const ownerText = JSON.stringify(owner.content);
    expect(ownerText).toContain('Secret signing');
    expect(owner.content.overdue.map((i: any) => i.title)).toEqual(['Overdue thing', 'Secret signing']);
    expect(owner.content.decisions.map((i: any) => i.title)).toContain('Call secret banker');
    expect(owner.content.upcoming.map((i: any) => i.title)).toEqual(['Book flights', 'Soon']);

    const renata = JSON.stringify((await h.json(RENATA, 'GET', '/api/summary')).body);
    expect(renata).toContain('Family Trip');
    expect(renata).not.toContain('Secret');
    expect(renata).not.toContain('Shared Work');
    const viewer = JSON.stringify((await h.json(WORK_VIEWER, 'GET', '/api/summary')).body);
    expect(viewer).toContain('Overdue thing');
    expect(viewer).not.toContain('Secret');
    expect(viewer).not.toContain('Family Trip');
  });

  it('records honest delivery state when email is not configured', async () => {
    const h = await setup();
    h.clock.now = new Date('2026-10-05T23:00:00Z');
    await runDailySummaries(h.deps);
    const rows = await h.db.all<{ delivery: string }>('SELECT delivery FROM daily_summaries');
    expect(rows.every((r) => r.delivery === 'not_configured')).toBe(true);
    expect(h.fetchLog.some((l) => l.includes('resend'))).toBe(false);
  });

  it('emails each opted-in user their own filtered summary via Resend, idempotently', async () => {
    const h = await setup({ RESEND_API_KEY: 're_test', SUMMARY_FROM_EMAIL: 'Dashboard <summary@dash.test>' });
    await h.db.run('UPDATE users SET summary_email = 0 WHERE email = ?', [WORK_VIEWER]);
    h.clock.now = new Date('2026-10-05T23:00:00Z');
    const r = await runDailySummaries(h.deps);
    expect(r.sent).toBe(3);
    const sent = [...h.web.entries()].filter(([k]) => k.startsWith('resend:')).map(([, v]) => ({ body: JSON.parse(v.body), headers: JSON.parse(v.type!) }));
    expect(sent.length).toBe(3);
    const toRenata = sent.find((s) => s.body.to[0] === RENATA)!;
    expect(toRenata.body.text).toContain('Family Trip');
    expect(toRenata.body.text).not.toContain('Secret');
    expect(toRenata.headers['idempotency-key']).toMatch(/^daily-.+-2026-10-06$/);
    const toOwner = sent.find((s) => s.body.to[0] === OWNER)!;
    expect(toOwner.body.text).toContain('Secret signing');
    const viewer = await h.db.first<{ delivery: string }>('SELECT d.delivery FROM daily_summaries d JOIN users u ON u.id = d.user_id WHERE u.email = ?', [WORK_VIEWER]);
    expect(viewer!.delivery).toBe('disabled');
    // A second run in the same day sends nothing more.
    h.clock.now = new Date('2026-10-06T00:00:00Z');
    expect((await runDailySummaries(h.deps)).sent).toBe(0);
  });

  it('retries failed deliveries on later hourly runs', async () => {
    const h = await setup({ RESEND_API_KEY: 're_test', SUMMARY_FROM_EMAIL: 'summary@dash.test' });
    h.web.set('resend-response', { status: 500, body: 'boom' });
    h.clock.now = new Date('2026-10-05T23:00:00Z');
    expect((await runDailySummaries(h.deps)).failed).toBe(4);
    h.web.delete('resend-response');
    h.clock.now = new Date('2026-10-06T00:00:00Z');
    expect((await runDailySummaries(h.deps)).sent).toBe(4);
  });
});
