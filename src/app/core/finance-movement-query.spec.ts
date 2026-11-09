import { buildProfitAudit } from './profit-audit';
import { MovementQuery, queryMovements } from './finance-movement-query';

describe('Consulta de movimientos', () => {
  const rows = buildProfitAudit([], [
    { expense_id: 'a', category: 'sueldos', amount: 200, recipient: 'Ángela', account_id: 'bank', occurred_at: '2026-06-02' },
    { expense_id: 'b', category: 'paqueteria', amount: 100, occurred_at: null },
  ], [{ withdrawal_id: 'c', purpose: 'sueldo', amount: 300, occurred_at: '2026-06-01' }]).movements;
  const query: MovementQuery = { search: '', category: '', account: '', recipient: '', min: null, max: null, quick: 'all', sort: 'date', direction: 'desc' };
  it('combina beneficiario, cuenta, rango de importe y búsqueda sin acentos', () => {
    expect(queryMovements(rows, { ...query, search: 'angela', account: 'bank', min: 150, max: 250 }, {}).map(r => r.id)).toEqual(['a']);
    expect(queryMovements(rows, { ...query, recipient: 'Ángela', category: 'paqueteria' }, {})).toEqual([]);
  });
  it('incluye sueldos capturados como retiro sin cambiar su clasificación', () => {
    const result = queryMovements(rows, { ...query, quick: 'sueldos' }, {});
    expect(result.length).toBe(2); expect(result.find(r => r.id === 'c')?.kind).toBe('unclassified');
  });
  it('ordena números y fechas correctamente y deja sin fecha al final en ambas direcciones', () => {
    expect(queryMovements(rows, { ...query, sort: 'amount', direction: 'asc' }, {}).map(r => r.id)).toEqual(['b', 'a', 'c']);
    expect(queryMovements(rows, { ...query, direction: 'asc' }, {}).map(r => r.id)).toEqual(['c', 'a', 'b']);
    expect(queryMovements(rows, query, {}).map(r => r.id)).toEqual(['a', 'c', 'b']);
  });
});
