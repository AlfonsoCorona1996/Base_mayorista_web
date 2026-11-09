import { TestBed } from '@angular/core/testing';
import { connectFirestoreEmulator, doc, getDoc, getFirestore, setDoc, terminate, updateDoc } from 'firebase/firestore';
import { deleteApp, initializeApp } from 'firebase/app';
import { FIREBASE_APP, FIRESTORE } from './firebase.providers';
import { BusinessScopeService } from './business-scope.service';
import { AuthzService } from './authz.service';
import { FinanceService } from './finance.service';
import { FinanceCommitmentsService } from './finance-commitments.service';
import { FinanceCommitment } from './finance-commitments';
import { buildProfitAudit } from './profit-audit';

// Explicit opt-in only. Uses the real firestore.rules on localhost:8189, never production.
describe('Compromisos: persistencia y permisos (emulador local)', () => {
  const uid = 'commitment-test-user';
  const root = `http://127.0.0.1:8189/v1/projects/${FIREBASE_APP.options.projectId}/databases/(default)/documents`;
  const plan: FinanceCommitment = { commitment_id: 'commitment-test', business_id: 'bm', route_id: null, start_date: '2026-11-01', end_date: null, frequency: 'monthly', revision: 0, overrides: {}, revisions: [{ from: '2026-11-01', title: 'Sueldo', recipient: 'Ana', amount: 100, category: 'sueldos', cancelled: false, estimated: false }] };
  let finance: FinanceService;
  let commitments: FinanceCommitmentsService;
  function encode(value: unknown): unknown {
    if (value === null) return { nullValue: null };
    if (typeof value === 'boolean') return { booleanValue: value };
    if (typeof value === 'number') return { doubleValue: value };
    if (typeof value === 'string') return { stringValue: value };
    if (Array.isArray(value)) return { arrayValue: { values: value.map(encode) } };
    return { mapValue: { fields: Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, encode(item)])) } };
  }
  async function seed(path: string, data: Record<string, unknown>): Promise<void> {
    const result = await fetch(`${root}/${path}`, { method: 'PATCH', headers: { Authorization: 'Bearer owner', 'Content-Type': 'application/json' }, body: JSON.stringify({ fields: Object.fromEntries(Object.entries(data).map(([key, value]) => [key, encode(value)])) }) });
    if (!result.ok) throw new Error(await result.text());
  }
  beforeAll(async () => {
    connectFirestoreEmulator(FIRESTORE, '127.0.0.1', 8189, { mockUserToken: { sub: uid, user_id: uid } });
    for (const path of ['finance_commitments/create-test', 'finance_expenses/payment-test', 'finance_withdrawals/partner-payment', 'finance_periods/bm_2026-11']) {
      await fetch(`${root}/${path}`, { method: 'DELETE', headers: { Authorization: 'Bearer owner' } });
    }
    await seed(`users/${uid}`, { isActive: true, roleId: 'admin', businessMemberships: { bm: { enabled: true } }, sections: { 'sections.administracion': true }, capabilities: Object.fromEntries(['view', 'create', 'edit', 'delete'].map(action => [`cap.finance.movements.${action}`, true])) });
    await seed('finance_accounts/bank-test', { account_id: 'bank-test', business_id: 'bm', name: 'Banco ficticio', balance: 1000, notes: null });
    await seed('finance_accounts/partner-bank', { account_id: 'partner-bank', business_id: 'bm', name: 'Banco de prueba de socios', balance: 1000, notes: null });
    await seed('finance_commitments/commitment-test', { ...plan, revision: 1 });
    await seed('finance_commitments/foreign-existing', { ...plan, commitment_id: 'foreign-existing', business_id: 'catalogo', revision: 1 });
    TestBed.configureTestingModule({ providers: [FinanceService, FinanceCommitmentsService, { provide: BusinessScopeService, useValue: { canAccessBusiness: (id: string) => id === 'bm', availableBusinessIds: () => ['bm'], activeBusinessIds: () => ['bm'], writeBusinessId: () => 'bm' } }, { provide: AuthzService, useValue: { canCap: () => true } }] });
    finance = TestBed.inject(FinanceService); commitments = TestBed.inject(FinanceCommitmentsService);
  }, 60000);
  it('guarda recurrencias, detecta ediciones concurrentes y aplica el aislamiento de negocio', async () => {
    const creating = { ...plan, commitment_id: 'create-test' };
    await commitments.save(creating, true);
    const rows = await commitments.load('bm');
    expect(rows.find(r => r.commitment_id === creating.commitment_id)?.revision).toBe(1);
    await expectAsync(commitments.save(plan, false)).toBeRejectedWithError(/otra sesión/);
    await expectAsync(setDoc(doc(FIRESTORE, 'finance_commitments', 'foreign-plan'), { ...plan, commitment_id: 'foreign-plan', business_id: 'catalogo', revision: 1 })).toBeRejected();
    await expectAsync(getDoc(doc(FIRESTORE, 'finance_commitments', 'foreign-existing'))).toBeRejected();
    await expectAsync(getDoc(doc(FIRESTORE, 'finance_periods', 'catalogo_2026-11'))).toBeRejected();
    await expectAsync(updateDoc(doc(FIRESTORE, 'finance_commitments', plan.commitment_id), { frequency: 'once', revision: 2 })).toBeRejected();
  }, 30000);
  it('precargar no mueve dinero; un pago parcial afecta la cuenta una sola vez incluso al reintentar', async () => {
    const payment = { expense_id: 'payment-test', business_id: 'bm' as const, category: 'sueldos' as const, amount: 40, occurred_at: '2026-11-02', route_id: null, account_id: 'bank-test', installment_index: null, installment_total: null, notes: 'Anticipo', recipient: 'Ana', commitment_id: plan.commitment_id, commitment_due_date: '2026-11-01' };
    expect((await getDoc(doc(FIRESTORE, 'finance_accounts', 'bank-test'))).data()?.['balance']).toBe(1000);
    await finance.saveExpense(payment); await finance.saveExpense(payment);
    expect((await getDoc(doc(FIRESTORE, 'finance_accounts', 'bank-test'))).data()?.['balance']).toBe(960);
    expect(finance.expenses().find(e => e.expense_id === payment.expense_id)?.commitment_id).toBe(plan.commitment_id);
    await finance.linkCommitmentExpense(payment.expense_id, null, null, 'bm');
    expect((await getDoc(doc(FIRESTORE, 'finance_accounts', 'bank-test'))).data()?.['balance']).toBe(960);
    await finance.linkCommitmentExpense(payment.expense_id, plan.commitment_id, '2026-11-01', 'bm');
    expect((await getDoc(doc(FIRESTORE, 'finance_accounts', 'bank-test'))).data()?.['balance']).toBe(960);
    await expectAsync(finance.linkCommitmentExpense(payment.expense_id, plan.commitment_id, '2026-12-01', 'bm')).toBeRejectedWithError(/otro vencimiento/);
    // Existing editing forms omit linkage fields; they must preserve the association.
    const { commitment_id, commitment_due_date, ...editing } = payment;
    await finance.saveExpense({ ...editing, notes: 'Nota corregida' });
    expect(finance.expenses().find(e => e.expense_id === payment.expense_id)?.commitment_due_date).toBe('2026-11-01');
  }, 30000);
  it('mantiene los permisos de solo lectura y bloquea a usuarios inactivos', async () => {
    for (const active of [true, false]) {
      const readerId = `commitment-reader-${active}`;
      await seed(`users/${readerId}`, { isActive: active, roleId: 'admin', businessMemberships: { bm: { enabled: true } }, sections: { 'sections.administracion': true }, capabilities: { 'cap.finance.movements.view': true } });
      const app = initializeApp(FIREBASE_APP.options, readerId);
      const db = getFirestore(app);
      connectFirestoreEmulator(db, '127.0.0.1', 8189, { mockUserToken: { sub: readerId, user_id: readerId } });
      try {
        const account = doc(db, 'finance_accounts', 'bank-test');
        if (active) expect((await getDoc(account)).exists()).toBeTrue();
        else await expectAsync(getDoc(account)).toBeRejected();
        await expectAsync(updateDoc(account, { balance: 0 })).toBeRejected();
        await expectAsync(setDoc(doc(db, 'finance_commitments', `denied-${active}`), { ...plan, commitment_id: `denied-${active}`, revision: 1 })).toBeRejected();
        await expectAsync(setDoc(doc(db, 'finance_expenses', `denied-${active}`), { business_id: 'bm', amount: 40 })).toBeRejected();
        await expectAsync(setDoc(doc(db, 'finance_withdrawals', `denied-${active}`), { business_id: 'bm', amount: 40 })).toBeRejected();
        await expectAsync(setDoc(doc(db, 'finance_ledger_entries', `denied-${active}`), { entry_id: `denied-${active}`, business_id: 'bm', cash_effect: -40, amount: 40, period_id: '2026-11' })).toBeRejected();
      } finally { await terminate(db); await deleteApp(app); }
    }
  }, 30000);
  it('rechaza pagos en un periodo cerrado sin alterar la cuenta', async () => {
    const before = (await getDoc(doc(FIRESTORE, 'finance_accounts', 'bank-test'))).data()?.['balance'];
    await seed('finance_periods/bm_2026-10', { business_id: 'bm', status: 'closed', period_id: '2026-10' });
    try {
      await expectAsync(finance.saveExpense({ expense_id: 'closed-payment', business_id: 'bm', category: 'sueldos', amount: 10, occurred_at: '2026-10-10', route_id: null, account_id: 'bank-test', installment_index: null, installment_total: null, notes: null, recipient: 'Ana', commitment_id: plan.commitment_id, commitment_due_date: '2026-11-01' })).toBeRejectedWithError(/cerrado/);
      expect((await getDoc(doc(FIRESTORE, 'finance_accounts', 'bank-test'))).data()?.['balance']).toBe(before);
    } finally { await fetch(`${root}/finance_periods/bm_2026-10`, { method: 'DELETE', headers: { Authorization: 'Bearer owner' } }); }
  }, 30000);
  it('registra un pago al socio sin convertirlo en gasto ni duplicarlo al reintentar', async () => {
    const payment = { withdrawal_id: 'partner-payment', business_id: 'bm' as const, amount: 200, occurred_at: '2026-11-02', purpose: 'socio_blanca' as const, recipient: 'Blanca', route_id: null, account_id: 'partner-bank', notes: 'Transferencia de utilidades' };
    await finance.saveWithdrawal(payment); await finance.saveWithdrawal(payment);
    expect((await getDoc(doc(FIRESTORE, 'finance_accounts', 'partner-bank'))).data()?.['balance']).toBe(800);
    const report = buildProfitAudit([], [], finance.withdrawals());
    expect(report.totals.blancaWithdrawn).toBe(200);
    expect(report.totals.expenses).toBe(0);
  }, 30000);
});
