/**
 * Estado del listener de pedidos mantenido de forma incremental.
 *
 * Antes, cada snapshot con cambios convertía (`data()`) y normalizaba los N
 * pedidos. Aquí el primer snapshot construye el estado completo y los siguientes
 * procesan solo `docChanges()`. Los pedidos que no cambiaron conservan el mismo
 * objeto, así que los cachés por identidad y los `computed` de las pantallas
 * siguen siendo válidos.
 *
 * Fuente de verdad: el índice se alimenta solo de snapshots de Firestore. Las
 * actualizaciones optimistas de `OrdersService` viven en su signal `rows` y se
 * reemplazan con el siguiente snapshot, igual que antes.
 */

export interface OrdersSnapshotDoc {
  id: string;
  data(): Record<string, unknown>;
  /** Metadata de Firestore del documento. Opcional para fuentes simuladas. */
  metadata?: { hasPendingWrites: boolean };
}

export interface OrdersSnapshotChange {
  type: "added" | "modified" | "removed";
  doc: OrdersSnapshotDoc;
}

export interface OrdersSnapshotEvent {
  /** Todos los documentos del resultado. Solo se recorre al construir el estado completo. */
  docs(): OrdersSnapshotDoc[];
  /** Número de documentos del resultado (`snap.size`). */
  size: number;
  fromCache: boolean;
  hasPendingWrites: boolean;
  /**
   * Cambios de datos respecto al snapshot anterior del mismo listener
   * (`docChanges()`). Vacío si solo cambió la metadata.
   */
  changes: OrdersSnapshotChange[];
}

export interface OrdersApplyStats {
  mode: "full" | "incremental" | "resync";
  added: number;
  modified: number;
  removed: number;
  /** Documentos mantenidos tras aplicar el snapshot. */
  docs: number;
  convert_ms: number;
  normalize_ms: number;
  index_ms: number;
  sort_ms: number;
  pending_docs: number;
  updated_at_pending: number;
  updated_at_missing: number;
}

export type NormalizeOrderFn<T> = (id: string, data: Record<string, unknown>, fallbackIso: string) => T;

interface Sortable {
  order_id: string;
  updated_at: string;
}

/**
 * Orden de presentación: `updated_at` descendente y, a igualdad, `order_id`
 * descendente. Mismo criterio que el comparador histórico
 * `a.updated_at > b.updated_at ? -1 : 1` para fechas distintas; el desempate
 * vuelve el orden total y determinista (antes dependía del orden de entrada).
 */
export function compareOrdersForList(a: Sortable, b: Sortable): number {
  if (a.updated_at !== b.updated_at) return a.updated_at > b.updated_at ? -1 : 1;
  if (a.order_id === b.order_id) return 0;
  return a.order_id > b.order_id ? -1 : 1;
}

/** Con más cambios que esto se reordena todo en vez de insertar uno por uno. */
const MAX_BINARY_INSERTS = 32;

export class OrdersSnapshotIndex<T extends Sortable> {
  private readonly byId = new Map<string, T>();
  private ordered: T[] = [];

  /**
   * @param normalize Normalización de un documento. `fallbackIso` es el valor
   *   provisional para fechas ausentes o pendientes (ver `apply`).
   * @param now Reloj de alta resolución para medir etapas.
   * @param observedAtIso Momento en que la app observa el snapshot.
   */
  constructor(
    private readonly normalize: NormalizeOrderFn<T>,
    private readonly now: () => number,
    private readonly observedAtIso: () => string = () => new Date().toISOString(),
  ) {}

  get size(): number {
    return this.byId.size;
  }

  get(id: string): T | undefined {
    return this.byId.get(id);
  }

  /** Lista ordenada vigente. Solo cambia de instancia cuando cambian los datos. */
  rows(): T[] {
    return this.ordered;
  }

