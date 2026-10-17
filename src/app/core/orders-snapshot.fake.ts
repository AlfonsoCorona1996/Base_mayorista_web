import { Unsubscribe } from "firebase/firestore";
import type { OrdersSnapshotSource } from "./orders.service";
import { OrdersSnapshotChange, OrdersSnapshotDoc, OrdersSnapshotEvent } from "./orders-snapshot-index";
import { BusinessId } from "./rbac.constants";

/**
 * Solo para pruebas: simula el listener de Firestore sobre `orders`.
 *
 * Cada `emit` recibe el resultado completo de la consulta y calcula
 * `docChanges()` respecto al snapshot anterior del mismo listener, como el SDK:
 * altas, bajas y documentos cuyo contenido cambió. Un snapshot con los mismos
 * datos solo cambia metadata y llega sin cambios. Cuenta las llamadas a
 * `data()` para demostrar qué documentos se convierten.
 */
export interface FakeOrderDoc {
  id: string;
  data: Record<string, unknown>;
  /** `metadata.hasPendingWrites` del documento: escritura local sin confirmar. */
  pending?: boolean;
}

interface StoredDoc {
  data: Record<string, unknown>;
  signature: string;
  pending: boolean;
}

export class FakeOrdersListener {
  unsubscribed = false;
  dataCalls = 0;
  readonly dataCallsById = new Map<string, number>();
  private state = new Map<string, StoredDoc>();

  constructor(
    readonly businessIds: BusinessId[],
    readonly next: (event: OrdersSnapshotEvent) => void,
    readonly error: (error: unknown) => void,
  ) {}

  /** Emite el resultado completo de la consulta y devuelve el evento entregado. */
  emit(docs: FakeOrderDoc[], options: { fromCache?: boolean } = {}): OrdersSnapshotEvent {
    const nextState = new Map<string, StoredDoc>();
    for (const doc of docs) {
      nextState.set(doc.id, { data: doc.data, signature: signature(doc.data), pending: doc.pending === true });
    }

    const changes: OrdersSnapshotChange[] = [];
    for (const [id, previous] of this.state) {
      if (!nextState.has(id)) changes.push({ type: "removed", doc: this.wrap(id, previous) });
    }
    for (const [id, current] of nextState) {
      const previous = this.state.get(id);
      if (!previous) changes.push({ type: "added", doc: this.wrap(id, current) });
      else if (previous.signature !== current.signature) changes.push({ type: "modified", doc: this.wrap(id, current) });
    }
    this.state = nextState;

    const ordered = [...nextState.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    const event: OrdersSnapshotEvent = {
      docs: () => ordered.map(([id, stored]) => this.wrap(id, stored)),
      size: ordered.length,
      fromCache: options.fromCache === true,
      hasPendingWrites: ordered.some(([, stored]) => stored.pending),
      changes,
    };
    this.next(event);
    return event;
  }

  resetDataCalls(): void {
    this.dataCalls = 0;
    this.dataCallsById.clear();
  }

  private wrap(id: string, stored: StoredDoc): OrdersSnapshotDoc {
    return {
      id,
      metadata: { hasPendingWrites: stored.pending },
      data: () => {
        this.dataCalls += 1;
        this.dataCallsById.set(id, (this.dataCallsById.get(id) ?? 0) + 1);
        // Como el SDK, cada llamada devuelve objetos nuevos.
        return copy(stored.data);
      },
    };
  }
}

export class FakeOrdersSource implements OrdersSnapshotSource {
  listeners: FakeOrdersListener[] = [];

  listen(
    businessIds: BusinessId[],
    next: (event: OrdersSnapshotEvent) => void,
    error: (error: unknown) => void,
  ): Unsubscribe {
    const listener = new FakeOrdersListener(businessIds, next, error);
    this.listeners.push(listener);
    return () => {
      listener.unsubscribed = true;
    };
  }

  get active(): FakeOrdersListener[] {
    return this.listeners.filter((listener) => !listener.unsubscribed);
  }
}

/** Valor con forma de `Timestamp` de Firestore (`toDate()`), para fechas resueltas por el servidor. */
export function fakeTimestamp(iso: string): { toDate(): Date; toMillis(): number } {
  const date = new Date(iso);
  return { toDate: () => new Date(date.getTime()), toMillis: () => date.getTime() };
}

function signature(value: unknown): string {
  return JSON.stringify(value, (_key, inner: unknown) => {
    if (inner && typeof inner === "object" && typeof (inner as { toDate?: unknown }).toDate === "function") {
      return { __timestamp: (inner as { toDate(): Date }).toDate().toISOString() };
    }
    return inner;
  });
}

function copy<T>(value: T): T {
  if (Array.isArray(value)) return value.map((entry) => copy(entry)) as T;
  if (value && typeof value === "object") {
    if (typeof (value as { toDate?: unknown }).toDate === "function") return value;
    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) result[key] = copy(entry);
    return result as T;
  }
  return value;
}
