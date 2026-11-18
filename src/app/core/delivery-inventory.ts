/**
 * Reglas puras de entrega e inventario (FIX 03B-1).
 *
 * Una entrega solo puede descontar del inventario las piezas que se sabe que salieron.
 * Una caja ("paquete") con cantidades por artículo (`pkg.items[].qty`) es evidencia
 * suficiente. Una caja que solo lista `item_ids` sin cantidades lo es únicamente si el
 * artículo no aparece en ninguna otra caja: si se reparte entre varias, no se puede saber
 * cuántas piezas iban en cada una y la entrega por caja se bloquea (no se inventa).
 */

export interface DeliveryPackageLike {
  package_id: string;
  state?: string | null;
  item_ids?: string[] | null;
  items?: Array<{ orderItemId: string; qty: number }> | null;
}

export interface DeliveryItemLike {
  item_id: string;
  quantity?: number | null;
  confirmed_qty?: number | null;
  returned_qty?: number | null;
}

export type PackageDeliveryPlan =
  | { ok: true; qtyByItem: Map<string, number> }
  | { ok: false; reason: string; ambiguousItemIds: string[] };

function safeQty(value: unknown): number {
  const n = Number(value ?? 0);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.trunc(n));
}

// ---------------------------------------------------------------------------
// Ajuste de inventario pendiente de una entrega (FIX 03B-1.1)
// ---------------------------------------------------------------------------

/**
 * Estado duradero del ajuste de inventario de una entrega, guardado en `orders.inventory_sync`.
 *
 * - `pending`: la entrega (completa o por caja) se guardó y el inventario aún no se confirma.
 *   Se escribe en la MISMA escritura que la entrega: si la pestaña se cierra o la red cae
 *   después, el pedido queda marcado y se ve al volver, desde cualquier dispositivo.
 * - `failed`: un intento terminó con error (se guarda el último).
 * - `synced`: cada movimiento esperado se comprobó en el servidor (llave de idempotencia
 *   presente en su documento de inventario).
 * - `resolved_manual`: un administrador lo resolvió tras revisar (nota obligatoria).
 *
 * `pending` y `failed` bloquean el cierre definitivo del pedido.
 */
export type DeliveryInventorySyncStatus = "pending" | "failed" | "synced" | "resolved_manual";

export interface DeliveryInventorySyncState {
  status: DeliveryInventorySyncStatus;
  /** Qué se registró: entrega completa (`close`) o entrega por caja (`packages`). */
  scope: "close" | "packages";
  requested_at: string | null;
  attempts: number;
  last_attempt_at: string | null;
  last_error: string | null;
  last_error_code: string | null;
  synced_at: string | null;
  /** Movimientos comprobados en el servidor en el último intento correcto. */
  verified_keys: number;
  consumed: number;
  released: number;
  shortfall: number;
  resolved_by: string | null;
  resolution_note: string | null;
}

const SYNC_STATUSES: DeliveryInventorySyncStatus[] = ["pending", "failed", "synced", "resolved_manual"];

function textOrNull(value: unknown): string | null {
  const text = typeof value === "string" ? value.trim() : "";
  return text ? text : null;
}

export function normalizeDeliveryInventorySync(raw: unknown): DeliveryInventorySyncState | null {
  if (!raw || typeof raw !== "object") return null;
  const row = raw as Record<string, unknown>;
  const status = SYNC_STATUSES.includes(row["status"] as DeliveryInventorySyncStatus)
    ? row["status"] as DeliveryInventorySyncStatus
    : null;
  if (!status) return null;
  return {
    status,
    scope: row["scope"] === "packages" ? "packages" : "close",
    requested_at: textOrNull(row["requested_at"]),
    attempts: safeQty(row["attempts"]),
    last_attempt_at: textOrNull(row["last_attempt_at"]),
    last_error: textOrNull(row["last_error"]),
    last_error_code: textOrNull(row["last_error_code"]),
    synced_at: textOrNull(row["synced_at"]),
    verified_keys: safeQty(row["verified_keys"]),
    consumed: safeQty(row["consumed"]),
    released: safeQty(row["released"]),
    shortfall: safeQty(row["shortfall"]),
    resolved_by: textOrNull(row["resolved_by"]),
    resolution_note: textOrNull(row["resolution_note"]),
  };
}

/** El inventario de la entrega no está confirmado: se debe reintentar o resolver. */
export function deliveryInventoryOpen(order: { inventory_sync?: unknown } | null | undefined): boolean {
  const state = normalizeDeliveryInventorySync(order?.inventory_sync);
  return state?.status === "pending" || state?.status === "failed";
}

/** Estado que acompaña la escritura de la entrega. Conserva los intentos previos. */
export function pendingDeliveryInventorySync(
  scope: DeliveryInventorySyncState["scope"],
  nowIso: string,
  previous?: DeliveryInventorySyncState | null,
): DeliveryInventorySyncState {
  return {
    status: "pending",
    // Una entrega completa engloba las cajas previas: su ajuste las cubre.
    scope: previous?.scope === "close" || scope === "close" ? "close" : "packages",
    requested_at: nowIso,
    attempts: previous?.attempts || 0,
    last_attempt_at: previous?.last_attempt_at || null,
    last_error: previous?.status === "failed" ? previous.last_error : null,
    last_error_code: previous?.status === "failed" ? previous.last_error_code : null,
    synced_at: null,
    verified_keys: 0,
    consumed: 0,
    released: 0,
    shortfall: 0,
    resolved_by: null,
    resolution_note: null,
  };
}

/** Piezas de la línea que todavía pueden salir (confirmadas menos devueltas). */
export function deliverableQty(item: DeliveryItemLike): number {
  return Math.max(0, safeQty(item.confirmed_qty ?? item.quantity) - safeQty(item.returned_qty));
}

export function planPackageDelivery(
  packages: DeliveryPackageLike[],
  items: DeliveryItemLike[],
  packageId: string,
): PackageDeliveryPlan {
  const target = (packages || []).find((pkg) => pkg.package_id === packageId);
  if (!target) return { ok: false, reason: "La caja ya no existe en el pedido.", ambiguousItemIds: [] };
  const entries = Array.isArray(target.items) ? target.items : [];
  const qtyByItem = new Map<string, number>();
  for (const entry of entries) {
    const qty = safeQty(entry.qty);
    if (!entry.orderItemId || qty <= 0) continue;
    qtyByItem.set(entry.orderItemId, (qtyByItem.get(entry.orderItemId) || 0) + qty);
  }
  const itemsById = new Map((items || []).map((item) => [item.item_id, item]));
  const ambiguous: string[] = [];
  for (const itemId of target.item_ids || []) {
    if (qtyByItem.has(itemId)) continue;
    const elsewhere = (packages || []).some((pkg) =>
      pkg.package_id !== packageId
      && ((pkg.item_ids || []).includes(itemId) || (pkg.items || []).some((entry) => entry.orderItemId === itemId && safeQty(entry.qty) > 0)),
    );
    if (elsewhere) {
      ambiguous.push(itemId);
      continue;
    }
    const item = itemsById.get(itemId);
    if (item) qtyByItem.set(itemId, deliverableQty(item));
  }
  if (ambiguous.length > 0) {
    return {
      ok: false,
      reason: "Esta caja no registra cuántas piezas lleva de un artículo que también está en otra caja. Registra la entrega del pedido completo o vuelve a armar la caja con cantidades.",
      ambiguousItemIds: ambiguous,
    };
  }
  return { ok: true, qtyByItem };
}
