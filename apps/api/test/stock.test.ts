import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, signUp, type Harness } from './helpers/harness.js';

describe('consumables and PPE', () => {
  let h: Harness;
  let admin: Awaited<ReturnType<typeof signUp>>;
  let sk: Awaited<ReturnType<typeof signUp>>;
  let tech: Awaited<ReturnType<typeof signUp>>;
  let other: Awaited<ReturnType<typeof signUp>>;
  let auditor: Awaited<ReturnType<typeof signUp>>;
  let loc: string;
  let gloves: string;
  const move = (id: string, body: Record<string, unknown>) => sk.client.post(`/api/stock/${id}/movements`, body);
  const item = async (id: string) => (await sk.client.get(`/api/stock/${id}`)).body.item;

  beforeAll(async () => {
    h = await createHarness();
    admin = await signUp(h, 'admin');
    sk = await signUp(h, 'storekeeper', 'Ravi Kumar');
    tech = await signUp(h, 'technician', 'Asha Verma');
    other = await signUp(h, 'technician', 'Vikram Singh');
    auditor = await signUp(h, 'auditor');
    loc = (await sk.client.post('/api/locations', { name: 'PPE Store', kind: 'crib' })).body.location.id;
  });
  afterAll(() => h.close());

  it('adds items with an opening stock, for crib staff only', async () => {
    const body = { code: 'ppe-glv-01', name: 'Cut-resistant gloves', kind: 'ppe', category: 'Hand protection', unit: 'pairs', locationId: loc, reorderLevel: 10, unitPrice: 180, openingQuantity: 25 };
    expect((await tech.client.post('/api/stock', body)).status).toBe(403);
    const res = await sk.client.post('/api/stock', body);
    expect(res.status).toBe(201);
    expect(res.body.item).toMatchObject({ code: 'PPE-GLV-01', quantity: 25, abcClass: 'C', stockValue: 4500, low: false, locationName: 'PPE Store' });
    gloves = res.body.item.id;
    expect((await sk.client.post('/api/stock', body)).body.error.code).toBe('already_exists');
    expect((await tech.client.get('/api/stock?kind=ppe')).body.items.map((i: { code: string }) => i.code)).toEqual(['PPE-GLV-01']);
  });

  it('issues to a person (who confirms it), never more than is in stock', async () => {
    const res = await move(gloves, { kind: 'issue', quantity: 4, issuedTo: tech.user.id, note: 'Welding bay' });
    expect(res.body.movement).toMatchObject({ quantity: -4, balanceAfter: 21 });
    const too = await move(gloves, { kind: 'issue', quantity: 22, issuedTo: tech.user.id });
    expect(too.body.error).toMatchObject({ code: 'insufficient_stock', message: 'Only 21 pairs of PPE-GLV-01 in stock' });
    expect((await move(gloves, { kind: 'issue', quantity: 1, issuedTo: auditor.user.id })).body.error.code).toBe('invalid_holder');
    expect((await tech.client.post(`/api/stock/${gloves}/movements`, { kind: 'receive', quantity: 100 })).status).toBe(403);

    const mine = (await tech.client.get('/api/stock/mine')).body.issues;
    expect(mine).toEqual([expect.objectContaining({ code: 'PPE-GLV-01', quantity: 4, byName: 'Ravi Kumar', ackStatus: 'pending' })]);
    expect((await tech.client.get('/api/dashboard')).body.myAcknowledgements[0]).toMatchObject({
      subjectType: 'stock_issue', summary: '4 pairs Cut-resistant gloves (PPE-GLV-01)',
    });
    // Technicians see only their own issues in an item's history.
    const theirs = (await other.client.get(`/api/stock/${gloves}`)).body.movements;
    expect(theirs).toEqual([]);
    const all = (await sk.client.get(`/api/stock/${gloves}`)).body.movements.map((m: { kind: string; quantity: number }) => `${m.kind} ${m.quantity}`);
    expect(all).toEqual(['issue -4', 'receive 25']);
  });

  it('keeps the count true: receipts, returns, and a correction that always says why', async () => {
    await move(gloves, { kind: 'receive', quantity: 10, note: 'PO 4471' });
    await move(gloves, { kind: 'return', quantity: 1, issuedTo: tech.user.id, note: 'Unused pair' });
    expect((await item(gloves)).quantity).toBe(32);
    expect((await move(gloves, { kind: 'adjust', countedQuantity: 30 })).status).toBe(422);
    expect((await move(gloves, { kind: 'adjust', countedQuantity: 32, note: 'Monthly count' })).body.error.code).toBe('no_change');
    const fix = await move(gloves, { kind: 'adjust', countedQuantity: 30, note: 'Monthly count: 2 pairs torn' });
    expect(fix.body.movement).toMatchObject({ quantity: -2, balanceAfter: 30 });

    // The database is the last word: no direct edits of the quantity, no edits of history.
    await expect(h.sql`INSERT INTO stock_movements (item_id, kind, quantity, note, by_user) VALUES (${gloves}, 'adjust', -1000, 'x', ${sk.user.id})`).rejects.toThrow(/only 30 pairs/);
    await expect(h.sql`UPDATE stock_movements SET quantity = 1`).rejects.toThrow(/cannot be changed/);
    const audit = (await admin.client.get(`/api/audit?entityId=${gloves}`)).body.entries.map((e: { action: string }) => e.action);
    expect(audit).toEqual(['stock.adjusted', 'stock.returned', 'stock.received', 'stock.issued', 'stock.received', 'stock.item_created']);
  });

  it('tells the crib once when an item goes down to its reorder level', async () => {
    await move(gloves, { kind: 'issue', quantity: 15, issuedTo: tech.user.id });
    expect((await item(gloves)).low).toBe(false);
    await move(gloves, { kind: 'issue', quantity: 5, issuedTo: tech.user.id }); // 30 -> 15 -> 10: at the level
    expect((await item(gloves)).low).toBe(true);
    const told = await h.sql<{ userId: string }[]>`SELECT user_id FROM notifications WHERE kind = 'stock.low'`;
    expect(told.map((r) => r.userId).sort()).toEqual([admin.user.id, sk.user.id].sort());
    await move(gloves, { kind: 'issue', quantity: 1, issuedTo: tech.user.id });
    expect((await h.jobs.runDue()).lowStock).toBe(0); // same week: already told
    expect((await sk.client.get('/api/stock?low=true')).body.items.map((i: { code: string }) => i.code)).toEqual(['PPE-GLV-01']);
  });

  it('can stop stocking an item (kept in the history, no longer issued)', async () => {
    await sk.client.patch(`/api/stock/${gloves}`, { isActive: false, reorderLevel: 0 });
    expect((await sk.client.get('/api/stock')).body.items).toEqual([]);
    expect((await sk.client.get('/api/stock?inactive=true')).body.items).toHaveLength(1);
    expect((await move(gloves, { kind: 'issue', quantity: 1, issuedTo: tech.user.id })).body.error.code).toBe('stock_inactive');
  });
});
