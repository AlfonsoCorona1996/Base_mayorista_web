import { TestBed } from '@angular/core/testing';
import { buildProfitAudit } from '../../core/profit-audit';
import { ProfitAuditComponent } from './profit-audit.component';

describe('ProfitAuditComponent', () => {
  async function setup(count = 1) {
    await TestBed.configureTestingModule({ imports: [ProfitAuditComponent] }).compileComponents();
    const fixture = TestBed.createComponent(ProfitAuditComponent);
    fixture.componentRef.setInput('report', buildProfitAudit(Array.from({ length: count }, (_, i) => ({
      order_id: `PEDIDO-${i + 1}`, created_at: '2026-06-01', status: 'entregado',
      items: [{ quantity: 1, price_clienta: 100, price_cost: 50 }], totals: { paid_amount: 50 },
    })), [], [{ withdrawal_id: 'w', purpose: 'socio_andrea_pepe', amount: 10, occurred_at: '2026-06-02' }]));
    fixture.detectChanges();
    return fixture;
  }
  it('conserva el saldo generado, informa la cobranza aparte y filtra retiros por socio', async () => {
    const fixture = await setup();
    const component = fixture.componentInstance;
    expect(component.partners()[1].remaining).toBe(15);
    expect(component.partners()[1].pendingCollection).toBe(12.5);
    component.inspect('2026-06', 'movements', 'socio_andrea_pepe');
    fixture.detectChanges();
    expect(component.movements().length).toBe(1);
    component.inspect('2026-06', 'movements', 'socio_blanca');
    fixture.detectChanges();
    expect(component.movements().length).toBe(0);
    expect((fixture.nativeElement as HTMLElement).textContent).toContain('No hay movimientos');
  });
  it('pagina el detalle sin perder pedidos del reporte ni modificar los totales al buscar', async () => {
    const fixture = await setup(25);
    const component = fixture.componentInstance;
    expect(component.visibleOrders().length).toBe(20);
    component.movePage(1);
    expect(component.visibleOrders().length).toBe(5);
    component.search.set('PEDIDO-25');
    expect(component.orders().length).toBe(1);
    expect(component.currentPage()).toBe(1);
    expect(component.totals().sale).toBe(2500);
  });
  it('permite navegar al pedido original desde su desglose', async () => {
    const fixture = await setup();
    const emit = spyOn(fixture.componentInstance.openOrder, 'emit');
    const buttons = Array.from((fixture.nativeElement as HTMLElement).querySelectorAll('button'));
    buttons.find(button => button.textContent?.includes('Abrir pedido'))?.click();
    expect(emit).toHaveBeenCalledWith('PEDIDO-1');
  });
  it('mantiene el reporte completo al filtrar socio, búsqueda y página; bloquea fechas inválidas', async () => {
    const fixture = await setup(25);
    const component = fixture.componentInstance;
    component.inspect('custom', 'movements', 'socio_blanca');
    fixture.detectChanges();
    const pdf = Array.from((fixture.nativeElement as HTMLElement).querySelectorAll('button')).find(b => b.textContent?.includes('Ver y descargar PDF'))!;
    expect(pdf.disabled).toBeTrue();
    component.dateFrom.set('2026-06-01'); component.dateTo.set('2026-06-30');
    component.search.set('NO-EXISTE'); component.page.set(2);
    fixture.detectChanges();
    expect(pdf.disabled).toBeFalse();
    expect(component.movements().length).toBe(0);
    expect(component.selection().orders.length).toBe(25);
    expect(component.selection().movements.length).toBe(1);
    expect(component.totals().andreaPepeWithdrawn).toBe(10);
  });
  it('oculta importes incompletos durante carga o error y permite reintentar', async () => {
    const fixture = await setup();
    fixture.componentRef.setInput('busy', true); fixture.detectChanges();
    expect((fixture.nativeElement as HTMLElement).querySelector('.partners')).toBeNull();
    fixture.componentRef.setInput('busy', false);
    fixture.componentRef.setInput('error', 'Fallo de lectura'); fixture.detectChanges();
    const retry = spyOn(fixture.componentInstance.retry, 'emit');
    (fixture.nativeElement as HTMLElement).querySelector<HTMLButtonElement>('.notice button')?.click();
    expect(retry).toHaveBeenCalled();
    expect((fixture.nativeElement as HTMLElement).querySelector('.history-table')).toBeNull();
  });
});
