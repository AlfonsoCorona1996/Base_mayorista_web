import type { Meta, StoryObj } from '@storybook/angular';
import { buildProfitAudit } from '../../core/profit-audit';
import { ProfitAuditComponent } from './profit-audit.component';

const report = buildProfitAudit([
  { order_id: 'PEDIDO-0001', customer_id: '1', created_at: '2026-06-02', status: 'pagado', items: [{ title: 'Producto con nombre largo para comprobar su lectura completa y la trazabilidad del costo registrado', quantity: 100, price_clienta: 1500, price_cost: 700 }], totals: { paid_amount: 150000 } },
  { order_id: 'PEDIDO-0002', customer_id: '2', created_at: '2026-06-08', status: 'ready_for_route', items: [{ title: 'Producto con costo estimado', quantity: 40, price_clienta: 1500, price_public: 1500 }], totals: { paid_amount: 15000 } },
  { order_id: 'PEDIDO-0003', customer_id: '3', created_at: '2026-05-08', status: 'entregado', items: [{ title: 'Devolución parcial', quantity: 10, returned_qty: 2, price_clienta: 200, price_cost: 100 }], totals: { paid_amount: 800 } },
  { order_id: 'PEDIDO-SIN-DATOS', created_at: null, status: 'borrador', items: [], totals: { total_amount: 1000 } },
], [
  { expense_id: 'GASTO-1', category: 'viaticos', amount: 10000, occurred_at: '2026-06-10', notes: 'Gasolina y casetas del reparto de Villa Hidalgo' },
], [
  { withdrawal_id: 'RETIRO-1', purpose: 'socio_andrea_pepe', amount: 20000, occurred_at: '2026-06-16', notes: 'Transferencia a Andrea y Pepe', account_id: 'bank' },
  { withdrawal_id: 'RETIRO-2', purpose: 'otro', amount: 1500, occurred_at: '2026-05-12', notes: 'Destino histórico por confirmar' },
]);
const meta: Meta<ProfitAuditComponent> = {
  title: 'Administración/Utilidades y socios/Auditoría', component: ProfitAuditComponent,
  parameters: { layout: 'padded' },
  args: { report, customers: { '1': 'María de los Ángeles Hernández de la Torre — Nombre largo de prueba', '2': 'Clienta con pedido en proceso', '3': 'Clienta con devolución' }, accounts: { bank: 'Cuenta del negocio' }, context: 'Todas las rutas' },
};
export default meta;
type Story = StoryObj<ProfitAuditComponent>;
export const Historial: Story = {};
export const Vacio: Story = { args: { report: buildProfitAudit([], [], []) } };
export const Cargando: Story = { args: { busy: true } };
export const ErrorDeCarga: Story = { args: { error: 'No se pudieron cargar todos los pedidos.' } };
