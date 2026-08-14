import { ComponentFixture, TestBed } from '@angular/core/testing';
import { PedidoDetallePackingStoryboardComponent } from './pedido-detalle-packing-storyboard.component';

describe('PedidoDetallePackingStoryboardComponent', () => {
  let component: PedidoDetallePackingStoryboardComponent;
  let fixture: ComponentFixture<PedidoDetallePackingStoryboardComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [PedidoDetallePackingStoryboardComponent],
    }).compileComponents();

    fixture = TestBed.createComponent(PedidoDetallePackingStoryboardComponent);
    component = fixture.componentInstance;
  });

  it('muestra los cuatro momentos en el storyboard', () => {
    fixture.componentRef.setInput('layoutMode', 'storyboard');
    fixture.detectChanges();

    expect(component.visibleFrames().map((frame) => frame.state)).toEqual([
      'locked',
      'ready',
      'opened',
      'packed',
    ]);
  });

  it('recorre bloqueo, disponibilidad, apertura y empaque completo en la demo interactiva', () => {
    fixture.componentRef.setInput('layoutMode', 'interactive');
    fixture.componentRef.setInput('initialState', 'locked');
    fixture.detectChanges();

    expect(component.currentState()).toBe('locked');
    component.enablePacking();
    expect(component.currentState()).toBe('ready');
    component.openPackages();
    expect(component.currentState()).toBe('opened');
    component.completePacking();
    expect(component.currentState()).toBe('packed');
    expect(component.liveMessage()).toContain('Empaque completo');
  });

  it('no abre Paquetes mientras está bloqueado', () => {
    fixture.componentRef.setInput('layoutMode', 'interactive');
    fixture.componentRef.setInput('initialState', 'locked');
    fixture.detectChanges();

    component.openPackages();

    expect(component.currentState()).toBe('locked');
    expect(component.liveMessage()).toContain('todavía no está disponible');
  });
});
