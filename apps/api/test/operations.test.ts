import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { api, bookingBody, getApp, key, registerCompany, setupInventory, type Session } from './helpers';

async function balanced(s: Session) {
  return (await api(s).get('/accounting/reports/trial-balance').expect(200)).body.data.balanced as boolean;
}
async function accountId(s: Session, systemKey: string) {
  const rows = (await api(s).get('/accounting/accounts').expect(200)).body.data as { id: string; systemKey?: string }[];
  return rows.find((a) => a.systemKey === systemKey)!.id;
}

describe('land acquisition', () => {
  it('tracks the deal pipeline and capitalises owner payments, capped at the agreed cost', async () => {
    const s = await registerCompany();
    const http = api(s);
    const parcel = (
      await http
        .post('/land', {
          khasraNumber: '214/2',
          village: 'Kolua Kalan',
          district: 'Bhopal',
          state: 'Madhya Pradesh',
          areaX100: 250,
          areaUnit: 'acre',
          owners: [{ name: 'Ram Singh', sharePercentBp: 10_000 }],
          agreedCostPaise: 50_00_000_00,
        })
        .expect(201)
    ).body.data;
    // Duplicate khasra in the same village is rejected.
    await http.post('/land', { khasraNumber: '214/2', village: 'Kolua Kalan', district: 'Bhopal', state: 'Madhya Pradesh', areaX100: 1 }).expect(409);

    const pay = (amount: number) => http.post(`/land/${parcel.id}/payments`, { amountPaise: amount, paidOn: '2026-05-01', mode: 'rtgs', payee: 'Ram Singh' }, key());
    expect((await pay(10_00_000_00)).status).toBe(422); // no payments during negotiation
    await http.post(`/land/${parcel.id}/status`, { status: 'registered' }).expect(422); // must pass through agreement
    await http.post(`/land/${parcel.id}/status`, { status: 'agreement', date: '2026-04-20' }).expect(200);

    expect((await pay(20_00_000_00)).status).toBe(201);
    // Concurrent payments can never push the total over the agreed cost.
    const burst = await Promise.all([pay(20_00_000_00), pay(20_00_000_00), pay(20_00_000_00)]);
    expect(burst.filter((r) => r.status === 201)).toHaveLength(1);
    const detail = (await http.get(`/land/${parcel.id}`).expect(200)).body.data;
    expect(detail.paidPaise).toBe(40_00_000_00);
    expect(detail.balancePaise).toBe(10_00_000_00);
    expect(detail.payments.map((p: { number: string }) => p.number).every((n: string) => /^LPV\/2026-27\/\d{6}$/.test(n))).toBe(true);
    expect(detail.statusHistory.map((h: { to: string }) => h.to)).toEqual(['negotiation', 'agreement']);

    await http.post(`/land/${parcel.id}/status`, { status: 'dropped' }).expect(422); // paid parcels cannot be dropped
    await http.patch(`/land/${parcel.id}`, { agreedCostPaise: 1 }).expect(422); // below amount paid

    const tb = (await http.get('/accounting/reports/trial-balance').expect(200)).body.data;
    expect(tb.balanced).toBe(true);
    expect(tb.rows.find((r: { code: string }) => r.code === '1300').debitPaise).toBe(40_00_000_00);
    expect((await http.get('/land/summary')).body.data).toMatchObject({ paidPaise: 40_00_000_00, agreedCostPaise: 50_00_000_00 });
  });
});

