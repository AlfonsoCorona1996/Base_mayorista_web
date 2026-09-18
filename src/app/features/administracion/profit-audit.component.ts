import { ChangeDetectionStrategy, Component, DestroyRef, ElementRef, computed, inject, input, output, signal, viewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { DomSanitizer, SafeResourceUrl } from '@angular/platform-browser';
import { AuditMovement, AuditPartner, ProfitAudit, auditPartners } from '../../core/profit-audit';
import { selectProfitReport } from '../../core/profit-report';

@Component({
  selector: 'app-profit-audit', standalone: true, imports: [FormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './profit-audit.component.html', styleUrl: './profit-audit.component.css',
})
export class ProfitAuditComponent {
  report = input.required<ProfitAudit>();
  busy = input(false);
  error = input<string | null>(null);
  context = input('Todas las rutas');
  business = input('Base Mayorista');
  customers = input<Record<string, string>>({});
  accounts = input<Record<string, string>>({});
  openOrder = output<string>();
  retry = output<void>();
  editMovement = output<{ source: 'expense' | 'withdrawal'; id: string }>();
  canEdit = input(false);
  month = signal('all');
  dateFrom = signal('');
  dateTo = signal('');
  includeProducts = signal(true);
  pdfBusy = signal(false);
  pdfError = signal<string | null>(null);
  pdfUrl = signal<string | null>(null);
  pdfPreview = signal<SafeResourceUrl | null>(null);
  pdfLabel = signal('');
  pdfFileName = signal('');
  pdfDialog = viewChild<ElementRef<HTMLDialogElement>>('pdfDialog');
  pdfTrigger = viewChild<ElementRef<HTMLButtonElement>>('pdfTrigger');
  private readonly sanitizer = inject(DomSanitizer);
  private readonly destroyRef = inject(DestroyRef);
  selection = computed(() => selectProfitReport(this.report(), { month: this.month(), from: this.dateFrom(), to: this.dateTo() }));
  partner = signal<AuditPartner | 'all'>('all');
  detail = signal<'orders' | 'movements' | 'quality'>('orders');
  search = signal('');
  page = signal(1);
  readonly pageSize = 20;
  detailHeading = viewChild<ElementRef<HTMLElement>>('detailHeading');
  partners = computed(() => auditPartners(this.report().totals));
  scopedOrders = computed(() => this.selection().orders);
  scopedMovements = computed(() => this.selection().movements.filter(r => this.partner() === 'all' || r.partner === this.partner()));
  totals = computed(() => this.selection().totals);
  periodPartners = computed(() => auditPartners(this.totals()));
  orders = computed(() => this.scopedOrders().filter(r =>
    (this.detail() !== 'quality' || (r.issues.length > 0 && !r.excluded)) &&
    `${r.id} ${this.customer(r.customerId)} ${r.status} ${r.issues.join(' ')}`.toLocaleLowerCase('es').includes(this.search().toLocaleLowerCase('es'))));
  movements = computed(() => this.scopedMovements().filter(r =>
    (this.detail() !== 'quality' || r.issues.length > 0) &&
    `${r.id} ${r.notes} ${this.movementLabel(r)} ${r.category}`.toLocaleLowerCase('es').includes(this.search().toLocaleLowerCase('es'))));
  pageCount = computed(() => Math.max(1, Math.ceil(Math.max(
    this.detail() === 'movements' ? 0 : this.orders().length,
    this.detail() === 'orders' ? 0 : this.movements().length,
  ) / this.pageSize)));
  currentPage = computed(() => Math.min(this.page(), this.pageCount()));
  visibleOrders = computed(() => this.orders().slice((this.currentPage() - 1) * this.pageSize, this.currentPage() * this.pageSize));
  visibleMovements = computed(() => this.movements().slice((this.currentPage() - 1) * this.pageSize, this.currentPage() * this.pageSize));
  constructor() {
    this.destroyRef.onDestroy(() => { const url = this.pdfUrl(); if (url) URL.revokeObjectURL(url); });
  }
  money(value: number): string { return new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN' }).format(value); }
  customer(id: string): string { return this.customers()[id] || id || 'Clienta sin identificar'; }
  account(id: string | null): string { return id ? this.accounts()[id] || id : 'Cuenta sin identificar'; }
  movementLabel(row: AuditMovement): string {
    if (row.partner) return row.partner === 'socio_blanca' ? 'Retiro · Blanca Trejo' : 'Retiro · Andrea y Pepe';
    return { expense: 'Gasto del negocio', capital: 'Compra de mercancía', withdrawal: 'Retiro', unclassified: 'Destino por clasificar' }[row.kind];
  }
  inspect(month = 'all', detail: 'orders' | 'movements' | 'quality' = 'orders', partner: AuditPartner | 'all' = 'all'): void {
    this.month.set(month); this.detail.set(detail); this.partner.set(partner); this.search.set(''); this.page.set(1);
    this.detailHeading()?.nativeElement.focus();
    this.detailHeading()?.nativeElement.scrollIntoView({ block: 'start', behavior: 'instant' });
  }
  movePage(direction: number): void {
    this.page.set(Math.max(1, Math.min(this.pageCount(), this.currentPage() + direction)));
    this.detailHeading()?.nativeElement.focus();
    this.detailHeading()?.nativeElement.scrollIntoView({ block: 'start', behavior: 'instant' });
  }
  async previewPdf(): Promise<void> {
    if (this.pdfBusy() || this.selection().error) return;
    this.pdfBusy.set(true); this.pdfError.set(null);
    // Capture one coherent report before loading the exporter asynchronously.
    const snapshot = { selection: this.selection(), history: this.report(), business: this.business(), context: this.context(),
      customers: this.customers(), accounts: this.accounts(), includeProducts: this.includeProducts(), generatedAt: new Date() };
    const filePeriod = this.month() === 'custom' ? `${this.dateFrom()}_${this.dateTo()}` : this.month();
    try {
      const { createProfitReportPdf } = await import('./profit-report-pdf');
      const bytes = await createProfitReportPdf(snapshot);
      if (this.destroyRef.destroyed) return;
      const oldUrl = this.pdfUrl();
      const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: 'application/pdf' }));
      this.pdfUrl.set(url);
      // Only a locally generated PDF Blob is trusted, never user-supplied URLs.
      this.pdfPreview.set(this.sanitizer.bypassSecurityTrustResourceUrl(url));
      this.pdfLabel.set(`${snapshot.business} · ${snapshot.context} · ${snapshot.selection.label}`);
      this.pdfFileName.set(`informe-socios-${snapshot.business.replace(/[^a-zA-Z0-9-]/g, '-')}-${filePeriod}.pdf`);
      if (oldUrl) URL.revokeObjectURL(oldUrl);
      this.pdfDialog()?.nativeElement.showModal();
    } catch {
      this.pdfError.set('No se pudo generar el PDF. Tus datos siguen disponibles; vuelve a intentarlo.');
    } finally { this.pdfBusy.set(false); }
  }
  downloadPdf(): void {
    const url = this.pdfUrl(); if (!url) return;
    const a = document.createElement('a'); a.href = url; a.download = this.pdfFileName(); a.click();
  }
  restorePdfFocus(): void { this.pdfTrigger()?.nativeElement.focus(); }
  exportCsv(): void {
    if (this.selection().error) return;
    const data: (string | number)[][] = [
      ['Tipo', 'ID', 'Fecha', 'Mes', 'Estado / categoría', 'Venta MXN', 'Costo MXN', 'Utilidad MXN', 'Cobrado MXN', 'Venta pendiente MXN', 'Utilidad cobrada MXN', 'Utilidad pendiente MXN', 'Movimiento MXN', 'Observaciones'],
      ...this.scopedOrders().map(r => ['Pedido', r.id, r.date || '', r.month, r.status, r.sale, r.cost, r.incomplete ? 'Sin determinar' : r.profit, r.collected, r.pending, r.incomplete ? 'Sin determinar' : r.collectedProfit, r.incomplete ? 'Sin determinar' : r.pendingProfit, '', r.issues.join(' | ')]),
      ...this.selection().movements.map(r => [this.movementLabel(r), r.id, r.date || '', r.month, r.category, '', '', '', '', '', '', '', r.amount, [r.notes, ...r.issues].join(' | ')]),
    ];
    const csv = data.map(row => row.map(value => {
      const text = typeof value === 'string' && /^[=+\-@\t\r]/.test(value) ? `'${value}` : String(value);
      return `"${text.replace(/"/g, '""')}"`;
    }).join(',')).join('\r\n');
    const url = URL.createObjectURL(new Blob(['\uFEFF', csv], { type: 'text/csv;charset=utf-8;' }));
    const a = document.createElement('a'); a.href = url; a.download = `auditoria-utilidades-${this.month() === 'custom' ? this.dateFrom() + '_' + this.dateTo() : this.month()}.csv`; a.click();
    URL.revokeObjectURL(url);
  }
}
