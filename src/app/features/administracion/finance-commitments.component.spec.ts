import { TestBed } from '@angular/core/testing';
import { FinanceCommitmentsComponent } from './finance-commitments.component';
import { FinanceCommitmentsService } from '../../core/finance-commitments.service';
import { FinanceService } from '../../core/finance.service';
import { calendarToday, commitmentOccurrences, FinanceCommitment } from '../../core/finance-commitments';

describe('FinanceCommitmentsComponent', () => {
  const today = calendarToday();
  const plan: FinanceCommitment = { commitment_id: 'plan', business_id: 'bm', route_id: null, start_date: today, end_date: null, frequency: 'monthly', revision: 1, overrides: {}, revisions: [{ from: today, title: 'Sueldo', recipient: 'Ana', category: 'sueldos', amount: 100, estimated: false, cancelled: false }] };
  const row = commitmentOccurrences([plan], today.slice(0, 7), [])[0];
  async function setup(editable = true) {
    const plans = { load: jasmine.createSpy('load').and.resolveTo([plan]), save: jasmine.createSpy('save').and.resolveTo() };
    const finance = { saveExpense: jasmine.createSpy('saveExpense').and.resolveTo('payment'), linkCommitmentExpense: jasmine.createSpy('link').and.resolveTo() };
    await TestBed.configureTestingModule({ imports: [FinanceCommitmentsComponent], providers: [{ provide: FinanceCommitmentsService, useValue: plans }, { provide: FinanceService, useValue: finance }] }).compileComponents();
    const fixture = TestBed.createComponent(FinanceCommitmentsComponent);
    fixture.componentRef.setInput('businessId', 'bm'); fixture.componentRef.setInput('canCreate', editable); fixture.componentRef.setInput('canEdit', editable);
    fixture.componentRef.setInput('accounts', [{ account_id: 'bank', business_id: 'bm', name: 'Banco', balance: 1000, notes: null }]);
    fixture.detectChanges(); await fixture.whenStable(); fixture.detectChanges();
    return { fixture, component: fixture.componentInstance, plans, finance };
  }
  it('permite consulta sin exponer ni ejecutar acciones sin permiso', async () => {
    const { fixture, component, plans, finance } = await setup(false);
    expect((fixture.nativeElement as HTMLElement).textContent).toContain('Sueldo');
    expect((fixture.nativeElement as HTMLElement).textContent).not.toContain('Agregar compromiso');
    component.openPlan(); component.openPayment(row); expect(component.dialogMode()).toBeNull();
    expect(plans.save).not.toHaveBeenCalled(); expect(finance.saveExpense).not.toHaveBeenCalled();
  });
  it('precargar guarda el plan sin registrar un egreso', async () => {
    const { component, plans, finance } = await setup();
    component.openPlan(); component.title = 'Paquetería'; component.recipient = 'Proveedor'; component.category = 'paqueteria'; component.amount = 3000;
    await component.submit();
    const saved = plans.save.calls.mostRecent().args[0] as FinanceCommitment;
    expect(saved.business_id).toBe('bm'); expect(saved.revisions[0].amount).toBe(3000);
    expect(finance.saveExpense).not.toHaveBeenCalled(); expect(component.dialogMode()).toBeNull();
  });
  it('conserva el borrador y el identificador del pago al reintentar un fallo', async () => {
    const { component, finance } = await setup();
    component.openPayment(row); component.paymentAmount = 25; component.paymentAccount = 'bank';
    finance.saveExpense.and.rejectWith(new Error('Sin conexión'));
    await component.submit();
    const first = finance.saveExpense.calls.mostRecent().args[0];
    expect(component.error()).toBe('Sin conexión'); expect(component.paymentAmount).toBe(25); expect(component.dialogMode()).toBe('payment');
    finance.saveExpense.and.resolveTo('payment'); await component.submit();
    const second = finance.saveExpense.calls.mostRecent().args[0];
    expect(second.expense_id).toBe(first.expense_id); expect(second.commitment_due_date).toBe(today); expect(second.amount).toBe(25);
  });
  it('editar un vencimiento conserva el calendario y las condiciones de meses anteriores', async () => {
    const { component, plans } = await setup();
    component.openPlan(row); component.amount = 120; component.editScope = 'one'; await component.submit();
    const saved = plans.save.calls.mostRecent().args[0] as FinanceCommitment;
    expect(saved.start_date).toBe(plan.start_date); expect(saved.revisions[0].amount).toBe(100); expect(saved.overrides[today].amount).toBe(120);
  });
  it('muestra el error de carga y permite recuperar los compromisos al reintentar', async () => {
    const { fixture, component, plans } = await setup();
    plans.load.and.rejectWith(new Error('Error de lectura'));
    await component.load(); fixture.detectChanges();
    expect((fixture.nativeElement as HTMLElement).textContent).toContain('Error de lectura');
    expect(component.plans()).toEqual([]);
    plans.load.and.resolveTo([plan]); await component.load(); fixture.detectChanges();
    expect(component.loadError()).toBe(''); expect(component.rows().length).toBe(1);
  });
});
