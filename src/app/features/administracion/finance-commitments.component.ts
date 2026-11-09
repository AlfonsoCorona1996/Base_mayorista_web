import { afterRenderEffect, ChangeDetectionStrategy, Component, computed, effect, ElementRef, inject, input, signal, untracked, viewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { FinanceAccount, FinanceExpense, FinanceExpenseCategory, FinanceService, EXPENSE_CATEGORY_ORDER, EXPENSE_CATEGORY_LABEL } from '../../core/finance.service';
import { FinanceCommitmentsService } from '../../core/finance-commitments.service';
import { calendarToday, CommitmentFrequency, CommitmentOccurrence, CommitmentTerms, commitmentOccurrences, FinanceCommitment, reviseCommitment, validMonth } from '../../core/finance-commitments';
import { BusinessId } from '../../core/rbac.constants';
import { auditDate } from '../../core/profit-audit';

@Component({
  selector: 'app-finance-commitments', standalone: true, imports: [FormsModule],
  templateUrl: './finance-commitments.component.html', styleUrls: ['./profit-audit.component.css', './finance-commitments.component.css'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class FinanceCommitmentsComponent {
  businessId = input.required<BusinessId>();
  routeId = input<string | null>(null);
  accounts = input<FinanceAccount[]>([]);
  expenses = input<FinanceExpense[]>([]);
  profits = input<Record<string, number>>({});
  canCreate = input(false);
  canEdit = input(false);
  private readonly service = inject(FinanceCommitmentsService);
  private readonly finance = inject(FinanceService);
  plans = signal<FinanceCommitment[]>([]);
  loading = signal(false);
  loadError = signal('');
  error = signal('');
  success = signal('');
  saving = signal(false);
  month = signal(calendarToday().slice(0, 7));
  status = signal('all');
  search = signal('');
  dialogMode = signal<'plan' | 'payment' | 'link' | null>(null);
  selected = signal<CommitmentOccurrence | null>(null);
  private revisionSnapshot: FinanceCommitment | null = null;
  private request = 0;
  private pendingId = '';
  private modal = viewChild<ElementRef<HTMLDialogElement>>('commitmentDialog');
  readonly today = calendarToday;
  readonly categoryOptions = EXPENSE_CATEGORY_ORDER.filter(c => c !== 'compra_inversion').map(id => ({ id, label: EXPENSE_CATEGORY_LABEL[id] }));
  title = '';
  recipient = '';
  category: FinanceExpenseCategory = 'sueldos';
  amount: number | null = null;
  estimated = false;
  start = calendarToday();
  end = '';
  frequency: CommitmentFrequency = 'monthly';
  editScope: 'one' | 'future' = 'one';
  cancelled = false;
  paymentDate = calendarToday();
  paymentAccount = '';
  paymentAmount: number | null = null;
  expenseId = '';
  allRows = computed(() => commitmentOccurrences(this.plans().filter(p => !this.routeId() || p.route_id === this.routeId()), this.month(), this.expenses()));
  rows = computed(() => this.allRows().filter(r => (this.status() === 'all' || (this.status() === 'overdue' ? r.overdue : r.status === this.status())) && `${r.title} ${r.recipient} ${this.categoryLabel(r.category)}`.toLocaleLowerCase('es').includes(this.search().trim().toLocaleLowerCase('es'))));
  totals = computed(() => this.allRows().reduce((sum, r) => ({ expected: sum.expected + (r.cancelled ? 0 : Math.round(r.amount * 100)), paid: sum.paid + Math.round(r.paid * 100), pending: sum.pending + Math.round(r.remaining * 100) }), { expected: 0, paid: 0, pending: 0 }));
  candidates = computed(() => {
    const row = this.selected();
    return row ? this.expenses().filter(e => e.business_id === row.business_id && e.route_id === row.route_id && e.category === row.category && !e.commitment_id) : [];
  });
  constructor() {
    effect(() => {
      const business = this.businessId(); this.routeId();
      untracked(() => { this.dialogMode.set(null); this.selected.set(null); this.success.set(''); void this.load(business); });
    });
    afterRenderEffect(onCleanup => {
      const dialog = this.modal()?.nativeElement;
      if (!dialog) return;
      const focus = document.activeElement;
      const overflow = document.body.style.overflow;
      document.body.style.overflow = 'hidden';
      dialog.showModal();
      onCleanup(() => { dialog.close(); document.body.style.overflow = overflow; if (focus instanceof HTMLElement && focus.isConnected) focus.focus(); });
    });
  }
  async load(business = this.businessId()): Promise<void> {
    const request = ++this.request;
    this.loading.set(true); this.loadError.set(''); this.plans.set([]);
    try { const rows = await this.service.load(business); if (request === this.request) this.plans.set(rows); }
    catch (error: unknown) { if (request === this.request) this.loadError.set(error instanceof Error ? error.message : 'No se pudieron cargar los compromisos.'); }
    finally { if (request === this.request) this.loading.set(false); }
  }
  money(amount: number): string { return new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN' }).format(amount); }
  date(value: string): string { return auditDate(value) ? new Intl.DateTimeFormat('es-MX', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${value}T12:00:00Z`)) : 'Sin fecha'; }
  categoryLabel(category: FinanceExpenseCategory): string { return EXPENSE_CATEGORY_LABEL[category]; }
  frequencyLabel(frequency: CommitmentFrequency): string { return { once: 'Una vez', monthly: 'Mensual', semimonthly: 'Quincenal · 15 y fin de mes' }[frequency]; }
  validMonth = validMonth;
  openPlan(row: CommitmentOccurrence | null = null): void {
    if (row ? !this.canEdit() : !this.canCreate()) return;
    this.selected.set(row);
    this.revisionSnapshot = row ? this.plans().find(p => p.commitment_id === row.commitment_id) || null : null;
    this.pendingId = row?.commitment_id || `commitment_${crypto.randomUUID()}`;
    this.title = row?.title || ''; this.recipient = row?.recipient || ''; this.category = row?.category || 'sueldos'; this.amount = row?.amount ?? null;
    this.estimated = row?.estimated || false; this.cancelled = row?.cancelled || false; this.editScope = 'one';
    this.start = validMonth(this.month()) ? `${this.month()}-01` : calendarToday(); this.end = ''; this.frequency = 'monthly';
    this.error.set(''); this.dialogMode.set('plan');
  }
  openPayment(row: CommitmentOccurrence, link = false): void {
    if (row.cancelled || (link ? !this.canEdit() : !this.canCreate())) return;
    this.pendingId = `exp_${crypto.randomUUID()}`; this.selected.set(row); this.paymentAmount = row.remaining; this.paymentDate = calendarToday(); this.paymentAccount = ''; this.expenseId = '';
    this.error.set(''); this.dialogMode.set(link ? 'link' : 'payment');
  }
  close(): void { if (!this.saving()) this.dialogMode.set(null); }
  async submit(): Promise<void> {
    if (this.saving()) return;
    const mode = this.dialogMode(); const row = this.selected(); const business = this.businessId();
    if (mode === 'plan' ? row ? !this.canEdit() : !this.canCreate() : mode === 'link' ? !this.canEdit() : !this.canCreate()) return;
    this.error.set(''); this.saving.set(true);
    try {
      if (mode === 'plan') {
        const terms: CommitmentTerms = { title: this.title.trim(), recipient: this.recipient.trim(), category: this.category, amount: Math.round(Number(this.amount) * 100) / 100, estimated: this.estimated, cancelled: this.cancelled };
        if (!this.categoryOptions.some(c => c.id === terms.category)) throw new Error('Selecciona una categoría válida.');
        const plan: FinanceCommitment = row && this.revisionSnapshot ? reviseCommitment(this.revisionSnapshot, row.due_date, terms, this.editScope) : {
          commitment_id: this.pendingId, business_id: business, route_id: this.routeId(), start_date: this.start, end_date: this.end || null, frequency: this.frequency, revisions: [{ ...terms, from: this.start }], overrides: {}, revision: 0,
        };
        await this.service.save(plan, !row);
        if (business === this.businessId()) { this.dialogMode.set(null); this.success.set('Compromiso guardado. Los pagos registrados conservan sus importes.'); await this.load(business); }
      } else if (mode === 'payment' && row) {
        const amount = Math.round(Number(this.paymentAmount) * 100) / 100;
        if (!Number.isFinite(amount) || amount <= 0 || !auditDate(this.paymentDate) || this.paymentDate > calendarToday()) throw new Error('Indica un importe mayor a cero y una fecha de pago válida, hasta hoy.');
        if (!this.accounts().some(a => a.account_id === this.paymentAccount && a.business_id === row.business_id)) throw new Error('Selecciona una cuenta de salida de este negocio.');
        await this.finance.saveExpense({ expense_id: this.pendingId, business_id: row.business_id, category: row.category, amount, occurred_at: this.paymentDate, account_id: this.paymentAccount, route_id: row.route_id, recipient: row.recipient, commitment_id: row.commitment_id, commitment_due_date: row.due_date, installment_index: null, installment_total: null, notes: row.title });
        if (business === this.businessId()) { this.dialogMode.set(null); this.success.set('Pago registrado y vinculado al compromiso.'); }
      } else if (mode === 'link' && row) {
        if (!this.candidates().some(e => e.expense_id === this.expenseId)) throw new Error('Selecciona un egreso disponible.');
        await this.finance.linkCommitmentExpense(this.expenseId, row.commitment_id, row.due_date, business);
        if (business === this.businessId()) { this.dialogMode.set(null); this.success.set('Egreso vinculado. No se creó otro pago.'); }
      }
    } catch (error: unknown) { if (business === this.businessId()) this.error.set(error instanceof Error ? error.message : 'No se pudo guardar. Revisa los datos e inténtalo otra vez.'); }
    finally { this.saving.set(false); }
  }
  async unlink(expense: FinanceExpense): Promise<void> {
    if (!this.canEdit() || this.saving()) return;
    this.saving.set(true); this.error.set('');
    try { await this.finance.linkCommitmentExpense(expense.expense_id, null, null, this.businessId()); this.success.set('Vínculo quitado. El egreso sigue registrado en movimientos.'); }
    catch (error: unknown) { this.error.set(error instanceof Error ? error.message : 'No se pudo quitar el vínculo.'); }
    finally { this.saving.set(false); }
  }
}