describe('CRM', () => {
  it('runs a lead from enquiry to customer exactly once', async () => {
    const s = await registerCompany();
    const inv = await setupInventory(s, 2, 'CRM');
    const http = api(s);
    const lead = (
      await http
        .post('/leads', { projectId: inv.project.id, name: 'Neha Jain', phone: '+91 90000 11111', source: 'facebook', interestedPlotIds: [inv.plots[0]!.id] })
        .expect(201)
    ).body.data;
    expect(lead.status).toBe('new');

    await http.post(`/leads/${lead.id}/activities`, { type: 'call', summary: 'Discussed corner plots', nextFollowUpAt: new Date(Date.now() - 60_000).toISOString() }).expect(201);
    let detail = (await http.get(`/leads/${lead.id}`).expect(200)).body.data;
    expect(detail.status).toBe('contacted');
    expect(detail.activities.map((a: { type: string }) => a.type)).toEqual(['call', 'note']);

    const due = (await http.get('/leads?followUp=due').expect(200)).body.data as { id: string }[];
    expect(due.map((l) => l.id)).toContain(lead.id);

    await http.post(`/leads/${lead.id}/status`, { status: 'won' }).expect(422); // must convert
    await http.post(`/leads/${lead.id}/status`, { status: 'lost' }).expect(400); // needs reason

    const conv = (await http.post(`/leads/${lead.id}/convert`).expect(200)).body.data;
    expect(conv.linkedExisting).toBe(false);
    await http.post(`/leads/${lead.id}/convert`).expect(422);
    detail = (await http.get(`/leads/${lead.id}`).expect(200)).body.data;
    expect(detail.status).toBe('won');
    expect(detail.customerId.id).toBe(conv.customerId);
    await http.get(`/customers/${conv.customerId}`).expect(200);

    // A second lead with a known phone links the existing customer instead of duplicating it.
    const again = (await http.post('/leads', { name: 'Neha J', phone: '+91 90000 11111' }).expect(201)).body.data;
    expect((await http.post(`/leads/${again.id}/convert`).expect(200)).body.data).toMatchObject({ customerId: conv.customerId, linkedExisting: true });

    const summary = (await http.get('/leads/summary').expect(200)).body.data;
    expect(summary.byStatus.won).toBe(2);
    expect(summary.conversionRateBp).toBe(10_000);
  });

  it('sends one follow-up reminder per lead per day to the assignee', async () => {
    const s = await registerCompany();
    const http = api(s);
    const lead = (await http.post('/leads', { name: 'Follow Me', phone: '+91 90000 22222', assignedTo: s.userId, nextFollowUpAt: new Date(Date.now() - 1000).toISOString() }).expect(201)).body.data;
    const { runFollowUpReminders } = await import('../src/modules/crm/crm.service');
    await runFollowUpReminders();
    await runFollowUpReminders();
    const notes = (await http.get('/notifications').expect(200)).body.data.items as { title: string; link: string }[];
    expect(notes.filter((n) => n.link === `/crm?lead=${lead.id}`)).toHaveLength(1);
  });
});

