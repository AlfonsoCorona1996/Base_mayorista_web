import { commitmentDates, commitmentOccurrences, FinanceCommitment, reviseCommitment, validateCommitment } from './finance-commitments';
import { FinanceExpense } from './finance.service';

describe('Compromisos y pagos', () => {
  const plan: FinanceCommitment = { commitment_id: 'salary', business_id: 'bm', route_id: null, start_date: '2026-01-31', end_date: null, frequency: 'monthly', revision: 1,
    revisions: [{ from: '2026-01-31', title: 'Sueldo', recipient: 'Ana', category: 'sueldos', amount: 1000, estimated: false, cancelled: false }], overrides: {} };
  const expense = (amount: number, changes: Partial<FinanceExpense> = {}): FinanceExpense => ({ expense_id: 'payment', business_id: 'bm', route_id: null, category: 'sueldos', amount, occurred_at: '2026-03-01', account_id: 'bank', installment_index: null, installment_total: null, notes: 'Sueldo', commitment_id: 'salary', commitment_due_date: '2026-02-28', ...changes });
  it('conserva el día original al pasar por febrero y respeta inicio, fin y años bisiestos', () => {
    expect(commitmentDates(plan, '2026-02')).toEqual(['2026-02-28']);
    expect(commitmentDates(plan, '2026-03')).toEqual(['2026-03-31']);
    expect(commitmentDates({ ...plan, start_date: '2024-01-31' }, '2024-02')).toEqual(['2024-02-29']);
    expect(commitmentDates({ ...plan, end_date: '2026-02-15' }, '2026-02')).toEqual([]);
    expect(commitmentDates(plan, '2025-12')).toEqual([]);
    expect(commitmentDates(plan, '2026-99')).toEqual([]);
  });
  it('genera quincenas el 15 y último día, sin duplicar ni anticipar el inicio', () => {
    expect(commitmentDates({ ...plan, frequency: 'semimonthly' }, '2026-02')).toEqual(['2026-02-15', '2026-02-28']);
    expect(commitmentDates({ ...plan, frequency: 'semimonthly', start_date: '2026-02-16' }, '2026-02')).toEqual(['2026-02-28']);
    expect(commitmentDates({ ...plan, frequency: 'once' }, '2026-02')).toEqual([]);
  });
  it('atribuye pagos por vínculo al vencimiento, aunque se paguen otro mes, sin mezclar negocios', () => {
    const rows = commitmentOccurrences([plan], '2026-02', [expense(250), expense(400, { expense_id: 'other', business_id: 'catalogo' }), expense(100, { expense_id: 'unlinked', commitment_id: null })], '2026-03-02');
    expect(rows[0].paid).toBe(250); expect(rows[0].remaining).toBe(750); expect(rows[0].status).toBe('Parcial'); expect(rows[0].overdue).toBeTrue();
  });
  it('no crea pagos por precargar y conserva excesos y centavos', () => {
    expect(commitmentOccurrences([plan], '2026-02', [])[0].paid).toBe(0);
    const row = commitmentOccurrences([plan], '2026-02', [expense(1000.01)])[0];
    expect(row.remaining).toBe(0); expect(row.excess).toBe(.01); expect(row.status).toBe('Pagado');
  });
  it('cambia una ocurrencia sin alterar anteriores ni siguientes y divide cambios futuros', () => {
    const terms = { ...plan.revisions[0], amount: 1200 };
    const one = reviseCommitment(plan, '2026-02-28', terms, 'one');
    expect(commitmentOccurrences([one], '2026-02', [])[0].amount).toBe(1200);
    expect(commitmentOccurrences([one], '2026-03', [])[0].amount).toBe(1000);
    const future = reviseCommitment(one, '2026-02-28', { ...terms, amount: 1500 }, 'future');
    expect(commitmentOccurrences([future], '2026-01', [])[0].amount).toBe(1000);
    expect(commitmentOccurrences([future], '2026-03', [])[0].amount).toBe(1500);
  });
  it('cancelar conserva pagos realizados, elimina pendientes y permite reactivar', () => {
    const cancelled = reviseCommitment(plan, '2026-02-28', { ...plan.revisions[0], cancelled: true }, 'one');
    const row = commitmentOccurrences([cancelled], '2026-02', [expense(100)])[0];
    expect(row.paid).toBe(100); expect(row.remaining).toBe(0); expect(row.status).toBe('Cancelado');
    const restored = reviseCommitment(cancelled, '2026-02-28', plan.revisions[0], 'one');
    expect(commitmentOccurrences([restored], '2026-02', [expense(100)])[0].remaining).toBe(900);
  });
  it('rechaza fechas imposibles, importes inválidos y cambios ajenos al calendario', () => {
    expect(() => validateCommitment({ ...plan, end_date: '2026-02-30' })).toThrow();
    expect(() => validateCommitment({ ...plan, revisions: [{ ...plan.revisions[0], amount: NaN }] })).toThrow();
    expect(() => reviseCommitment(plan, '2026-02-12', plan.revisions[0], 'one')).toThrow();
  });
});
