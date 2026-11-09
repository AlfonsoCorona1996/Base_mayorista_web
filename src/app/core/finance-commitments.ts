import type { FinanceExpense, FinanceExpenseCategory } from './finance.service';
import type { BusinessId } from './rbac.constants';
import { auditDate } from './profit-audit';

export type CommitmentFrequency = 'once' | 'monthly' | 'semimonthly';
export interface CommitmentTerms {
  title: string;
  recipient: string;
  category: FinanceExpenseCategory;
  amount: number;
  estimated: boolean;
  cancelled: boolean;
}
export interface FinanceCommitment {
  commitment_id: string;
  business_id: BusinessId;
  route_id: string | null;
  start_date: string;
  end_date: string | null;
  frequency: CommitmentFrequency;
  revisions: (CommitmentTerms & { from: string })[];
  overrides: Record<string, CommitmentTerms>;
  revision: number;
}
export interface CommitmentOccurrence extends CommitmentTerms {
  commitment_id: string;
  business_id: BusinessId;
  route_id: string | null;
  due_date: string;
  frequency: CommitmentFrequency;
  paid: number;
  remaining: number;
  excess: number;
  payments: FinanceExpense[];
  status: 'Pendiente' | 'Parcial' | 'Pagado' | 'Cancelado';
  overdue: boolean;
}
export const cents = (amount: number): number => Math.round(amount * 100);
export const calendarToday = (): string => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Mexico_City', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
export function validMonth(month: string): boolean { return /^\d{4}-\d{2}$/.test(month) && !!auditDate(`${month}-01`); }
export function commitmentDates(plan: FinanceCommitment, month: string): string[] {
  if (!validMonth(month) || !auditDate(plan.start_date)) return [];
  const last = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).getUTCDate();
  const dates = plan.frequency === 'once' ? [plan.start_date] :
    (plan.frequency === 'semimonthly' ? [15, last] : [Math.min(Number(plan.start_date.slice(8)), last)])
      .map(day => `${month}-${String(day).padStart(2, '0')}`);
  return dates.filter(date => date.startsWith(month) && date >= plan.start_date && (!plan.end_date || date <= plan.end_date));
}
export function termsFor(plan: FinanceCommitment, date: string): CommitmentTerms | undefined {
  return plan.overrides[date] || [...plan.revisions].sort((a, b) => b.from.localeCompare(a.from)).find(r => r.from <= date);
}
export function commitmentOccurrences(plans: FinanceCommitment[], month: string, expenses: FinanceExpense[], today = calendarToday()): CommitmentOccurrence[] {
  return plans.flatMap(plan => commitmentDates(plan, month).flatMap(date => {
    const terms = termsFor(plan, date);
    if (!terms) return [];
    const payments = expenses.filter(e => e.business_id === plan.business_id && e.commitment_id === plan.commitment_id && e.commitment_due_date === date);
    const paidCents = payments.reduce((sum, e) => sum + cents(e.amount), 0);
    const remaining = terms.cancelled ? 0 : Math.max(0, cents(terms.amount) - paidCents) / 100;
    return [{ ...terms, commitment_id: plan.commitment_id, business_id: plan.business_id, route_id: plan.route_id, due_date: date, frequency: plan.frequency,
      paid: paidCents / 100, remaining, excess: Math.max(0, paidCents - cents(terms.amount)) / 100, payments,
      status: terms.cancelled ? 'Cancelado' as const : remaining === 0 ? 'Pagado' as const : paidCents > 0 ? 'Parcial' as const : 'Pendiente' as const,
      overdue: !terms.cancelled && remaining > 0 && date < today }];
  })).sort((a, b) => a.due_date.localeCompare(b.due_date) || a.title.localeCompare(b.title, 'es'));
}
export function validateCommitment(plan: FinanceCommitment): void {
  if (!auditDate(plan.start_date) || (plan.end_date && (!auditDate(plan.end_date) || plan.end_date < plan.start_date))) throw new Error('Revisa las fechas de inicio y término.');
  if (!['once', 'monthly', 'semimonthly'].includes(plan.frequency)) throw new Error('Selecciona una frecuencia válida.');
  if (!plan.revisions.length || !plan.revisions.some(r => r.from === plan.start_date)) throw new Error('Faltan los datos iniciales del compromiso.');
  for (const r of plan.revisions) if (!auditDate(r.from)) throw new Error('La fecha de cambio no es válida.');
  for (const [date] of Object.entries(plan.overrides)) if (!commitmentDates(plan, date.slice(0, 7)).includes(date)) throw new Error('El vencimiento no pertenece al compromiso.');
  for (const terms of [...plan.revisions, ...Object.values(plan.overrides)]) {
    if (!terms.title.trim() || !terms.recipient.trim()) throw new Error('Escribe el concepto y el beneficiario.');
    if (!Number.isFinite(terms.amount) || terms.amount <= 0 || cents(terms.amount) < 1) throw new Error('El importe debe ser mayor a cero.');
    if (terms.category === 'compra_inversion') throw new Error('Los compromisos de esta sección son gastos operativos.');
  }
}
export function reviseCommitment(plan: FinanceCommitment, date: string, terms: CommitmentTerms, scope: 'one' | 'future'): FinanceCommitment {
  if (!commitmentDates(plan, date.slice(0, 7)).includes(date)) throw new Error('El vencimiento no pertenece al compromiso.');
  if (scope === 'one') return { ...plan, overrides: { ...plan.overrides, [date]: terms } };
  return { ...plan, revisions: [...plan.revisions.filter(r => r.from < date), { ...terms, from: date }],
    overrides: Object.fromEntries(Object.entries(plan.overrides).filter(([key]) => key < date)) };
}
