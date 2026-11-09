import { AuditMovement } from './profit-audit';
import { EXPENSE_CATEGORY_LABEL, FinanceExpenseCategory } from './finance.service';

export type MovementSort = 'date' | 'amount' | 'category' | 'recipient';
export const normalizeSearch = (value: string): string => value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('es').trim();
export function movementCategory(category: string): string {
  return EXPENSE_CATEGORY_LABEL[category as FinanceExpenseCategory] || ({ sueldo: 'Sueldos y nómina (retiro por revisar)', socio_blanca: 'Retiro de socio', socio_andrea_pepe: 'Retiro de socio', persona: 'Entrega a persona', gasto: 'Gasto (retiro por revisar)', inversion: 'Inversión (retiro por revisar)', ahorro: 'Ahorro', otro: 'Otro destino' } as Record<string, string>)[category] || category;
}
export function movementRecipient(row: AuditMovement): string {
  return row.partner === 'socio_blanca' ? 'Blanca Trejo' : row.partner === 'socio_andrea_pepe' ? 'Andrea y Pepe' : row.recipient || 'Sin beneficiario registrado';
}
export interface MovementQuery {
  search: string; category: string; account: string; recipient: string; min: number | null; max: number | null;
  quick: string; sort: MovementSort; direction: 'asc' | 'desc';
}
export function queryMovements(rows: AuditMovement[], query: MovementQuery, accounts: Record<string, string>): AuditMovement[] {
  const term = normalizeSearch(query.search);
  return rows.filter(row =>
    (!query.category || row.category === query.category) &&
    (!query.account || (row.accountId || 'missing') === query.account) &&
    (!query.recipient || movementRecipient(row) === query.recipient) &&
    (query.min === null || row.amount >= query.min) && (query.max === null || row.amount <= query.max) &&
    (query.quick === 'all' || (query.quick === 'sueldos' && ['sueldos', 'sueldo'].includes(row.category)) ||
      (query.quick === 'paqueteria' && row.category === 'paqueteria') || (query.quick === 'partners' && !!row.partner) ||
      (query.quick === 'review' && row.issues.length > 0)) &&
    normalizeSearch(`${row.id} ${row.notes} ${movementCategory(row.category)} ${movementRecipient(row)} ${row.accountId ? accounts[row.accountId] || row.accountId : ''}`).includes(term)
  ).sort((a, b) => {
    // Missing dates always follow dated records, in either direction.
    if (query.sort === 'date' && (!a.date || !b.date)) return a.date ? -1 : b.date ? 1 : a.id.localeCompare(b.id);
    const comparison = query.sort === 'amount' ? a.amount - b.amount :
      (query.sort === 'date' ? a.date || '' : query.sort === 'category' ? movementCategory(a.category) : movementRecipient(a))
        .localeCompare(query.sort === 'date' ? b.date || '' : query.sort === 'category' ? movementCategory(b.category) : movementRecipient(b), 'es', { numeric: true });
    return comparison * (query.direction === 'asc' ? 1 : -1) || `${a.source}${a.id}`.localeCompare(`${b.source}${b.id}`);
  });
}
