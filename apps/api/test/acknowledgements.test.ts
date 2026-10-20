import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, inDays, signUp, type Harness, type TestClient } from './helpers/harness.js';

const MAIL = { SMTP_URL: 'smtp://user:pass@mail.example.com:587', MAIL_FROM: 'ToolTrace <alerts@example.com>' };

describe('confirming what you were issued', () => {
  let h: Harness;
  let admin: Awaited<ReturnType<typeof signUp>>;
  let sk: Awaited<ReturnType<typeof signUp>>;
  let tech: Awaited<ReturnType<typeof signUp>>;
  let other: Awaited<ReturnType<typeof signUp>>;
  let anon: TestClient;
  let loc: string;
  const newTool = async (tag: string) =>
    (await sk.client.post('/api/tools', { assetTag: tag, name: `Crimper ${tag}`, category: 'Electrical', homeLocationId: loc })).body.tool.id as string;
  const linkFor = async (email: string) => {
    await h.deliver();
    const mail = [...h.mailbox].reverse().find((m) => m.to === email && m.text.includes('/ack#token='))!;
    return mail.text.match(/\/ack#token=([A-Za-z0-9_-]+)/)![1]!;
  };

  beforeAll(async () => {
    h = await createHarness(MAIL);
    admin = await signUp(h, 'admin', 'Priya Nair');
    sk = await signUp(h, 'storekeeper', 'Ravi Kumar');
    tech = await signUp(h, 'technician', 'Asha Verma');
    other = await signUp(h, 'technician', 'Vikram Singh');
    anon = h.client();
    loc = (await sk.client.post('/api/locations', { name: 'Crib', kind: 'crib' })).body.location.id;
  });
  afterAll(() => h.close());

  it('asks the person to confirm a tool issued to them, in the app and by email', async () => {
    const toolId = await newTool('ACK-0001');
    const res = await sk.client.post('/api/checkouts', { toolId, holderId: tech.user.id, dueBackAt: inDays(1) });
    expect(res.status).toBe(201);

    const dash = (await tech.client.get('/api/dashboard')).body;
    expect(dash.myAcknowledgements).toEqual([
      expect.objectContaining({ subjectType: 'checkout', summary: 'ACK-0001 Crimper ACK-0001', requestedByName: 'Ravi Kumar' }),
    ]);
    expect((await sk.client.get(`/api/tools/${toolId}`)).body.tool.openCheckout.acknowledgement).toMatchObject({ status: 'pending' });
    expect((await tech.client.get('/api/notifications')).body.notifications[0]).toMatchObject({
      kind: 'issue.confirm', title: 'Ravi Kumar issued you ACK-0001 Crimper ACK-0001',
    });
    expect(await linkFor(tech.user.email)).toBeTruthy();

    // Only the person it was issued to can answer.
    const ackId = dash.myAcknowledgements[0].id;
    expect((await other.client.post(`/api/acknowledgements/${ackId}/answer`, { answer: 'received' })).status).toBe(404);
    expect((await tech.client.post(`/api/acknowledgements/${ackId}/answer`, { answer: 'received' })).body.status).toBe('acknowledged');
    expect((await tech.client.post(`/api/acknowledgements/${ackId}/answer`, { answer: 'received' })).body.error.code).toBe('already_answered');
    expect((await tech.client.get('/api/dashboard')).body.myAcknowledgements).toEqual([]);
    const checkouts = (await sk.client.get('/api/checkouts?open=true')).body.checkouts;
    expect(checkouts.find((c: { toolId: string }) => c.toolId === toolId).ackStatus).toBe('acknowledged');
    const audit = (await admin.client.get('/api/audit?action=issue.')).body.entries[0];
    expect(audit).toMatchObject({ action: 'issue.acknowledged', actorUserId: tech.user.id, details: { via: 'app' } });
  });

  it('needs no confirmation when you take a tool yourself', async () => {
    const toolId = await newTool('ACK-0002');
    await tech.client.post('/api/checkouts', { toolId, dueBackAt: inDays(1) });
    expect((await tech.client.get(`/api/tools/${toolId}`)).body.tool.openCheckout.acknowledgement).toBeNull();
  });

  it('lets them say "I did not get it" from the email, once, and tells whoever issued it and the crib', async () => {
    const toolId = await newTool('ACK-0003');
    await sk.client.post('/api/checkouts', { toolId, holderId: tech.user.id, dueBackAt: inDays(1) });
    const token = await linkFor(tech.user.email);

    expect((await anon.post('/api/ack/info', { token })).body).toMatchObject({
      summary: 'ACK-0003 Crimper ACK-0003', issuedBy: 'Ravi Kumar', issuedTo: 'Asha Verma',
    });
    const answer = await anon.post('/api/ack/answer', { token, answer: 'not_received', note: 'Never handed over' });
    expect(answer.body.status).toBe('disputed');
    expect((await anon.post('/api/ack/answer', { token, answer: 'received' })).body.error.code).toBe('link_invalid');
    expect((await anon.post('/api/ack/info', { token })).status).toBe(404);

    const told = await h.sql<{ userId: string }[]>`SELECT user_id FROM notifications WHERE kind = 'issue.disputed'`;
    expect(told.map((r) => r.userId).sort()).toEqual([admin.user.id, sk.user.id].sort());
    expect((await sk.client.get('/api/notifications')).body.notifications[0].title).toBe('Asha Verma says they did not receive ACK-0003 Crimper ACK-0003');
    const audit = (await admin.client.get('/api/audit?action=issue.disputed')).body.entries[0];
    expect(audit).toMatchObject({ actorUserId: tech.user.id, details: { via: 'email', note: 'Never handed over' } });
    const open = (await sk.client.get('/api/acknowledgements?scope=all')).body.acknowledgements;
    expect(open.find((a: { summary: string }) => a.summary.startsWith('ACK-0003'))).toMatchObject({ status: 'disputed', userName: 'Asha Verma' });
    // Technicians only ever see their own, whatever they ask for.
    expect((await other.client.get('/api/acknowledgements?scope=all')).body.acknowledgements).toEqual([]);
  });

  it('reminds once if nobody answers within a day', async () => {
    const toolId = await newTool('ACK-0004');
    await sk.client.post('/api/checkouts', { toolId, holderId: other.user.id, dueBackAt: inDays(2) });
    expect((await h.jobs.runDue()).ackReminders).toBe(0);
    await h.sql`UPDATE acknowledgements SET created_at = now() - interval '25 hours' WHERE user_id = ${other.user.id}`;
    expect((await h.jobs.runDue()).ackReminders).toBe(1);
    expect((await h.jobs.runDue()).ackReminders).toBe(0);
  });
});