  /**
   * Aplica un snapshot y devuelve la lista ordenada resultante.
   *
   * - Primer snapshot (`initial`): estado completo desde `docs()`.
   * - Siguientes: solo `changes`. Un snapshot sin cambios de datos (metadata) no
   *   debe llegar aquí; si llega, devuelve la misma lista.
   * - Si tras aplicar los cambios el número de documentos no coincide con
   *   `size`, se reconstruye todo (`resync`). Firestore garantiza que
   *   `docChanges()` describe la diferencia con el snapshot anterior, así que
   *   no debería ocurrir; es una red de seguridad.
   *
   * Fechas provisionales: `normalize` recibe un único `fallbackIso` por
   * snapshot, el momento en que se observó. Un documento con `updated_at`
   * pendiente (`serverTimestamp()` sin confirmar) o ausente toma ese valor y lo
   * conserva mientras el documento no vuelva a cambiar.
   */
  apply(event: OrdersSnapshotEvent, initial: boolean): { rows: T[]; stats: OrdersApplyStats } {
    if (initial) return this.rebuild(event, "full");

    const stats = emptyStats("incremental");
    let fallbackIso: string | null = null;
    const fallback = () => (fallbackIso ??= this.observedAtIso());
    const touched = new Set<string>();
    const pending: Array<{ id: string; data: Record<string, unknown>; hasPendingWrites: boolean }> = [];

    const convertStartedAt = this.now();
    for (const change of event.changes) {
      touched.add(change.doc.id);
      if (change.type === "removed") {
        stats.removed += 1;
        continue;
      }
      if (change.type === "added") stats.added += 1;
      else stats.modified += 1;
      const hasPendingWrites = change.doc.metadata?.hasPendingWrites === true;
      if (hasPendingWrites) stats.pending_docs += 1;
      pending.push({ id: change.doc.id, data: change.doc.data(), hasPendingWrites });
    }
    const normalizeStartedAt = this.now();
    stats.convert_ms = normalizeStartedAt - convertStartedAt;

    const normalized = new Map<string, T>();
    for (const entry of pending) {
      countProvisionalUpdatedAt(stats, entry.data, entry.hasPendingWrites);
      normalized.set(entry.id, this.normalize(entry.id, entry.data, fallback()));
    }
    const indexStartedAt = this.now();
    stats.normalize_ms = indexStartedAt - normalizeStartedAt;

    for (const change of event.changes) {
      const next = normalized.get(change.doc.id);
      if (change.type === "removed" || !next) this.byId.delete(change.doc.id);
      else this.byId.set(change.doc.id, next);
    }
    const sortStartedAt = this.now();
    stats.index_ms = sortStartedAt - indexStartedAt;

    if (this.byId.size !== event.size) return this.rebuild(event, "resync");

    if (touched.size > 0) this.ordered = this.reorder(touched);
    stats.sort_ms = this.now() - sortStartedAt;
    stats.docs = this.byId.size;
    return { rows: this.ordered, stats };
  }

  private rebuild(event: OrdersSnapshotEvent, mode: "full" | "resync"): { rows: T[]; stats: OrdersApplyStats } {
    const stats = emptyStats(mode);
    const fallbackIso = this.observedAtIso();

    const convertStartedAt = this.now();
    const raw = event.docs().map((doc) => ({
      id: doc.id,
      data: doc.data(),
      hasPendingWrites: doc.metadata?.hasPendingWrites === true,
    }));
    const normalizeStartedAt = this.now();
    stats.convert_ms = normalizeStartedAt - convertStartedAt;

    const normalized = raw.map((entry) => {
      if (entry.hasPendingWrites) stats.pending_docs += 1;
      countProvisionalUpdatedAt(stats, entry.data, entry.hasPendingWrites);
      return this.normalize(entry.id, entry.data, fallbackIso);
    });
    const indexStartedAt = this.now();
    stats.normalize_ms = indexStartedAt - normalizeStartedAt;

    this.byId.clear();
    for (const order of normalized) this.byId.set(order.order_id, order);
    const sortStartedAt = this.now();
    stats.index_ms = sortStartedAt - indexStartedAt;

    this.ordered = [...this.byId.values()].sort(compareOrdersForList);
    stats.sort_ms = this.now() - sortStartedAt;
    stats.added = raw.length;
    stats.docs = this.byId.size;
    return { rows: this.ordered, stats };
  }

  /**
   * Quita de la lista ordenada los pedidos tocados y vuelve a insertar su versión
   * vigente. Con pocos cambios usa búsqueda binaria; con muchos, un orden completo.
   * El comparador es total, así que el resultado es idéntico a ordenar desde cero.
   */
  private reorder(touched: Set<string>): T[] {
    const next = this.ordered.filter((order) => !touched.has(order.order_id));
    const inserts: T[] = [];
    for (const id of touched) {
      const order = this.byId.get(id);
      if (order) inserts.push(order);
    }
    if (inserts.length > MAX_BINARY_INSERTS) {
      next.push(...inserts);
      return next.sort(compareOrdersForList);
    }
    for (const order of inserts) next.splice(insertionIndex(next, order), 0, order);
    return next;
  }
}

function insertionIndex<T extends Sortable>(sorted: T[], item: T): number {
  let low = 0;
  let high = sorted.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (compareOrdersForList(sorted[mid], item) < 0) low = mid + 1;
    else high = mid;
  }
  return low;
}

function countProvisionalUpdatedAt(stats: OrdersApplyStats, data: Record<string, unknown>, hasPendingWrites: boolean): void {
  if (data["updated_at"]) return;
  if (hasPendingWrites) stats.updated_at_pending += 1;
  else stats.updated_at_missing += 1;
}

function emptyStats(mode: OrdersApplyStats["mode"]): OrdersApplyStats {
  return {
    mode,
    added: 0,
    modified: 0,
    removed: 0,
    docs: 0,
    convert_ms: 0,
    normalize_ms: 0,
    index_ms: 0,
    sort_ms: 0,
    pending_docs: 0,
    updated_at_pending: 0,
    updated_at_missing: 0,
  };
}