describe('vendors, work orders and expenses', () => {
  it('books bills against work orders without overbilling and keeps vendor ledgers in the books', async () => {
    const s = await registerCompany();
    const inv = await setupInventory(s, 1, 'CON');
    const http = api(s);
    const vendor = (await http.post('/vendors', { name: 'Shree Road Builders', category: 'road', gstin: '23ABCDE1234F1Z5' }).expect(201)).body.data;
    const wo = (
      await http
        .post('/work-orders', {
          projectId: inv.project.id,
          vendorId: vendor.id,
          title: 'Internal roads phase 1',
          amountPaise: 10_00_000_00,
          milestones: [{ name: 'Base course', percentBp: 4_000 }, { name: 'Bitumen', percentBp: 6_000 }],
        })
        .expect(201)
    ).body.data;
    expect(wo.number).toMatch(/^WO\/\d{4}-\d{2}\/\d{6}$/);
    const dev = await accountId(s, 'development_expense');
    const bill = (amount: number, extra: object = {}) =>
      http.post(
        '/expenses',
        { projectId: inv.project.id, vendorId: vendor.id, workOrderId: wo.id, expenseAccountId: dev, date: '2026-06-01', amountPaise: amount, description: 'RA bill', settlement: 'payable', ...extra },
        key(),
      );

    expect((await bill(1_00_000_00)).status).toBe(422); // draft orders cannot be billed
    await http.post(`/work-orders/${wo.id}/status`, { status: 'in_progress' }).expect(422); // must be issued first
    await http.post(`/work-orders/${wo.id}/status`, { status: 'issued' }).expect(200);
    const first = (await bill(6_00_000_00, { billNumber: 'RA-1' })).body.data;
    expect(first.number).toMatch(/^EXP\//);
    expect((await bill(4_00_000_01)).status).toBe(422); // would exceed the order
    const parallel = await Promise.all([bill(3_00_000_00), bill(3_00_000_00)]);
    expect(parallel.filter((r) => r.status === 201)).toHaveLength(1);

    let v = (await http.get(`/vendors/${vendor.id}`).expect(200)).body.data;
    expect(v.payableBalancePaise).toBe(9_00_000_00);
    expect(v.ledger.at(-1).balancePaise).toBe(9_00_000_00);

    // Vendor payments cannot exceed what is owed.
    await http.post(`/vendors/${vendor.id}/payments`, { amountPaise: 9_00_000_01, paidOn: '2026-06-10', mode: 'neft' }, key()).expect(422);
    await http.post(`/vendors/${vendor.id}/payments`, { amountPaise: 8_00_000_00, paidOn: '2026-06-10', mode: 'neft', reference: 'UTR9' }, key()).expect(201);
    v = (await http.get(`/vendors/${vendor.id}`).expect(200)).body.data;
    expect(v.payableBalancePaise).toBe(1_00_000_00);

    // A bill that has effectively been paid cannot be reversed; the unpaid remainder logic protects the ledger.
    await http.post(`/expenses/${first.id}/reverse`, { reason: 'wrong' }).expect(422);
    await http.post(`/work-orders/${wo.id}/status`, { status: 'cancelled' }).expect(422); // has bills

    // Control accounts are off-limits to manual vouchers.
    await http
      .post('/accounting/journal-entries', {
        date: '2026-06-11',
        narration: 'sneaky',
        lines: [
          { accountId: await accountId(s, 'vendor_payable'), debitPaise: 100 },
          { accountId: await accountId(s, 'bank'), creditPaise: 100 },
        ],
      })
      .expect(422);

    // Direct paid expense, then reversal of an unpaid bill restores the order's headroom.
    await http.post('/expenses', { projectId: inv.project.id, expenseAccountId: dev, date: '2026-06-12', amountPaise: 25_000_00, description: 'Site electricity', settlement: 'paid', mode: 'upi' }, key()).expect(201);
    const small = (await bill(50_000_00)).body.data;
    await http.post(`/expenses/${small.id}/reverse`, { reason: 'duplicate bill' }).expect(200);
    const after = (await http.get(`/work-orders/${wo.id}`).expect(200)).body.data;
    expect(after.billedPaise).toBe(9_00_000_00);

    const milestone = after.milestones[0];
    await http.post(`/work-orders/${wo.id}/milestones/${milestone.id}`, { completed: true }).expect(200);

    const costs = (await http.get(`/work-orders/costs?projectId=${inv.project.id}`).expect(200)).body.data;
    expect(costs.workOrders).toMatchObject({ committedPaise: 10_00_000_00, billedPaise: 9_00_000_00 });
    expect(costs.expensesPaise).toBe(9_25_000_00);
    expect(await balanced(s)).toBe(true);
    const pl = (await http.get('/accounting/reports/profit-loss?from=2026-04-01&to=2027-03-31').expect(200)).body.data;
    expect(pl.totalExpensesPaise).toBe(9_25_000_00);
  });

  it('refuses work orders for another company’s vendor', async () => {
    const a = await registerCompany();
    const b = await registerCompany();
    const invA = await setupInventory(a, 1, 'AAA');
    const vendorB = (await api(b).post('/vendors', { name: 'Other Co Vendor' }).expect(201)).body.data;
    await api(a).post('/work-orders', { projectId: invA.project.id, vendorId: vendorB.id, title: 'x', amountPaise: 100 }).expect(400);
    await api(a).get(`/vendors/${vendorB.id}`).expect(404);
  });
});

describe('broker commissions', () => {
  it('accrues on confirmation, pays out, and reverses unpaid accruals on cancellation', async () => {
    const s = await registerCompany();
    const inv = await setupInventory(s, 3, 'BRK');
    const http = api(s);
    const broker = (await http.post('/brokers', { name: 'Vikas Realty', phone: '+91 91111 22222', commissionBp: 200 }).expect(201)).body.data;

    const b1 = (await http.post('/bookings', bookingBody(inv, [0], { brokerId: broker.id }), key()).expect(201)).body.data;
    const b2 = (await http.post('/bookings', bookingBody(inv, [1], { brokerId: broker.id, mode: 'reserve' }), key()).expect(201)).body.data;
    let detail = (await http.get(`/brokers/${broker.id}`).expect(200)).body.data;
    expect(detail.commissions).toHaveLength(1); // reservations do not accrue
    expect(detail.commissions[0]).toMatchObject({ amountPaise: 20_000_00, status: 'accrued' }); // 2% of ₹10L

    await http.post(`/bookings/${b2.id}/confirm`).expect(200);
    await http.post(`/bookings/${b2.id}/confirm`).expect(422);
    detail = (await http.get(`/brokers/${broker.id}`).expect(200)).body.data;
    expect(detail.commissions).toHaveLength(2);
    expect(detail.payableBalancePaise).toBe(40_000_00);

    const c1 = detail.commissions.find((c: { bookingId: { id: string } }) => c.bookingId.id === b1.id);
    const payout = await http.post(`/brokers/${broker.id}/payouts`, { commissionIds: [c1.id], paidOn: '2026-06-01', mode: 'neft' }, key()).expect(201);
    expect(payout.body.data.totalPaise).toBe(20_000_00);
    await http.post(`/brokers/${broker.id}/payouts`, { commissionIds: [c1.id], paidOn: '2026-06-01', mode: 'neft' }, key()).expect(422);

    // Cancelling both bookings: the unpaid accrual is reversed, the paid one stays paid.
    await http.post(`/bookings/${b1.id}/cancel`, { reason: 'withdrew' }).expect(200);
    await http.post(`/bookings/${b2.id}/cancel`, { reason: 'withdrew' }).expect(200);
    detail = (await http.get(`/brokers/${broker.id}`).expect(200)).body.data;
    const statuses = detail.commissions.map((c: { status: string }) => c.status).sort();
    expect(statuses).toEqual(['cancelled', 'paid']);
    expect(detail.payableBalancePaise).toBe(0);
    expect(await balanced(s)).toBe(true);

    const list = (await http.get('/brokers').expect(200)).body.data;
    expect(list[0]).toMatchObject({ paidPaise: 20_000_00, accruedPaise: 0 });
  });
});

describe('documents', () => {
  const pdf = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(200, 32), Buffer.from('\n%%EOF')]);

  it('uploads privately, authorizes every download with a short-lived signed URL and validates contents', async () => {
    const s = await registerCompany();
    const inv = await setupInventory(s, 1, 'DOC');
    const app = getApp();
    const up = (buf: Buffer, name: string, type: string, entityId = inv.project.id, token = s.token) =>
      request(app)
        .post('/api/v1/documents')
        .set('Authorization', `Bearer ${token}`)
        .field('entityType', 'project')
        .field('entityId', entityId)
        .field('category', 'layout_plan')
        .attach('file', buf, { filename: name, contentType: type });

    const created = await up(pdf, 'layout plan.pdf', 'application/pdf').expect(201);
    expect(created.body.data).not.toHaveProperty('storageKey');
    expect(created.body.data.checksumSha256).toHaveLength(64);

    await up(Buffer.from('<html><script>alert(1)</script>'), 'evil.pdf', 'application/pdf').expect(400); // signature mismatch
    await up(Buffer.from('MZ....'), 'tool.exe', 'application/octet-stream').expect(400); // type not allowed
    await up(Buffer.concat([pdf, Buffer.alloc(1024 * 1024)]), 'big.pdf', 'application/pdf').expect(413);

    const list = (await api(s).get(`/documents?entityType=project&entityId=${inv.project.id}`).expect(200)).body.data;
    expect(list).toHaveLength(1);
    const { url } = (await api(s).get(`/documents/${list[0].id}/url`).expect(200)).body.data;
    expect(url).toMatch(/^\/api\/v1\/files\//);
    const file = await request(app).get(url).expect(200);
    expect(file.headers['content-type']).toBe('application/pdf');
    expect(file.headers['content-disposition']).toContain('attachment');
    expect(file.headers['x-content-type-options']).toBe('nosniff');
    expect(Buffer.from(file.body).subarray(0, 5).toString()).toBe('%PDF-');

    // Tampered or expired links are refused.
    await request(app).get(`${url.slice(0, -2)}xx`).expect(403);

    // Another company can neither list, link nor attach.
    const other = await registerCompany();
    await api(other).get(`/documents?entityType=project&entityId=${inv.project.id}`).expect(404);
    await api(other).get(`/documents/${list[0].id}/url`).expect(404);
    await up(pdf, 'x.pdf', 'application/pdf', inv.project.id, other.token).expect(404);

    // Soft delete hides the document.
    await api(s).delete(`/documents/${list[0].id}`).expect(200);
    expect((await api(s).get(`/documents?entityType=project&entityId=${inv.project.id}`).expect(200)).body.data).toHaveLength(0);
  });

  it('rejects expired file tokens', async () => {
    const { signFileToken } = await import('../src/modules/documents/storage');
    const token = signFileToken({ k: 'x/y.pdf', n: 'y.pdf', t: 'application/pdf', d: 'attachment', e: Math.floor(Date.now() / 1000) - 1 });
    await request(getApp()).get(`/api/v1/files/${token}`).expect(403);
  });
});

