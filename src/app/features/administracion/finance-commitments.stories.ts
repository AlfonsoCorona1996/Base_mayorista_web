import { Component, computed, inject, Injectable, signal } from '@angular/core';
import { applicationConfig, Meta, StoryObj } from '@storybook/angular';
import { FinanceCommitmentsComponent } from './finance-commitments.component';
import { ProfitAuditComponent } from './profit-audit.component';
import { FinanceCommitmentsService } from '../../core/finance-commitments.service';
import { FinanceExpense, FinanceService, SaveFinanceExpenseInput } from '../../core/finance.service';
import { calendarToday, FinanceCommitment } from '../../core/finance-commitments';
import { buildProfitAudit } from '../../core/profit-audit';

const month = calendarToday().slice(0, 7);
@Injectable()
class DemoCommitments {
  rows: FinanceCommitment[] = [
    { commitment_id: 'salary', business_id: 'bm', route_id: null, start_date: `${month}-01`, end_date: null, frequency: 'semimonthly', revision: 1, overrides: {}, revisions: [{ from: `${month}-01`, title: 'Sueldo de operación y atención a clientas', recipient: 'María de los Ángeles Hernández de la Torre', category: 'sueldos', amount: 6000, estimated: false, cancelled: false }] },
    { commitment_id: 'shipping', business_id: 'bm', route_id: null, start_date: `${month}-01`, end_date: null, frequency: 'monthly', revision: 1, overrides: {}, revisions: [{ from: `${month}-01`, title: 'Paquetería mensual acordada', recipient: 'Proveedor de paquetería y entregas regionales', category: 'paqueteria', amount: 3000, estimated: false, cancelled: false }] },
  ];
  async load(): Promise<FinanceCommitment[]> { return structuredClone(this.rows); }
  async save(plan: FinanceCommitment): Promise<void> { this.rows = [...this.rows.filter(p => p.commitment_id !== plan.commitment_id), { ...structuredClone(plan), revision: plan.revision + 1 }]; }
}
@Injectable()
class DemoFinance {
  expenses = signal<FinanceExpense[]>([
    { expense_id: 'paid-salary', business_id: 'bm', route_id: null, category: 'sueldos', amount: 2000, occurred_at: `${month}-01`, account_id: 'bank', recipient: 'María de los Ángeles Hernández de la Torre', notes: 'Anticipo de primera quincena', installment_index: null, installment_total: null, commitment_id: 'salary', commitment_due_date: `${month}-15` },
    { expense_id: 'unlinked', business_id: 'bm', route_id: null, category: 'paqueteria', amount: 1000, occurred_at: `${month}-01`, account_id: 'bank', recipient: 'Proveedor de paquetería y entregas regionales', notes: 'Anticipo de envíos', installment_index: null, installment_total: null },
  ]);
  async saveExpense(input: SaveFinanceExpenseInput): Promise<string> {
    const id = input.expense_id || 'demo-payment';
    this.expenses.update(rows => [...rows.filter(r => r.expense_id !== id), { ...input, expense_id: id, business_id: input.business_id || 'bm' }]); return id;
  }
  async linkCommitmentExpense(id: string, commitment_id: string | null, commitment_due_date: string | null): Promise<void> {
    this.expenses.update(rows => rows.map(r => r.expense_id === id ? { ...r, commitment_id, commitment_due_date } : r));
  }
}
@Component({
  standalone: true, imports: [ProfitAuditComponent, FinanceCommitmentsComponent],
  template: `<app-profit-audit [report]="report()" [accounts]="accountNames" [canEdit]="true"><app-finance-commitments commitments businessId="bm" [accounts]="accounts" [expenses]="expenses()" [profits]="profits()" [canCreate]="true" [canEdit]="true" /></app-profit-audit>`,
})
class CommitmentsWorkspaceDemo {
  private finance = inject(FinanceService);
  expenses = this.finance.expenses;
  accountNames = { bank: 'Banco principal' };
  accounts = [{ account_id: 'bank', business_id: 'bm' as const, name: 'Banco principal', balance: 50000, notes: null }];
  report = computed(() => buildProfitAudit([{ order_id: 'PEDIDO-DEMO', created_at: `${month}-01`, status: 'entregado', items: [{ quantity: 10, price_clienta: 10000, price_cost: 4000 }], totals: { paid_amount: 75000 } }], this.expenses(), [
    { withdrawal_id: 'partner', purpose: 'socio_blanca', amount: 5000, occurred_at: `${month}-02`, account_id: 'bank', notes: 'Transferencia de utilidades' },
    { withdrawal_id: 'legacy', purpose: 'sueldo', amount: 1500, occurred_at: null, recipient: 'Personal de almacén', notes: 'Sueldo histórico con fecha pendiente de confirmar' },
  ]));
  profits = computed(() => Object.fromEntries(this.report().months.map(m => [m.id, m.netProfit])));
}
const meta: Meta<CommitmentsWorkspaceDemo> = {
  title: 'Administración/Utilidades y socios/Compromisos', component: CommitmentsWorkspaceDemo,
  decorators: [applicationConfig({ providers: [{ provide: FinanceCommitmentsService, useClass: DemoCommitments }, { provide: FinanceService, useClass: DemoFinance }] })],
  parameters: { layout: 'padded', docs: { description: { component: 'Datos ficticios y persistencia en memoria. No consulta ni modifica Firebase.' } } },
};
export default meta;
type Story = StoryObj<CommitmentsWorkspaceDemo>;
export const ConsultaYPlaneacion: Story = {};
