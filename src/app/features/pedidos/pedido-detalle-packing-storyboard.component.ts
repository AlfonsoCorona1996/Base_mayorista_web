import { ChangeDetectionStrategy, Component, computed, effect, input, signal } from '@angular/core';

export type PackingAvailabilityState = 'locked' | 'ready' | 'opened' | 'packed';
export type PackingStoryboardLayout = 'storyboard' | 'interactive';

interface PackingStoryFrame {
  state: PackingAvailabilityState;
  step: string;
  title: string;
  description: string;
  receivedCount: number;
}

const STORYBOARD_FRAMES: readonly PackingStoryFrame[] = [
  {
    state: 'locked',
    step: '1',
    title: 'Sin productos disponibles',
    description: 'Paquetes permanece bloqueado hasta que exista al menos un producto empacable.',
    receivedCount: 0,
  },
  {
    state: 'ready',
    step: '2',
    title: 'Se habilita con el primero',
    description:
      'El badge Pendiente y un pulso periódico anuncian que ya puede comenzar el empaque parcial.',
    receivedCount: 1,
  },
  {
    state: 'opened',
    step: '3',
    title: 'Empaque en curso',
    description:
      'Pendiente permanece visible, pero el pulso se pausa mientras el usuario trabaja en Paquetes.',
    receivedCount: 1,
  },
  {
    state: 'packed',
    step: '4',
    title: 'Empaque completo',
    description: 'Al empacar todo y cerrar las cajas desaparecen el badge y el efecto de atención.',
    receivedCount: 3,
  },
];

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  standalone: true,
  selector: 'app-pedido-detalle-packing-storyboard',
  templateUrl: './pedido-detalle-packing-storyboard.component.html',
  styleUrl: './pedido-detalle-packing-storyboard.component.css',
})
export class PedidoDetallePackingStoryboardComponent {
  readonly layoutMode = input<PackingStoryboardLayout>('storyboard');
  readonly initialState = input<PackingAvailabilityState>('locked');

  readonly currentState = signal<PackingAvailabilityState>('locked');
  readonly liveMessage = signal('Paquetes todavía no está disponible.');
  readonly products = [
    { name: 'Sandalia plataforma', detail: 'Talla 24 · Rosa', qty: 12 },
    { name: 'Tenis casual', detail: 'Talla 25 · Blanco', qty: 8 },
    { name: 'Bolsa crossbody', detail: 'Negro', qty: 5 },
  ] as const;

  readonly visibleFrames = computed<readonly PackingStoryFrame[]>(() => {
    if (this.layoutMode() === 'storyboard') return STORYBOARD_FRAMES;
    const state = this.currentState();
    const frame =
      STORYBOARD_FRAMES.find((candidate) => candidate.state === state) || STORYBOARD_FRAMES[0];
    return [{ ...frame, step: 'Demo' }];
  });

  constructor() {
    effect(() => {
      const state = this.initialState();
      this.currentState.set(state);
      this.liveMessage.set(this.messageForState(state));
    });
  }

  enablePacking(): void {
    this.currentState.set('ready');
    this.liveMessage.set('Hay un producto recibido. Paquetes está disponible y pendiente.');
  }

  openPackages(): void {
    if (this.currentState() === 'locked') return;
    this.currentState.set('opened');
    this.liveMessage.set('Sección Paquetes abierta. El empaque continúa pendiente.');
  }

  completePacking(): void {
    if (this.currentState() !== 'opened') return;
    this.currentState.set('packed');
    this.liveMessage.set('Empaque completo. La llamada de atención fue retirada.');
  }

  resetDemo(): void {
    this.currentState.set('locked');
    this.liveMessage.set('Demo reiniciada. Paquetes todavía no está disponible.');
  }

  private messageForState(state: PackingAvailabilityState): string {
    if (state === 'ready') return 'Hay un producto recibido. Paquetes está disponible y pendiente.';
    if (state === 'opened') return 'Sección Paquetes abierta. El empaque continúa pendiente.';
    if (state === 'packed') return 'Empaque completo. La llamada de atención fue retirada.';
    return 'Paquetes todavía no está disponible.';
  }
}