describe('project-restricted users on Phase 2 data', () => {
  it('see only their projects’ land and leads, plus leads assigned to them', async () => {
    const owner = await registerCompany('Scoped Co');
    const inv1 = await setupInventory(owner, 1, 'S1');
    const inv2 = await setupInventory(owner, 1, 'S2');
    const http = api(owner);
    const roles = (await http.get('/roles').expect(200)).body.data as { id: string; systemKey?: string }[];
    const sales = roles.find((r) => r.systemKey === 'sales')!;
    // Give the sales role land.read for this test.
    const allPerms = (await http.get('/permissions').expect(200)).body.data.all as string[];
    await http.patch(`/roles/${sales.id}`, { permissions: [...allPerms.filter((p) => p.startsWith('crm.') || p === 'land.read' || p === 'documents.read')] }).expect(200);

    const { testOutbox } = await import('../src/utils/mailer');
    await http.post('/invitations', { email: 'scoped@example.com', roleId: sales.id, projectAccess: { mode: 'restricted', projectIds: [inv1.project.id] } }).expect(201);
    const token = /token=([\w-]+)/.exec(testOutbox.filter((m) => m.to === 'scoped@example.com').at(-1)!.text)![1];
    const accepted = await request(getApp()).post('/api/v1/auth/accept-invite').send({ token, name: 'Scoped User', password: 'Str0ngPassw0rd!' }).expect(201);
    const u = { token: accepted.body.data.accessToken as string };
    const scopedUserId = accepted.body.data.user.id as string;

    const base = { district: 'Bhopal', state: 'MP', areaX100: 100 };
    await http.post('/land', { ...base, khasraNumber: '1', village: 'A', projectId: inv1.project.id }).expect(201);
    const hidden = (await http.post('/land', { ...base, khasraNumber: '2', village: 'B', projectId: inv2.project.id }).expect(201)).body.data;
    await http.post('/land', { ...base, khasraNumber: '3', village: 'C' }).expect(201); // company-level
    const land = (await api(u).get('/land').expect(200)).body.data as { khasraNumber: string }[];
    expect(land.map((l) => l.khasraNumber)).toEqual(['1']);
    await api(u).get(`/land/${hidden.id}`).expect(404);

    await http.post('/leads', { name: 'P1 lead', phone: '+91 90000 00001', projectId: inv1.project.id }).expect(201);
    await http.post('/leads', { name: 'P2 lead', phone: '+91 90000 00002', projectId: inv2.project.id }).expect(201);
    await http.post('/leads', { name: 'Assigned lead', phone: '+91 90000 00003', projectId: inv2.project.id, assignedTo: scopedUserId }).expect(201);
    const leads = ((await api(u).get('/leads').expect(200)).body.data as { name: string }[]).map((l) => l.name).sort();
    expect(leads).toEqual(['Assigned lead', 'P1 lead']);
  });
});
