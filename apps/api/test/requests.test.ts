import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, signUp, type Harness } from './helpers/harness.js';

describe('requests and approvals', () => {
  let h: Harness;
  let admin: Awaited<ReturnType<typeof signUp>>;
  let admin2: Awaited<ReturnType<typeof signUp>>;
  let sk: Awaited<ReturnType<typeof signUp>>;
  let tech: Awaited<ReturnType<typeof signUp>>;
  let other: Awaited<ReturnType<typeof signUp>>;
  let auditor: Awaited<ReturnType<typeof signUp>>;
  let toolId: string;

  beforeAll(async () => {
    h = await createHarness();
    admin = await signUp(h, 'admin', 'Priya Nair');
    admin2 = await signUp(h, 'admin', 'Arjun Mehta');
    sk = await signUp(h, 'storekeeper', 'Ravi Kumar');
    tech = await signUp(h, 'technician', 'Asha Verma');
    other = await signUp(h, 'technician', 'Vikram Singh');
    auditor = await signUp(h, 'auditor', 'Meera Iyer');
    const loc = (await sk.client.post('/api/locations', { name: 'Crib', kind: 'crib' })).body.location.id;
    toolId = (await sk.client.post('/api/tools', { assetTag: 'TW-0101', name: 'Torque wrench', category: 'Torque', homeLocationId: loc })).body.tool.id;
  });
  afterAll(() => h.close());

  const ask = (who: typeof tech, body: Record<string, unknown>) => who.client.post('/api/requests', body);
  const titles = (n: { title: string }[]) => n.map((x) => x.title);

  it('runs a replacement request through review, approval and fulfilment, telling the right people each time', async () => {
    const res = await ask(tech, { kind: 'replacement', reason: 'damaged', title: 'Torque wrench 20-100 Nm', toolId, details: 'Ratchet slips', estimatedCost: 18500 });
    expect(res.status).toBe(201);
    const id = res.body.request.id;
    expect(res.body.request).toMatchObject({ number: 1, status: 'submitted' });
    expect(titles((await sk.client.get('/api/notifications')).body.notifications)).toContain('Asha Verma asks for Torque wrench 20-100 Nm');

    // A technician can't review or approve; the storekeeper reviews.
    expect((await other.client.post(`/api/requests/${id}/review`, { action: 'forward' })).status).toBe(403);
    expect((await admin.client.post(`/api/requests/${id}/decide`, { action: 'approve' })).body.error.message).toBe('A storekeeper has to review it first');
    expect((await sk.client.post(`/api/requests/${id}/review`, { action: 'forward', note: 'Agreed, beyond repair' })).body.status).toBe('reviewed');
    expect(titles((await admin.client.get('/api/notifications')).body.notifications)).toContain('Approve REQ-0001 Torque wrench 20-100 Nm?');

    const toApprove = (await admin.client.get('/api/requests?scope=approve')).body;
    expect(toApprove.counts.toApprove).toBe(1);
    expect(toApprove.requests[0]).toMatchObject({ toolAssetTag: 'TW-0101', reason: 'damaged', estimatedCost: 18500, reviewedByName: 'Ravi Kumar' });
    expect((await admin.client.post(`/api/requests/${id}/decide`, { action: 'approve', note: 'Order from Norbar' })).body.status).toBe('approved');
    expect(titles((await tech.client.get('/api/notifications')).body.notifications)).toContain('REQ-0001 Torque wrench 20-100 Nm is approved');

    expect((await tech.client.post(`/api/requests/${id}/fulfil`, {})).status).toBe(403);
    expect((await sk.client.post(`/api/requests/${id}/fulfil`, { note: 'In the crib, slot B4' })).body.status).toBe('fulfilled');

    const detail = (await tech.client.get(`/api/requests/${id}`)).body;
    expect(detail.events.map((e: { action: string; byName: string }) => `${e.action} ${e.byName}`)).toEqual([
      'submitted Asha Verma', 'reviewed Ravi Kumar', 'approved Priya Nair', 'fulfilled Ravi Kumar',
    ]);
    const audit = (await auditor.client.get(`/api/audit?entityId=${id}`)).body.entries.map((e: { action: string }) => e.action);
    expect(audit).toEqual(['request.fulfilled', 'request.approved', 'request.reviewed', 'request.submitted']);
  });

  it('never lets anyone sign off their own request, and needs a second person to approve what they reviewed', async () => {
    const own = (await ask(sk, { kind: 'new_tool', reason: 'new_requirement', title: 'Borescope' })).body.request.id;
    expect((await sk.client.post(`/api/requests/${own}/review`, { action: 'forward' })).body.error.message).toBe('You cannot review your own request');
    const byAdmin = (await ask(admin, { kind: 'stock', reason: 'used_up', title: 'Cable ties', quantity: 500 })).body.request.id;
    await sk.client.post(`/api/requests/${byAdmin}/review`, { action: 'forward' });
    expect((await admin.client.post(`/api/requests/${byAdmin}/decide`, { action: 'approve' })).body.error.message).toBe('You cannot approve your own request');

    const reviewedByAdmin = (await ask(tech, { kind: 'new_tool', reason: 'kaizen', title: 'Magnetic tray' })).body.request.id;
    await admin.client.post(`/api/requests/${reviewedByAdmin}/review`, { action: 'forward' });
    expect((await admin.client.post(`/api/requests/${reviewedByAdmin}/decide`, { action: 'approve' })).body.error.message).toBe('Someone other than the reviewer has to approve it');
    expect((await admin2.client.post(`/api/requests/${reviewedByAdmin}/decide`, { action: 'approve' })).body.status).toBe('approved');

    // The database holds the line too.
    await expect(h.sql`UPDATE requests SET status = 'approved', decided_by = reviewed_by, decided_at = now() WHERE id = ${byAdmin}`).rejects.toThrow();
    await expect(h.sql`UPDATE requests SET status = 'submitted' WHERE id = ${reviewedByAdmin}`).rejects.toThrow(/cannot become/);
  });

  it('shows people their own requests, crib staff and auditors all of them, and lets the requester withdraw', async () => {
    const mine = (await ask(other, { kind: 'new_tool', reason: 'other', title: 'Feeler gauge' })).body.request.id;
    expect((await tech.client.get(`/api/requests/${mine}`)).status).toBe(404);
    expect((await tech.client.get('/api/requests?scope=all')).body.requests.every((r: { requestedByName: string }) => r.requestedByName === 'Asha Verma')).toBe(true);
    expect((await auditor.client.get('/api/requests?scope=all')).body.requests.length).toBeGreaterThanOrEqual(4);
    expect((await tech.client.post(`/api/requests/${mine}/cancel`, {})).status).toBe(404);
    expect((await other.client.post(`/api/requests/${mine}/cancel`, { note: 'Found one' })).body.status).toBe('cancelled');
    expect((await other.client.post(`/api/requests/${mine}/cancel`, {})).body.error.code).toBe('invalid_transition');
    expect((await ask(auditor, { kind: 'new_tool', reason: 'other', title: 'x' })).status).toBe(403);
    expect((await ask(tech, { kind: 'replacement', reason: 'missing', title: 'x' })).status).toBe(422);
  });

  it('lets the reviewer turn a request down, with the reason sent to the requester', async () => {
    const id = (await ask(tech, { kind: 'new_tool', reason: 'kaizen', title: 'Gold-plated spanner' })).body.request.id;
    expect((await sk.client.post(`/api/requests/${id}/review`, { action: 'reject', note: 'Not needed' })).body.status).toBe('rejected');
    const n = (await tech.client.get('/api/notifications')).body.notifications[0];
    expect(n).toMatchObject({ kind: 'request.rejected', link: `/requests?id=${id}`, body: 'Ravi Kumar: “Not needed”' });
  });
});
