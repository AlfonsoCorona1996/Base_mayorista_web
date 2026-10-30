import { Injectable, InjectionToken, computed, inject, signal } from "@angular/core";
import { FIRESTORE } from "./firebase.providers";
import {
  arrayUnion,
  collection,
  deleteDoc,
  doc,
  getDocs,
  limit,
  onSnapshot,
  orderBy,
  query,
  runTransaction,
  serverTimestamp,
  setDoc,
  startAfter,
  Unsubscribe,
  updateDoc,
  where,
} from "firebase/firestore";
import { getDownloadURL, ref, uploadBytes } from "firebase/storage";
import { FIREBASE_AUTH, STORAGE } from "./firebase.providers";
import { SupplierOperationsService } from "./supplier-operations.service";
import { ulid } from "ulid";
import { BusinessScopeService } from "./business-scope.service";
import { BusinessId, normalizeBusinessId } from "./rbac.constants";
import { calculateOrderFinancials, toPersistedOrderTotals } from "./order-financials";
import { InventoryService } from "./inventory.service";
import { lastValueFrom } from "rxjs";
import { ApiError, UserAdminApiService } from "../services/user-admin-api.service";
import {
  buildOrderItemMutationRequest,
  buildOrderItemPatchRequest,
  buildOrderItemsUpdateRequest,
  mergeAuthoritativeOrderItems,
} from "./order-items-api";
import {
  isSupplierReceiptComplete,
  supplierOperationReservedForOrderId,
} from "./supplier-operation-state";
import { financePeriodDocumentId, ledgerEntryPayload, monthIdFromDateInput } from "./finance-ledger";
import { LONG_TASK_MS, OrdersSnapshotInference, PerfMetricsService, firebaseErrorCode, roundMs } from "./perf-metrics.service";
import { OrdersSnapshotEvent, OrdersSnapshotIndex } from "./orders-snapshot-index";
import { normalizeOrderCreator, OrderCreator } from "./order-creator";
import { canCloseBySettlement, statusAfterCollection, statusAfterDelivery } from "./order-closure";

export type { OrdersSnapshotChange, OrdersSnapshotDoc, OrdersSnapshotEvent } from "./orders-snapshot-index";

/**
 * Sincronización del listener de pedidos:
 * - loading: aún no llega ningún snapshot.
 * - cache: datos locales de IndexedDB; el servidor todavía no los confirmó.
 * - server: snapshot confirmado por el servidor.
 * - error: el listener se cerró con error; los datos previos se conservan.
 */
export type OrdersSyncState = "idle" | "loading" | "cache" | "server" | "error";

/** Listener de pedidos aislado en un token para poder simularlo en pruebas. */
export interface OrdersSnapshotSource {
  listen(
    businessIds: BusinessId[],
    next: (event: OrdersSnapshotEvent) => void,
    error: (error: unknown) => void,
  ): Unsubscribe;
}

export const ORDERS_SNAPSHOT_SOURCE = new InjectionToken<OrdersSnapshotSource>("ORDERS_SNAPSHOT_SOURCE", {
  providedIn: "root",
  factory: () => ({
    listen: (businessIds, next, error) =>
      onSnapshot(
        query(collection(FIRESTORE, "orders"), where("business_id", "in", businessIds)),
        // Sin metadata Firestore no avisa cuando un snapshot de caché queda
        // confirmado por el servidor sin cambios de datos.
        { includeMetadataChanges: true },
        (snap) =>
          next({
            // `snap.docs` crea un envoltorio por documento: solo se pide al construir el estado completo.
            docs: () => snap.docs,
            size: snap.size,
            fromCache: snap.metadata.fromCache,
            hasPendingWrites: snap.metadata.hasPendingWrites,
            // Sin opciones excluye los cambios que solo afectan a metadata.
            changes: snap.docChanges(),
          }),
        error,
      ),
  }),
});

/**
 * Estados del pedido. Vocabulario cerrado a proposito: antes terminaba en
 * `(string & {})`, que hacia que TypeScript aceptara cualquier texto y no
 * avisara de un estado mal escrito.
 *
 * Cuatro conceptos tenian dos nombres vivos al mismo tiempo, uno en español y
 * otro en ingles. Se conserva el español y `normalizeOrderStatus` traduce el
 * ingles al leer, para documentos que la migracion todavia no toca:
 *
 *   delivered          -> entregado
 *   delivered_partial  -> entregado_parcial
 *   in_transit         -> en_ruta
 *   packing            -> empaque
 *   inbound_in_transit -> en_transito
 *
 * Los estados que solo existian en ingles (`supplier_processing`, `closed`,
 * `ready_for_route`, `assigned_to_run`) no tenian duplicado y se quedan como
 * estan: renombrarlos seria churn sin ganar correccion.
 */
export type OrderStatus =
  | "borrador"
  | "confirmando_proveedor"
  | "reservado_inventario"
  | "solicitado_proveedor"
  | "supplier_processing"
  | "en_transito"
  | "recibido_qa"
  | "empaque"
  | "ready_for_route"
  | "assigned_to_run"
  | "en_ruta"
  | "entregado"
  | "entregado_parcial"
  | "closed"
  | "pago_pendiente"
  | "pagado_parcial"
  | "pagado"
  | "cancelado"
  | "devuelto";

export const ORDER_STATUSES: readonly OrderStatus[] = [
  "borrador",
  "confirmando_proveedor",
  "reservado_inventario",
  "solicitado_proveedor",
  "supplier_processing",
  "en_transito",
  "recibido_qa",
  "empaque",
  "ready_for_route",
  "assigned_to_run",
  "en_ruta",
  "entregado",
  "entregado_parcial",
  "closed",
  "pago_pendiente",
  "pagado_parcial",
  "pagado",
  "cancelado",
  "devuelto",
] as const;

/** Nombre viejo -> nombre canonico. Solo los cuatro conceptos duplicados. */
export const LEGACY_ORDER_STATUS_ALIASES: Readonly<Record<string, OrderStatus>> = {
  delivered: "entregado",
  delivered_partial: "entregado_parcial",
  in_transit: "en_ruta",
  packing: "empaque",
  inbound_in_transit: "en_transito",
};

/**
 * Unico lugar donde se interpreta el estado guardado de un pedido. Un valor
 * desconocido cae en `borrador` en vez de propagarse: es el estado sin
 * consecuencias, y asi un dato corrupto no simula una entrega ni un cobro.
 */
export function normalizeOrderStatus(value: unknown): OrderStatus {
  const raw = String(value ?? "").trim();
  if ((ORDER_STATUSES as readonly string[]).includes(raw)) return raw as OrderStatus;
  return LEGACY_ORDER_STATUS_ALIASES[raw] ?? "borrador";
}

export type OrderItemState = OrderStatus | "sin_estado";
export type CollectionStatus = "none" | "pending" | "paid" | "remind_later";
export type OrderFulfillmentStatus = "pending" | "packing_gdl" | "packed_gdl" | "packing_durango" | "packed_durango";
export type OrderDeliveryStatus = "pending" | "delivered" | "not_delivered" | "incident";
export type OrderCustomerPaymentStatus = "pending" | "partial" | "collected";
export type OrderSettlementStatus = "not_applicable" | "pending" | "sent_to_gdl" | "received" | "reconciled" | "difference";
export type OrderHolderLocation = "gdl" | "in_transit" | "durango" | "delivery_staff" | "customer" | "other";
export type CollectionMethod = "efectivo" | "transferencia" | "tarjeta" | "otro";
export type OrderCollectionVerificationStatus = "reported" | "confirmed" | "rejected" | "difference";

export interface OrderItem {
  item_id: string;
  business_id?: BusinessId;
  source_business_id?: BusinessId | null;
  title: string;
  variant?: string | null;
  color?: string | null;
  quantity: number;
  returned_qty?: number | null;
  returned_restockable_qty?: number | null;
  returned_damaged_qty?: number | null;
  confirmed_qty?: number | null;
  source: "catalogo" | "inventario" | "manual";
  product_ref_type?: "normalized_listing" | "catalog_product" | "inventory_item" | "manual" | null;
  state: OrderItemState;
  confirmation_state?: "confirmed" | "out_of_stock" | "substitute" | "pending";
  supplier_id?: string | null;
  product_id?: string | null;
  variant_id?: string | null;
  sku?: string | null;
  price_clienta?: number | null;
  price_public?: number | null;
  price_cost?: number | null;
  /** Intención explícita de editar el costo; el backend la consume sin persistirla. */
  price_cost_override?: boolean;
  price_cost_override_from?: number | null;
  price_cost_override_to?: number | null;
  price_cost_override_by?: string | null;
  price_cost_override_at?: string | null;
  price_source_import_id?: string | null;
  price_source_imported_at?: unknown;
  price_warning_ack_at?: string | null;
  price_warning_reason?: string | null;
  price_selected_tier?: "clienta" | "final" | "manual" | null;
  price_override_reason?: string | null;
  price_override_by?: string | null;
  price_override_at?: string | null;
  price_override_from?: number | null;
  price_override_to?: number | null;
  price_override_below_cost?: boolean | null;
  discount_pct?: number | null;
  inventory_id?: string | null;
  image_url?: string | null;
  catalog_option_status?: "official" | "pending_review" | null;
  catalog_option_base_product_id?: string | null;
  catalog_option_image_source?: "catalog" | "upload" | null;
  catalog_option_requested_at?: string | null;
  catalog_option_requested_by?: { uid: string; name: string } | null;
  late_addition?: boolean;
  late_addition_note?: string | null;
  late_addition_status?: "pending" | "arrived" | "missing" | "damaged" | null;
  late_addition_added_at?: string | null;
  late_addition_added_in_status?: OrderStatus | null;
  late_addition_added_by?: string | null;
}

export type PackageState = "open" | "closed" | "en_ruta" | "entregado" | "devuelto";

/** Valores viejos que todavia pueden venir en Firestore. */
interface LegacyPackageFields {
  state?: string;
  status?: "open" | "closed";
}

/**
 * Traduce una caja guardada al vocabulario unico de `state`. `armado` era
 * sinonimo de `closed`, y `status` un subconjunto redundante que solo distinguia
 * abierta de cerrada. Cuando falta `state`, manda `status`.
 */
export function normalizePackage(raw: PackageRecord & LegacyPackageFields): PackageRecord {
  const legacyState = String(raw?.state || "").trim();
  const known: PackageState[] = ["open", "closed", "en_ruta", "entregado", "devuelto"];

  let state: PackageState;
  if (legacyState === "armado") state = "closed";
  else if ((known as string[]).includes(legacyState)) state = legacyState as PackageState;
  else state = raw?.status === "closed" ? "closed" : "open";

  const { status: _legacyStatus, ...rest } = raw as PackageRecord & { status?: unknown };
  return { ...rest, state } as PackageRecord;
}

export interface PackageRecord {
  package_id: string;
  label: string;
  sequence: number;
  total_packages: number;
  /**
   * Ciclo de vida de la caja, en orden: se arma abierta, se cierra al terminar
   * de empacarla, sale a ruta y termina entregada o devuelta.
   *
   * Es el unico campo de estado de la caja. Antes convivia con `status`
   * (open/closed), que era un subconjunto redundante, y con el valor `armado`,
   * sinonimo de `closed`. `normalizePackage` traduce ambos.
   */
  state: PackageState;
  amount_due: number | null;
  item_ids: string[];
  items?: Array<{
    orderItemId: string;
    name: string;
    qty: number;
    variant?: string | null;
    size?: string | null;
    color?: string | null;
    imageUrl?: string | null;
  }>;
  closed_at?: string | null;
  label_qr?: string | null;
  created_at: string;
}

export interface TimelineEntry {
  id: string;
  label: string;
  created_at: string;
  actor?: string;
}

export interface OrderPackingInfo {
  status: "in_progress" | "done";
  packages_count: number;
  completed_at?: string | null;
}

export interface OrderDispatchRequest {
  status: "none" | "requested" | "accepted" | "rejected";
  requested_at?: string | null;
  requested_by?: { uid: string; name: string } | null;
  note?: string | null;
}

export interface OrderTotals {
  total_amount: number;
  paid_amount: number;
  balance_due: number;
  discount_amount?: number;
  shipping_fee?: number;
  gross_amount?: number;
  returns_amount?: number;
  net_amount?: number;
  cost_amount?: number;
  gross_profit?: number;
  overpayment_amount?: number;
}

interface OrderItemsMutationResponse {
  ok: true;
  order: {
    order_id: string;
    items: OrderItem[];
    totals: OrderTotals;
    updated_at: string;
  };
}

export interface Order {
  created_by?: OrderCreator | null;
  order_id: string;
  business_id: BusinessId;
  customer_id: string;
  route_id: string | null;
  status: OrderStatus;
  planned_packages?: number | null;
  open_incidents_count?: number;
  has_high_incident?: boolean;
  last_incident_at?: string | null;
  last_event_at?: string | null;
  created_at: string;
  /** Original creation date for audit; null means the source did not provide it. */
  audit_created_at?: string | null;
  updated_at: string;
  items: OrderItem[];
  packages: PackageRecord[];
  timeline: TimelineEntry[];
  notes?: string;
  packing: OrderPackingInfo;
  dispatch_request: OrderDispatchRequest;
  route_run_id?: string | null;
  route_stop_id?: string | null;
  shipment_id?: string | null;
  fulfillment_status?: OrderFulfillmentStatus;
  delivery_status?: OrderDeliveryStatus;
  customer_payment_status?: OrderCustomerPaymentStatus;
  settlement_status?: OrderSettlementStatus;
  current_holder_location?: OrderHolderLocation;
  current_holder_user_id?: string | null;
  current_holder_name?: string | null;
  has_returns?: boolean;
  delivered_at?: string | null;
  paid_at?: string | null;
  paid_at_quality?: 'estimated' | null;
  closed_at?: string | null;
  collection_status?: CollectionStatus;
  collection_reminder_at?: string | null;
  collection_note?: string | null;
  sales_note_last_generated_at?: string | null;
  totals: OrderTotals;
}

export type IncidentSeverity = "low" | "medium" | "high";
export type IncidentStatus = "open" | "resolved";

export interface Incident {
  id: string;
  orderId: string;
  packageId?: string | null;
  itemId?: string | null;
  type: string;
  severity: IncidentSeverity;
  status: IncidentStatus;
  title: string;
  reason: string;
  assigneeId?: string | null;
  evidenceUrls?: string[];
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  resolvedBy?: string | null;
  resolvedAt?: string | null;
  resolutionNote?: string | null;
}

export interface OrderEvent {
  id: string;
  orderId: string;
  type: string;
  message: string;
  meta?: any;
  actor: { uid: string; name: string } | null;
  createdAt: string;
}

export interface SupplierOrderItem {
  orderItemId: string;
  productId: string | null;
  qty: number;
  variant?: string | null;
  color?: string | null;
}

export interface SupplierOrder {
  id: string;
  orderId: string;
  supplierId: string;
  supplierName?: string | null;
  eta?: string | null;
  status: "created";
  createdAt: string;
  createdBy: string;
  items: SupplierOrderItem[];
}

type SupplierOpStatusLite = "por_levantar" | "levantado" | "en_camino" | "recibido";

export interface ComputeOrderStatusOptions {
  /**
   * Solo "Confirmar existencias" puede sacar un pedido de captura. Editar, quitar o
   * recibir artículos nunca lo promueve desde `borrador` (RC-01).
   */
  allowFromDraft?: boolean;
}

export function computeOrderStatus(
  order: Pick<Order, "status">,
  items: OrderItem[],
  supplierOps: Array<{ status: SupplierOpStatusLite }>,
  options: ComputeOrderStatusOptions = {},
): OrderStatus {
  const terminalStatuses: OrderStatus[] = [
    "recibido_qa",
    
    "empaque",
    "ready_for_route",
    "assigned_to_run",
    
    "en_ruta",
    "entregado",
    
    
    "pago_pendiente",
    "pagado_parcial",
    "pagado",
    "closed",
    "cancelado",
    "devuelto",
  ];
  const allItemsResolved = items.length > 0 && items.every((item) => !!item.confirmation_state && item.confirmation_state !== "pending");
  if (terminalStatuses.includes(order.status)) return order.status;
  if (order.status === "borrador" && !options.allowFromDraft) return "borrador";
  if (items.length === 0) return "borrador";
  if (supplierOps.length === 0) return allItemsResolved ? "recibido_qa" : order.status;
  if (supplierOps.every((op) => op.status === "recibido")) return "recibido_qa";
  if (supplierOps.some((op) => op.status === "en_camino")) return "en_transito";
  return "supplier_processing";
}

export function makeOrderId(): string {
  const d = new Date();
  const yy = String(d.getFullYear()).slice(-2);
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const u = ulid().slice(-10);
  return `P-${yy}${mm}${dd}-${u}`;
}

@Injectable({ providedIn: "root" })
export class OrdersService {
  private colRef = collection(FIRESTORE, "orders");
  private rows = signal<Order[]>([]);
  private supplierOperations = inject(SupplierOperationsService);
  private inventory = inject(InventoryService);
  private businessScope = inject(BusinessScopeService);
  private adminApi = inject(UserAdminApiService);
  private snapshotSource = inject(ORDERS_SNAPSHOT_SOURCE);
  private perf = inject(PerfMetricsService);
  loading = signal(false);
  loadError = signal<string | null>(null);
  /** Origen de los datos publicados; distingue caché local de confirmación del servidor. */
  syncState = signal<OrdersSyncState>("idle");
  private unsubscribeOrders?: Unsubscribe;
  private firstSnapshotPromise: Promise<void> | null = null;
  private listenerSequence = 0;

  list = computed(() => {
    const active = this.businessScope.activeBusinessIds();
    return this.rows().filter((order) => active.includes(order.business_id || "bm"));
  });

  /** Product details use their own business, even when the global selector changes. */
  forBusiness(businessId: BusinessId): Order[] {
    if (!this.businessScope.availableBusinessIds().includes(businessId)) return [];
    return this.rows().filter(order => (order.business_id || 'bm') === businessId);
  }

  /**
   * Inicia un listener en tiempo real. Seguro llamarlo múltiples veces: solo abre un
   * listener, y mientras el primer snapshot no llega todas las llamadas comparten la
   * misma promesa. Tras un error, volver a llamarlo funciona como reintento.
   *
   * La promesa resuelve también cuando falla (contrato histórico: muchas pantallas la
   * usan en Promise.all). El fallo queda en `loadError` y `syncState === "error"`.
   */
  async loadFromFirestore(): Promise<void> {
    if (this.unsubscribeOrders) return this.firstSnapshotPromise ?? undefined;

    const listenerId = ++this.listenerSequence;
    const isCurrent = () => listenerId === this.listenerSequence;
    const loadId = this.perf.newLoadId("orders");
    const startedAt = this.perf.now();
    this.loading.set(true);
    this.loadError.set(null);
    this.syncState.set("loading");
    const allowedBusinesses = this.businessScope.availableBusinessIds();
    const originNavigationId = this.perf.currentNavigationId();
    // Índice propio de este listener: un listener nuevo siempre parte de un estado completo.
    const index = new OrdersSnapshotIndex<Order>(
      (id, data, fallbackIso) => this.normalize(id, data, fallbackIso),
      () => this.perf.now(),
    );
    // Documentos con escrituras locales sin confirmar; solo alimenta la inferencia de las métricas.
    const pendingIds = new Set<string>();

    const firstSnapshot = new Promise<void>((resolve) => {
      let hasSnapshot = false;
      let hasServerSnapshot = false;
      let failed = false;

      const unsubscribe = this.snapshotSource.listen(
        allowedBusinesses,
        (event) => {
          // Un callback de un listener ya reemplazado no debe pisar datos nuevos.
          if (!isCurrent()) return;
          // Si solo cambió la metadata (caché -> servidor) no se re-normalizan los pedidos.
          if (!hasSnapshot || event.changes.length > 0) {
            this.applySnapshot(event, !hasSnapshot, index, pendingIds, loadId, originNavigationId);
          } else if (!event.hasPendingWrites) {
            pendingIds.clear();
          }
          const source = event.fromCache ? "cache" : "server";
          this.loadError.set(null);
          this.syncState.set(source);
          this.loading.set(false);
          if (!hasSnapshot) {
            hasSnapshot = true;
            this.perf.record("orders_first_snapshot_ms", startedAt, {
              result: "success", load_id: loadId, source, docs: event.size,
            });
            resolve();
          }
          if (!event.fromCache && !hasServerSnapshot) {
            hasServerSnapshot = true;
            this.perf.record("orders_server_snapshot_ms", startedAt, {
              result: "success", load_id: loadId, source, docs: event.size,
            });
          }
        },
        (error) => {
          failed = true;
          if (!isCurrent()) return;
          // Los pedidos ya publicados se conservan: un fallo no los convierte en "sin pedidos".
          this.loadError.set('No se pudieron cargar todos los pedidos. Actualiza para reintentar.');
          // Firestore ya cerró el listener; liberarlo explícitamente es inocuo y evita huérfanos.
          this.unsubscribeOrders?.();
          this.unsubscribeOrders = undefined;
          this.firstSnapshotPromise = null;
          console.error("[OrdersService] onSnapshot error:", error);
          this.loading.set(false);
          this.syncState.set("error");
          // Solo se mide como fallo la etapa que no llegó a completarse.
          if (!hasServerSnapshot) {
            this.perf.record(hasSnapshot ? "orders_server_snapshot_ms" : "orders_first_snapshot_ms", startedAt, {
              result: "error", load_id: loadId, error_code: firebaseErrorCode(error),
            });
          }
          resolve();
        },
      );
      // Si el error llegó de forma síncrona el listener ya está cerrado.
      if (failed) unsubscribe();
      else if (isCurrent()) this.unsubscribeOrders = unsubscribe;
    });

    if (this.unsubscribeOrders && isCurrent()) this.firstSnapshotPromise = firstSnapshot;
    return firstSnapshot;
  }

  /**
   * Aplica un snapshot con cambios de datos: completo si es el primero del
   * listener e incremental (`docChanges()`) en los siguientes. `rows` se
   * reconstruye siempre desde el índice, nunca sobre sí misma, porque también
   * recibe actualizaciones optimistas que el snapshot debe reemplazar.
   */
  private applySnapshot(
    event: OrdersSnapshotEvent,
    initial: boolean,
    index: OrdersSnapshotIndex<Order>,
    pendingIds: Set<string>,
    loadId: string,
    originNavigationId: number | null,
  ): void {
    const startedAt = this.perf.now();
    const metricsEnabled = this.perf.isEnabled();
    const inferredCause = metricsEnabled ? inferSnapshotCause(event, initial, pendingIds) : undefined;
    const { rows, stats } = index.apply(event, initial);
    const publishStartedAt = this.perf.now();
    this.rows.set(rows);
    const publishMs = this.perf.now() - publishStartedAt;
    if (!metricsEnabled) return;

    trackPendingDocs(event, initial || stats.mode === "resync", pendingIds);
    const totalMs = this.perf.now() - startedAt;
    this.perf.record("orders_normalization_ms", startedAt, {
      result: "success",
      load_id: loadId,
      listener_id: loadId,
      origin_navigation_id: originNavigationId,
      apply_mode: stats.mode,
      added: stats.added,
      modified: stats.modified,
      removed: stats.removed,
      docs: stats.docs,
      convert_ms: roundMs(stats.convert_ms),
      normalize_ms: roundMs(stats.normalize_ms),
      index_ms: roundMs(stats.index_ms),
      sort_ms: roundMs(stats.sort_ms),
      publish_ms: roundMs(publishMs),
      from_cache: event.fromCache,
      has_pending_writes: event.hasPendingWrites,
      pending_docs: stats.pending_docs,
      updated_at_pending: stats.updated_at_pending,
      updated_at_missing: stats.updated_at_missing,
      visible: typeof document === "undefined" ? undefined : document.visibilityState === "visible",
      long_task: totalMs >= LONG_TASK_MS,
      inferred_cause: inferredCause,
    });
  }

  /** Detiene el listener activo (usar al destruir contextos de prueba). */
  stopListening(): void {
    this.listenerSequence += 1;
    this.unsubscribeOrders?.();
    this.unsubscribeOrders = undefined;
    this.firstSnapshotPromise = null;
  }

  async createDraft(
    customerId: string,
    routeId: string | null,
    notes?: string,
    businessId?: BusinessId,
    creator?: OrderCreator | null,
  ): Promise<string> {
    const now = new Date().toISOString();
    const orderId = makeOrderId();
    const resolvedBusinessId = normalizeBusinessId(businessId || this.businessScope.writeBusinessId());
    const draft: Order = {
      created_by: normalizeOrderCreator(creator) ?? normalizeOrderCreator(FIREBASE_AUTH.currentUser
        ? { uid: FIREBASE_AUTH.currentUser.uid, name: FIREBASE_AUTH.currentUser.displayName || FIREBASE_AUTH.currentUser.email || "Usuario" }
        : null),
      order_id: orderId,
      business_id: resolvedBusinessId,
      customer_id: customerId,
      route_id: routeId,
      status: "borrador",
      planned_packages: null,
      open_incidents_count: 0,
      has_high_incident: false,
      last_incident_at: null,
      last_event_at: null,
      created_at: now,
      updated_at: now,
      items: [],
      packages: [],
      timeline: [{ id: `t-${Date.now()}`, label: "Borrador creado", created_at: now }],
      notes: notes || "",
      packing: {
        status: "in_progress",
        packages_count: 0,
        completed_at: null,
      },
      dispatch_request: {
        status: "none",
        requested_at: null,
        requested_by: null,
        note: null,
      },
      route_run_id: null,
      totals: {
        total_amount: 0,
        paid_amount: 0,
        balance_due: 0,
      },
    };
    await setDoc(doc(this.colRef, orderId), {
      ...draft,
      created_at: serverTimestamp(),
      updated_at: serverTimestamp(),
    });
    this.rows.set([draft, ...this.rows()]);
    return orderId;
  }

  async loadMock(): Promise<void> {
    if (this.rows().length > 0) return;
    this.loading.set(true);

    const now = new Date().toISOString();
    const sample: Order[] = [
      {
        order_id: "P-2401",
        business_id: "bm",
        customer_id: "clienta-ana",
        route_id: "durango",
        status: "empaque",
        planned_packages: 1,
        open_incidents_count: 0,
        has_high_incident: false,
        last_incident_at: null,
        last_event_at: null,
        created_at: now,
        updated_at: now,
        notes: "Pedir color negro si hay reposición",
        items: [
          {
            item_id: "item-1",
            title: "Blusa satinada",
            variant: "M",
            color: "Negro",
            quantity: 2,
            source: "catalogo",
            state: "reservado_inventario",
            price_public: 520,
            price_cost: 260,
            discount_pct: 25,
          },
          {
            item_id: "item-2",
            title: "Pantalon wide-leg",
            variant: "30",
            color: "Arena",
            quantity: 1,
            source: "catalogo",
            state: "confirmando_proveedor",
            price_public: 680,
            price_cost: 350,
            discount_pct: 25,
          },
        ],
        packages: [
          {
            package_id: "pack-1",
            label: "Paquete 1/1",
            sequence: 1,
            total_packages: 1,
            state: "closed",
            amount_due: 1420,
            item_ids: ["item-1"],
            created_at: now,
          },
        ],
        timeline: [
          { id: "t1", label: "Pedido creado", created_at: now, actor: "admin" },
          { id: "t2", label: "Reservado en inventario", created_at: now, actor: "admin" },
        ],
        packing: {
          status: "in_progress",
          packages_count: 1,
          completed_at: null,
        },
        dispatch_request: {
          status: "none",
          requested_at: null,
          requested_by: null,
          note: null,
        },
        route_run_id: null,
        totals: {
          total_amount: 1420,
          paid_amount: 0,
          balance_due: 1420,
        },
      },
      {
        order_id: "P-2402",
        business_id: "bm",
        customer_id: "clienta-bety",
        route_id: "zapopan",
        status: "en_ruta",
        planned_packages: 1,
        open_incidents_count: 0,
        has_high_incident: false,
        last_incident_at: null,
        last_event_at: null,
        created_at: now,
        updated_at: now,
        items: [
          {
            item_id: "item-3",
            title: "Sudadera oversize",
            variant: "L",
            color: "Gris",
            quantity: 1,
            source: "inventario",
            state: "en_ruta",
            price_public: 450,
            price_cost: 210,
            discount_pct: 25,
          },
        ],
        packages: [
          {
            package_id: "pack-2",
            label: "Paquete 1/1",
            sequence: 1,
            total_packages: 1,
            state: "en_ruta",
            amount_due: 337,
            item_ids: ["item-3"],
            created_at: now,
          },
        ],
        timeline: [{ id: "t3", label: "Salida a ruta", created_at: now, actor: "reparto" }],
        packing: {
          status: "done",
          packages_count: 1,
          completed_at: now,
        },
        dispatch_request: {
          status: "accepted",
          requested_at: now,
          requested_by: { uid: "u1", name: "Admin" },
          note: null,
        },
        route_run_id: "run_demo",
        totals: {
          total_amount: 337,
          paid_amount: 0,
          balance_due: 337,
        },
      },
      {
        order_id: "P-2403",
        business_id: "bm",
        customer_id: "clienta-luisa",
        route_id: "sin_ruta",
        status: "borrador",
        planned_packages: null,
        open_incidents_count: 0,
        has_high_incident: false,
        last_incident_at: null,
        last_event_at: null,
        created_at: now,
        updated_at: now,
        items: [],
        packages: [],
        timeline: [{ id: "t4", label: "Borrador creado", created_at: now }],
        notes: "",
        packing: {
          status: "in_progress",
          packages_count: 0,
          completed_at: null,
        },
        dispatch_request: {
          status: "none",
          requested_at: null,
          requested_by: null,
          note: null,
        },
        route_run_id: null,
        totals: {
          total_amount: 0,
          paid_amount: 0,
          balance_due: 0,
        },
      },
    ];

    this.rows.set(sample);
    this.loading.set(false);
  }

  getById(orderId: string): Order | null {
    return this.rows().find((o) => o.order_id === orderId) || null;
  }

  add(order: Order): string {
    const id = order.order_id || makeOrderId();
    const next: Order = { ...order, order_id: id };
    this.rows.set([next, ...this.rows()]);
    return id;
  }

  async updateStatus(orderId: string, status: OrderStatus, note?: string) {
    const now = new Date().toISOString();
    const marksDelivered = status === "entregado" || status === "closed";
    this.rows.update((current) =>
      current.map((order) => {
        if (order.order_id !== orderId) return order;
        const updated: Order = {
          ...order,
          status,
          updated_at: now,
          delivered_at: marksDelivered ? (order.delivered_at || now) : order.delivered_at,
          timeline: [
            ...order.timeline,
            {
              id: `t-${Date.now()}`,
              label: `Estado: ${status}`,
              created_at: now,
            },
          ],
        };
        if (note) updated.notes = note;
        return updated;
      }),
    );
    await updateDoc(doc(this.colRef, orderId), {
      status,
      updated_at: serverTimestamp(),
      timeline: this.getById(orderId)?.timeline || [],
      notes: note ?? this.getById(orderId)?.notes ?? "",
      ...(marksDelivered ? { delivered_at: serverTimestamp() } : {}),
    });
    if (marksDelivered) {
      await this.consumeInventoryForDelivery(orderId);
      await this.closeSupplierLinesOnDelivery(orderId);
    } else if (status === "cancelado") {
      await this.releaseInventoryForOrder(orderId);
    }
  }

  async updateOperationalState(
    orderId: string,
    patch: Partial<
      Pick<
        Order,
        | "fulfillment_status"
        | "delivery_status"
        | "customer_payment_status"
        | "settlement_status"
        | "current_holder_location"
        | "current_holder_user_id"
        | "current_holder_name"
        | "shipment_id"
      >
    >,
    message = "Estado operativo actualizado",
  ): Promise<void> {
    const now = new Date().toISOString();
    const cleanPatch = Object.fromEntries(
      Object.entries(patch).filter(([, value]) => value !== undefined),
    ) as typeof patch;
    if (Object.keys(cleanPatch).length === 0) return;

    this.rows.update((current) =>
      current.map((order) => (order.order_id === orderId ? { ...order, ...cleanPatch, updated_at: now } : order)),
    );
    await updateDoc(doc(this.colRef, orderId), {
      ...cleanPatch,
      updated_at: serverTimestamp(),
    });
    await this.logEvent(orderId, "ORDER_OPERATION_UPDATED", message, cleanPatch);
  }

  async markOrderDelivered(orderId: string, note?: string): Promise<void> {
    const now = new Date().toISOString();
    // La entrega no borra un cobro previo: un pedido ya liquidado queda `pagado`.
    // Se guarda siempre el nombre canónico (`entregado`), nunca `delivered`.
    const nextStatus = statusAfterDelivery(this.getById(orderId)?.customer_payment_status);
    this.rows.update((current) =>
      current.map((order) =>
        order.order_id === orderId
          ? {
              ...order,
              status: nextStatus,
              delivery_status: "delivered",
              current_holder_location: "customer",
              delivered_at: order.delivered_at || now,
              updated_at: now,
              timeline: [
                ...order.timeline,
                { id: `t-${Date.now()}`, label: "Pedido entregado", created_at: now },
              ],
            }
          : order,
      ),
    );
    await updateDoc(doc(this.colRef, orderId), {
      status: nextStatus,
      delivery_status: "delivered",
      current_holder_location: "customer",
      delivered_at: serverTimestamp(),
      updated_at: serverTimestamp(),
      timeline: this.getById(orderId)?.timeline || [],
      ...(note ? { notes: note } : {}),
    });
    await this.consumeInventoryForDelivery(orderId).catch((error) => {
      console.error("[OrdersService] No se pudo consumir inventario al entregar", error);
    });
    await this.closeSupplierLinesOnDelivery(orderId);
    await this.logEvent(orderId, "ORDER_DELIVERED", note || "Pedido marcado como entregado");
  }

  /**
   * La mercancía de proveedor recibida para un pedido entregado sale del inventario.
   * Antes se borraban las líneas liberando su reserva: lo entregado volvía a "disponible".
   */
  private async closeSupplierLinesOnDelivery(orderId: string): Promise<void> {
    const order = this.getById(orderId);
    if (!order) return;
    await this.supplierOperations.closeOnDelivery(order).catch((error) => {
      console.error("[OrdersService] No se pudieron cerrar las líneas de proveedor al entregar", error);
    });
  }

  async markOrderDeliveryIssue(orderId: string, deliveryStatus: Extract<OrderDeliveryStatus, "not_delivered" | "incident">, note?: string) {
    await this.updateOperationalState(
      orderId,
      {
        delivery_status: deliveryStatus,
        current_holder_location: "durango",
      },
      note || (deliveryStatus === "incident" ? "Incidencia de entrega" : "Pedido no entregado"),
    );
  }

  async registerCustomerCollection(
    orderId: string,
    amount: number,
    method: CollectionMethod = "efectivo",
    collectedByName?: string | null,
    note?: string | null,
    options: RegisterCollectionOptions = {},
  ): Promise<string> {
    const paymentReceived = Math.max(0, Number.isFinite(amount) ? amount : 0);
    if (paymentReceived <= 0) throw new Error("El cobro debe ser mayor a cero.");
    const now = new Date().toISOString();
    const actor = this.currentActor(collectedByName || undefined);
    const eventId = ulid();
    const eventRef = doc(FIRESTORE, "order_collection_events", eventId);
    const verificationStatus = options.verificationStatus || "confirmed";
    const sourceLocation = options.sourceLocation || "gdl";
    let savedOrder: Order | null = null;
    let savedBalanceDue = 0;
    let savedBusinessId: BusinessId = normalizeBusinessId(this.getById(orderId)?.business_id);

    await runTransaction(FIRESTORE, async (tx) => {
      const orderRef = doc(this.colRef, orderId);
      const orderSnap = await tx.get(orderRef);
      if (!orderSnap.exists()) throw new Error("El pedido ya no existe.");
      const liveOrder = this.normalize(orderSnap.id, orderSnap.data());
      const businessId = normalizeBusinessId(liveOrder.business_id);
      savedBusinessId = businessId;
      const accountId = options.accountId || (businessId === "bm" ? "acc_caja_general" : `acc_${businessId}_general`);
      const accountRef = doc(FIRESTORE, "finance_accounts", accountId);
      const periodId = monthIdFromDateInput(now);
      const periodRef = doc(FIRESTORE, "finance_periods", financePeriodDocumentId(businessId, periodId));
      const [accountSnap, periodSnap] = await Promise.all([tx.get(accountRef), tx.get(periodRef)]);
      if (periodSnap.exists() && periodSnap.data()["status"] === "closed") {
        throw new Error(`El periodo ${periodId} está cerrado. Reábrelo antes de registrar el cobro.`);
      }
      if (!accountSnap.exists()) throw new Error("No existe la cuenta General para registrar el cobro.");
      if (normalizeBusinessId(accountSnap.data()["business_id"]) !== businessId) {
        throw new Error("La cuenta de cobro pertenece a otro negocio.");
      }

      const previousPaid = Math.max(0, Number(liveOrder.totals?.paid_amount || 0));
      const safePaid = Number((previousPaid + paymentReceived).toFixed(2));
      const discountAmount = options.discountAmount == null
        ? Number(liveOrder.totals?.discount_amount || 0)
        : Math.max(0, Number(options.discountAmount || 0));
      const persistedTotals = toPersistedOrderTotals({
        ...liveOrder,
        totals: { ...liveOrder.totals, discount_amount: discountAmount, paid_amount: safePaid },
      });
      const balanceDue = Math.max(0, Number(persistedTotals["balance_due"] || 0));
      const customerPaymentStatus: OrderCustomerPaymentStatus = safePaid <= 0 ? "pending" : balanceDue <= 0 ? "collected" : "partial";
      // Cobrar no es entregar (RC-01): antes de la entrega se conserva la etapa operativa
      // y el cobro queda en `customer_payment_status` y en los montos.
      const nextStatus = normalizeOrderStatus(statusAfterCollection(liveOrder, customerPaymentStatus));
      const settlementStatus: OrderSettlementStatus = paymentReceived > 0 ? "pending" : liveOrder.settlement_status || "not_applicable";
      const timeline = [
        ...(liveOrder.timeline || []),
        { id: `t-${eventId}`, label: `Cobro registrado: $${paymentReceived}`, created_at: now },
      ];
      tx.update(orderRef, {
        status: nextStatus,
        updated_at: serverTimestamp(),
        totals: persistedTotals,
        paid_at: customerPaymentStatus === "collected" ? serverTimestamp() : liveOrder.paid_at || null,
        paid_at_quality: customerPaymentStatus === "collected" ? null : liveOrder.paid_at_quality || null,
        customer_payment_status: customerPaymentStatus,
        settlement_status: settlementStatus,
        collection_status: customerPaymentStatus === "collected" ? "paid" : "pending",
        collection_reminder_at: customerPaymentStatus === "collected" ? null : liveOrder.collection_reminder_at || null,
        collection_note: note || (customerPaymentStatus === "collected" ? "Cobro liquidado." : liveOrder.collection_note || null),
        timeline,
      });
      tx.set(eventRef, {
        event_id: eventId,
        order_id: orderId,
        business_id: businessId,
        account_id: accountId,
        amount: paymentReceived,
        method,
        status_after: customerPaymentStatus,
        settlement_status_after: settlementStatus,
        source_location: sourceLocation,
        verification_status: verificationStatus,
        collected_by: actor,
        reported_by: this.currentActor(options.reportedByName || collectedByName || undefined),
        verified_by: verificationStatus === "reported" ? null : this.currentActor(),
        verified_at: verificationStatus === "reported" ? null : serverTimestamp(),
        cash_occurred_at: verificationStatus === "reported" ? null : now.slice(0, 10),
        note: note || null,
        created_at: serverTimestamp(),
      });
      if (verificationStatus === "confirmed") {
        const ledgerId = `ledger_collection_${eventId}`;
        const ledger = ledgerEntryPayload({
          entry_id: ledgerId,
          business_id: businessId,
          account_id: accountId,
          kind: "collection",
          cash_effect: paymentReceived,
          occurred_at: now.slice(0, 10),
          source: "order_collection",
          source_id: eventId,
          order_id: orderId,
          return_id: null,
          reverses_entry_id: null,
          data_quality: "native",
          notes: note || null,
          created_by: FIREBASE_AUTH.currentUser?.uid || null,
        });
        tx.set(doc(FIRESTORE, "finance_ledger_entries", ledgerId), { ...ledger, created_at: serverTimestamp() });
        tx.update(accountRef, {
          balance: Number((Number(accountSnap.data()["balance"] || 0) + paymentReceived).toFixed(2)),
          updated_at: serverTimestamp(),
        });
      }
      savedBalanceDue = balanceDue;
      savedOrder = {
        ...liveOrder,
        status: nextStatus,
        updated_at: now,
        paid_at: customerPaymentStatus === "collected" ? now : liveOrder.paid_at || null,
        paid_at_quality: customerPaymentStatus === "collected" ? null : liveOrder.paid_at_quality || null,
        customer_payment_status: customerPaymentStatus,
        settlement_status: settlementStatus,
        collection_status: customerPaymentStatus === "collected" ? "paid" : "pending",
        collection_reminder_at: customerPaymentStatus === "collected" ? null : liveOrder.collection_reminder_at || null,
        collection_note: note || (customerPaymentStatus === "collected" ? "Cobro liquidado." : liveOrder.collection_note || null),
        totals: persistedTotals as unknown as OrderTotals,
        timeline,
      };
    });

    if (savedOrder) {
      const updatedOrder: Order = savedOrder;
      this.rows.update((current) => current.map((order) => order.order_id === orderId ? updatedOrder : order));
    }
    await this.logEvent(orderId, "CUSTOMER_COLLECTION_REGISTERED", `Cobro registrado: $${paymentReceived}`, {
      amount: paymentReceived,
      method,
      balance_due: savedBalanceDue,
      business_id: savedBusinessId,
    });
    return eventId;
  }

  async listCollectionEventsForOrder(orderId: string): Promise<OrderCollectionEvent[]> {
    const target = String(orderId || "").trim();
    if (!target) return [];
    const snap = await getDocs(query(collection(FIRESTORE, "order_collection_events"), where("order_id", "==", target)));
    return snap.docs
      .map((entry) => this.normalizeCollectionEvent(entry.id, entry.data() as Record<string, any>))
      .sort((a, b) => String(b.created_at || "").localeCompare(String(a.created_at || "")));
  }

  async listCollectionEventsForAvailableBusinesses(): Promise<OrderCollectionEvent[]> {
    const businessIds = this.businessScope.availableBusinessIds();
    if (businessIds.length === 0) return [];
    const snap = await getDocs(
      query(collection(FIRESTORE, "order_collection_events"), where("business_id", "in", businessIds)),
    );
    return snap.docs
      .map((entry) => this.normalizeCollectionEvent(entry.id, entry.data() as Record<string, any>))
      .sort((a, b) => String(b.created_at || "").localeCompare(String(a.created_at || "")));
  }

  async confirmReportedCollection(event: OrderCollectionEvent, note?: string | null): Promise<void> {
    const occurredAt = new Date().toISOString().slice(0, 10);
    await runTransaction(FIRESTORE, async (tx) => {
      const eventRef = doc(FIRESTORE, "order_collection_events", event.event_id);
      const eventSnap = await tx.get(eventRef);
      if (!eventSnap.exists()) throw new Error("El cobro reportado ya no existe.");
      if (eventSnap.data()["verification_status"] === "confirmed") return;
      const businessId = normalizeBusinessId(eventSnap.data()["business_id"]);
      const accountId = String(eventSnap.data()["account_id"] || (businessId === "bm" ? "acc_caja_general" : `acc_${businessId}_general`));
      const accountRef = doc(FIRESTORE, "finance_accounts", accountId);
      const ledgerId = `ledger_collection_${event.event_id}`;
      const [accountSnap, ledgerSnap, periodSnap] = await Promise.all([
        tx.get(accountRef),
        tx.get(doc(FIRESTORE, "finance_ledger_entries", ledgerId)),
        tx.get(doc(FIRESTORE, "finance_periods", financePeriodDocumentId(businessId, monthIdFromDateInput(occurredAt)))),
      ]);
      if (periodSnap.exists() && periodSnap.data()["status"] === "closed") {
        throw new Error(`El periodo ${monthIdFromDateInput(occurredAt)} está cerrado.`);
      }
      if (!accountSnap.exists()) throw new Error("No existe la cuenta General para recibir el cobro.");
      if (normalizeBusinessId(accountSnap.data()["business_id"]) !== businessId) throw new Error("La cuenta pertenece a otro negocio.");
      const amount = Math.max(0, Number(eventSnap.data()["amount"] || 0));
      tx.update(eventRef, {
        account_id: accountId,
        verification_status: "confirmed",
        verified_by: this.currentActor(),
        verified_at: serverTimestamp(),
        cash_occurred_at: occurredAt,
        ...(note ? { verification_note: note } : {}),
      });
      if (!ledgerSnap.exists() && amount > 0) {
        const ledger = ledgerEntryPayload({
          entry_id: ledgerId, business_id: businessId, account_id: accountId, kind: "collection",
          cash_effect: amount, occurred_at: occurredAt, source: "order_collection", source_id: event.event_id,
          order_id: String(eventSnap.data()["order_id"] || event.order_id), return_id: null,
          reverses_entry_id: null, data_quality: "native", notes: note || null,
          created_by: FIREBASE_AUTH.currentUser?.uid || null,
        });
        tx.set(doc(FIRESTORE, "finance_ledger_entries", ledgerId), { ...ledger, created_at: serverTimestamp() });
        tx.update(accountRef, {
          balance: Number((Number(accountSnap.data()["balance"] || 0) + amount).toFixed(2)),
          updated_at: serverTimestamp(),
        });
      }
    });
    await this.markSettlement(event.order_id, "received", note || "Dinero recibido de Durango");
  }

  async markCollectionDifference(event: OrderCollectionEvent, note?: string | null): Promise<void> {
    await updateDoc(doc(FIRESTORE, "order_collection_events", event.event_id), {
      verification_status: "difference",
      verified_by: this.currentActor(),
      verified_at: serverTimestamp(),
      ...(note ? { verification_note: note } : {}),
    });
    await this.markSettlement(event.order_id, "difference", note || "Diferencia en cobro reportado");
  }

  async rejectReportedCollection(event: OrderCollectionEvent, reason: string): Promise<void> {
    const order = this.getById(event.order_id);
    if (!order) throw new Error("Pedido no encontrado");
    const amount = Math.max(0, Number(event.amount || 0));
    const nextPaid = Math.max(0, Number((Number(order.totals?.paid_amount || 0) - amount).toFixed(2)));
    const recalculated = toPersistedOrderTotals({ ...order, totals: { ...order.totals, paid_amount: nextPaid } });
    const nextBalance = Number(recalculated["balance_due"] || 0);
    const nextPaymentStatus: OrderCustomerPaymentStatus = nextPaid <= 0 ? "pending" : nextBalance > 0 ? "partial" : "collected";
    const nextStatus = normalizeOrderStatus(statusAfterCollection(order, nextPaymentStatus));
    const settlementStatus: OrderSettlementStatus = nextPaid > 0 ? "pending" : "not_applicable";
    const now = new Date().toISOString();

    this.rows.update((current) =>
      current.map((row) =>
        row.order_id === order.order_id
          ? {
              ...row,
              status: nextStatus,
              customer_payment_status: nextPaymentStatus,
              settlement_status: settlementStatus,
              totals: recalculated as unknown as OrderTotals,
              collection_status: nextBalance > 0 ? "pending" : "paid",
              collection_note: reason || "Cobro reportado rechazado.",
              updated_at: now,
            }
          : row,
      ),
    );

    await updateDoc(doc(this.colRef, order.order_id), {
      status: nextStatus,
      customer_payment_status: nextPaymentStatus,
      settlement_status: settlementStatus,
      totals: recalculated,
      collection_status: nextBalance > 0 ? "pending" : "paid",
      collection_note: reason || "Cobro reportado rechazado.",
      updated_at: serverTimestamp(),
    });
    await updateDoc(doc(FIRESTORE, "order_collection_events", event.event_id), {
      verification_status: "rejected",
      rejected_reason: reason || "Cobro rechazado por GDL",
      verified_by: this.currentActor(),
      verified_at: serverTimestamp(),
    });
    await this.logEvent(order.order_id, "CUSTOMER_COLLECTION_REJECTED", "Cobro reportado rechazado", {
      amount,
      reason,
      event_id: event.event_id,
    });
  }

  async markSettlement(orderId: string, settlementStatus: OrderSettlementStatus, note?: string | null): Promise<void> {
    const currentOrder = this.getById(orderId);
    const paymentStatus = currentOrder?.customer_payment_status || this.deriveCustomerPaymentStatus(currentOrder || null);
    // Cierre explícito por conciliación, solo con entrega REAL (fecha guardada) y saldo cero (RC-02).
    // Un pedido pagado sin entrega registrada no se cierra aunque se concilie su dinero.
    const shouldClose = settlementStatus === "reconciled" && !!currentOrder && canCloseBySettlement(currentOrder, paymentStatus);
    const now = new Date().toISOString();

    this.rows.update((current) =>
      current.map((order) =>
        order.order_id === orderId
          ? {
              ...order,
              settlement_status: settlementStatus,
              status: shouldClose ? "closed" : order.status,
              closed_at: shouldClose ? now : order.closed_at || null,
              updated_at: now,
            }
          : order,
      ),
    );
    await updateDoc(doc(this.colRef, orderId), {
      settlement_status: settlementStatus,
      ...(shouldClose ? { status: "closed", closed_at: serverTimestamp() } : {}),
      updated_at: serverTimestamp(),
    });

    const eventId = ulid();
    await setDoc(doc(FIRESTORE, "order_settlement_events", eventId), {
      event_id: eventId,
      order_id: orderId,
      business_id: currentOrder?.business_id || "bm",
      status: settlementStatus,
      note: note || null,
      created_by: this.currentActor(),
      created_at: serverTimestamp(),
    });
    await this.logEvent(orderId, "ORDER_SETTLEMENT_UPDATED", `Conciliación: ${settlementStatus}`, {
      settlement_status: settlementStatus,
      closed: shouldClose,
    });
  }

  async updatePlannedPackages(orderId: string, plannedPackages: number) {
    const now = new Date().toISOString();
    this.rows.update((current) =>
      current.map((order) => {
        if (order.order_id !== orderId) return order;
        return {
          ...order,
          planned_packages: plannedPackages,
          updated_at: now,
        };
      }),
    );
    await updateDoc(doc(this.colRef, orderId), {
      planned_packages: plannedPackages,
      updated_at: serverTimestamp(),
    });
  }

  async updateCustomer(orderId: string, customerId: string, routeId: string | null): Promise<void> {
    const safeCustomerId = String(customerId || "").trim();
    if (!safeCustomerId) throw new Error("customer_id requerido");
    const safeRouteId = routeId ? String(routeId).trim() || null : null;
    const now = new Date().toISOString();

    this.rows.update((current) =>
      current.map((order) => {
        if (order.order_id !== orderId) return order;
        return {
          ...order,
          customer_id: safeCustomerId,
          route_id: safeRouteId,
          updated_at: now,
          timeline: [
            ...(order.timeline || []),
            {
              id: `t-${Date.now()}`,
              label: "Clienta actualizada",
              created_at: now,
            },
          ],
        };
      }),
    );

    await updateDoc(doc(this.colRef, orderId), {
      customer_id: safeCustomerId,
      route_id: safeRouteId,
      timeline: this.getById(orderId)?.timeline || [],
      updated_at: serverTimestamp(),
    });
  }

  async deleteOrder(orderId: string): Promise<void> {
    const targetOrderId = String(orderId || "").trim();
    if (!targetOrderId) return;

    const previousRows = this.rows();
    const orderSnapshot = this.getById(targetOrderId);
    this.rows.update((current) => current.filter((order) => order.order_id !== targetOrderId));
    try {
      await this.releaseInventoryForOrder(targetOrderId, orderSnapshot).catch(() => null);
      await this.supplierOperations.removeByOrder(targetOrderId).catch(() => null);
      const nestedCollections = ["incidents", "events", "supplierOrders"];
      for (const nested of nestedCollections) {
        const snap = await getDocs(collection(FIRESTORE, "orders", targetOrderId, nested));
        await Promise.all(snap.docs.map((entry) => deleteDoc(entry.ref)));
      }
      await deleteDoc(doc(this.colRef, targetOrderId));
    } catch (error) {
      this.rows.set(previousRows);
      throw error;
    }
  }

  /** Cierra el pedido registrando el pago total o parcial. */
  async closeWithPayment(orderId: string, paidAmount: number, _totalAmount: number, discountAmount = 0): Promise<void> {
    const currentOrder = this.getById(orderId);
    if (!currentOrder) throw new Error("Pedido no encontrado.");
    await this.registerCustomerCollection(
      orderId,
      paidAmount,
      "otro",
      null,
      "Cobro registrado desde pedido.",
      { discountAmount },
    );
  }

  async markSalesNoteGenerated(orderId: string): Promise<void> {
    const now = new Date().toISOString();
    this.rows.update((current) =>
      current.map((order) => order.order_id === orderId ? { ...order, sales_note_last_generated_at: now, updated_at: now } : order),
    );
    await updateDoc(doc(this.colRef, orderId), {
      sales_note_last_generated_at: now,
      updated_at: serverTimestamp(),
    });
  }

  async updateCollectionState(orderId: string, patch: {
    collection_status?: CollectionStatus;
    collection_reminder_at?: string | null;
    collection_note?: string | null;
    sales_note_last_generated_at?: string | null;
  }): Promise<void> {
    const cleanPatch: Record<string, unknown> = {};
    if (patch.collection_status) cleanPatch["collection_status"] = patch.collection_status;
    if ("collection_reminder_at" in patch) cleanPatch["collection_reminder_at"] = patch.collection_reminder_at || null;
    if ("collection_note" in patch) cleanPatch["collection_note"] = patch.collection_note || null;
    if ("sales_note_last_generated_at" in patch) cleanPatch["sales_note_last_generated_at"] = patch.sales_note_last_generated_at || null;
    if (!Object.keys(cleanPatch).length) return;

    const now = new Date().toISOString();
    this.rows.update((current) =>
      current.map((order) => order.order_id === orderId ? { ...order, ...cleanPatch, updated_at: now } as Order : order),
    );
    await updateDoc(doc(this.colRef, orderId), {
      ...cleanPatch,
      updated_at: serverTimestamp(),
    });
  }

  async consumeInventoryForDelivery(orderId: string, packageId?: string | null): Promise<void> {
    const order = this.getById(orderId);
    if (!order) return;
    const packageRow = packageId ? (order.packages || []).find((pkg) => pkg.package_id === packageId) : null;
    const qtyByItem = new Map<string, number>();
    for (const entry of packageRow?.items || []) {
      qtyByItem.set(entry.orderItemId, Math.max(0, Math.trunc(Number(entry.qty || 0))));
    }
    for (const item of order.items || []) {
      const inventoryId = String(item.inventory_id || "").trim();
      if (!inventoryId) continue;
      const qty = packageRow
        ? Math.max(0, qtyByItem.get(item.item_id) ?? ((packageRow.item_ids || []).includes(item.item_id) ? Number(item.confirmed_qty ?? item.quantity ?? 0) : 0))
        : Math.max(0, Number(item.confirmed_qty ?? item.quantity ?? 0) - Number(item.returned_qty || 0));
      if (qty <= 0) continue;
      await this.inventory.consumeOnDelivery({
        sku: inventoryId,
        qty,
        orderId: order.order_id,
        orderItemId: item.item_id,
        idempotencyKey: `delivery_${order.order_id}_${packageId || "close"}_${item.item_id}`,
      });
    }
  }

  async releaseInventoryForOrder(orderId: string, orderOverride?: Order | null): Promise<void> {
    const order = orderOverride ?? this.getById(orderId);
    if (!order) return;
    for (const item of order.items || []) {
      const inventoryId = String(item.inventory_id || "").trim();
      const qty = Math.max(0, Number(item.confirmed_qty ?? item.quantity ?? 0) - Number(item.returned_qty || 0));
      if (!inventoryId || qty <= 0) continue;
      await this.inventory.releaseReservation({
        sku: inventoryId,
        qty,
        orderId,
        orderItemId: item.item_id,
        idempotencyKey: `cancel_${orderId}_${item.item_id}`,
      });
    }
  }

  async setDiscountAmount(orderId: string, discountAmount: number): Promise<void> {
    const safeDiscount = Math.max(0, Number.isFinite(discountAmount) ? discountAmount : 0);
    const now = new Date().toISOString();
    let persistedTotals: Record<string, number> | null = null;
    this.rows.update((current) =>
      current.map((order) => {
        if (order.order_id !== orderId) return order;
        persistedTotals = toPersistedOrderTotals({
          ...order,
          totals: { ...order.totals, discount_amount: safeDiscount },
        });
        return {
          ...order,
          updated_at: now,
          totals: persistedTotals as unknown as OrderTotals,
        };
      }),
    );

    await updateDoc(doc(this.colRef, orderId), {
      ...(persistedTotals ? { totals: persistedTotals } : { "totals.discount_amount": safeDiscount }),
      updated_at: serverTimestamp(),
    });
  }

  async syncDerivedStatus(orderId: string, options: ComputeOrderStatusOptions = {}): Promise<OrderStatus | null> {
    const order = this.getById(orderId);
    if (!order) return null;
    const supplierOpsSnap = await getDocs(query(collection(FIRESTORE, "supplier_operations"), where("order_id", "==", orderId)));
    const supplierOps = supplierOpsSnap.docs
      .map((entry) => {
        const data = entry.data() as Record<string, unknown>;
        const reservedFor = supplierOperationReservedForOrderId(data);
        if (reservedFor !== orderId) return null;
        const raw = data["status"];
        const normalizedStatus: SupplierOpStatusLite = raw === "recibido" || raw === "en_camino" || raw === "levantado"
          ? raw
          : "por_levantar";
        const status: SupplierOpStatusLite = normalizedStatus === "recibido" && !isSupplierReceiptComplete(data)
          ? "en_camino"
          : normalizedStatus;
        return { status };
      })
      .filter((row): row is { status: SupplierOpStatusLite } => !!row);
    const nextStatus = computeOrderStatus(order, order.items || [], supplierOps, options);
    if (nextStatus !== order.status) {
      const previousStatus = order.status;
      await this.updateStatus(orderId, nextStatus);
      await this.logEvent(orderId, "ORDER_STATUS_DERIVED", `Etapa: ${previousStatus} -> ${nextStatus}`, {
        previous_status: previousStatus,
        next_status: nextStatus,
        supplier_operations: supplierOps.length,
      }).catch(() => undefined);
    }
    return nextStatus;
  }

  private updateIncidentSummary(orderId: string, deltaOpen: number, setHigh: boolean | null, lastIncidentAt?: string | null) {
    const now = new Date().toISOString();
    this.rows.update((current) =>
      current.map((order) => {
        if (order.order_id !== orderId) return order;
        const nextOpen = Math.max(0, (order.open_incidents_count ?? 0) + deltaOpen);
        const nextHigh = setHigh !== null ? setHigh : order.has_high_incident ?? false;
        return {
          ...order,
          open_incidents_count: nextOpen,
          has_high_incident: nextHigh,
          last_incident_at: lastIncidentAt ?? order.last_incident_at ?? null,
          updated_at: now,
        };
      }),
    );
  }

  async logEvent(
    orderId: string,
    type: string,
    message: string,
    meta?: any,
    actor?: { uid: string; name: string } | string | null
  ) {
    const now = new Date().toISOString();
    const user = FIREBASE_AUTH.currentUser;
    const resolvedActor =
      typeof actor === "string"
        ? { uid: "manual", name: actor }
        : actor ??
          (user
            ? { uid: user.uid, name: user.displayName || user.email || "Usuario" }
            : { uid: "system", name: "Sistema" });
    const eventId = `evt-${Date.now()}`;
    const event: OrderEvent = {
      id: eventId,
      orderId,
      type,
      message,
      meta: meta ?? null,
      actor: resolvedActor,
      createdAt: now,
    };
    await setDoc(doc(FIRESTORE, "orders", orderId, "events", eventId), {
      ...event,
      createdAt: serverTimestamp(),
    });
    this.rows.update((current) =>
      current.map((order) =>
        order.order_id === orderId ? { ...order, last_event_at: now, updated_at: now } : order
      ),
    );
    await updateDoc(doc(this.colRef, orderId), {
      last_event_at: serverTimestamp(),
      updated_at: serverTimestamp(),
    });
  }

  async createIncident(
    orderId: string,
    payload: Omit<Incident, "id" | "createdAt" | "updatedAt" | "status" | "resolvedAt" | "resolvedBy" | "resolutionNote">
  ) {
    const now = new Date().toISOString();
    const incidentId = `inc-${Date.now()}`;
    const incident: Incident = {
      id: incidentId,
      orderId,
      packageId: payload.packageId ?? null,
      itemId: payload.itemId ?? null,
      type: payload.type,
      severity: payload.severity,
      status: "open",
      title: payload.title,
      reason: payload.reason,
      assigneeId: payload.assigneeId ?? null,
      evidenceUrls: payload.evidenceUrls ?? [],
      createdBy: payload.createdBy,
      createdAt: now,
      updatedAt: now,
    };
    await setDoc(doc(FIRESTORE, "orders", orderId, "incidents", incidentId), {
      ...incident,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });

    const row = this.getById(orderId);
    const nextOpen = (row?.open_incidents_count ?? 0) + 1;
    const nextHigh = (row?.has_high_incident ?? false) || incident.severity === "high";
    this.updateIncidentSummary(orderId, 1, nextHigh, now);
    await updateDoc(doc(this.colRef, orderId), {
      open_incidents_count: nextOpen,
      has_high_incident: nextHigh,
      last_incident_at: serverTimestamp(),
      updated_at: serverTimestamp(),
    });

    await this.logEvent(orderId, "INCIDENT_CREATED", `Incidencia creada: ${incident.type}`, {
      incidentId,
      severity: incident.severity,
    });
    return incidentId;
  }

  async updateIncident(orderId: string, incidentId: string, patch: Partial<Incident>, actor = "admin") {
    const now = new Date().toISOString();
    await updateDoc(doc(FIRESTORE, "orders", orderId, "incidents", incidentId), {
      ...patch,
      updatedAt: serverTimestamp(),
    });
    this.rows.update((current) =>
      current.map((order) =>
        order.order_id === orderId ? { ...order, last_incident_at: now, updated_at: now } : order
      ),
    );
    await updateDoc(doc(this.colRef, orderId), {
      last_incident_at: serverTimestamp(),
      updated_at: serverTimestamp(),
    });
    await this.logEvent(orderId, "INCIDENT_UPDATED", `Incidencia actualizada: ${incidentId}`, {
      incidentId,
      patch,
    }, actor);
  }

  async resolveIncident(orderId: string, incidentId: string, note?: string, resolvedBy = "admin") {
    const now = new Date().toISOString();
    await updateDoc(doc(FIRESTORE, "orders", orderId, "incidents", incidentId), {
      status: "resolved",
      resolvedBy,
      resolvedAt: serverTimestamp(),
      resolutionNote: note ?? "",
      updatedAt: serverTimestamp(),
    });

    const row = this.getById(orderId);
    const nextOpen = Math.max(0, (row?.open_incidents_count ?? 0) - 1);
    const incidents = await this.listIncidents(orderId);
    const hasHighOpen = incidents.some((inc) => inc.status === "open" && inc.severity === "high");
    this.updateIncidentSummary(orderId, -1, hasHighOpen, now);
    await updateDoc(doc(this.colRef, orderId), {
      open_incidents_count: nextOpen,
      has_high_incident: hasHighOpen,
      last_incident_at: serverTimestamp(),
      updated_at: serverTimestamp(),
    });

    await this.logEvent(orderId, "INCIDENT_RESOLVED", `Incidencia resuelta: ${incidentId}`, {
      incidentId,
      note: note ?? "",
    });
  }

  async uploadIncidentEvidence(orderId: string, incidentId: string, file: File, actor = "admin"): Promise<string> {
    const path = `incidents/${orderId}/${incidentId}/photo-${Date.now()}.jpg`;
    const storageRef = ref(STORAGE, path);
    await uploadBytes(storageRef, file);
    const url = await getDownloadURL(storageRef);
    await updateDoc(doc(FIRESTORE, "orders", orderId, "incidents", incidentId), {
      evidenceUrls: arrayUnion(url),
      updatedAt: serverTimestamp(),
    });
    await this.logEvent(orderId, "INCIDENT_UPDATED", `Evidencia agregada: ${incidentId}`, {
      incidentId,
      url,
    }, actor);
    const now = new Date().toISOString();
    this.rows.update((current) =>
      current.map((order) =>
        order.order_id === orderId ? { ...order, last_incident_at: now, updated_at: now } : order
      ),
    );
    await updateDoc(doc(this.colRef, orderId), {
      last_incident_at: serverTimestamp(),
      updated_at: serverTimestamp(),
    });
    return url;
  }

  async uploadOrderItemImage(orderId: string, itemId: string, file: File, actor = "admin"): Promise<string> {
    const path = `orders/${orderId}/items/${itemId}/photo-${Date.now()}.jpg`;
    const storageEntry = ref(STORAGE, path);
    await uploadBytes(storageEntry, file);
    const url = await getDownloadURL(storageEntry);
    const order = this.getById(orderId);
    if (!order) throw new Error("Order not found");
    let found = false;
    const nextItems = (order.items || []).map((item) => {
      if (item.item_id !== itemId) return item;
      found = true;
      return { ...item, image_url: url };
    });
    if (!found) throw new Error("Order item not found");
    await this.updateItems(orderId, nextItems);
    await this.logEvent(orderId, "ITEM_IMAGE_UPDATED", `Imagen actualizada para item ${itemId}`, {
      itemId,
      imageUrl: url,
    }, actor);
    return url;
  }

  async setShippingFee(orderId: string, shippingFee: number): Promise<void> {
    const safeShippingFee = Math.max(0, Number.isFinite(shippingFee) ? shippingFee : 0);
    const now = new Date().toISOString();
    let persistedTotals: Record<string, number> | null = null;
    this.rows.update((current) =>
      current.map((order) => {
        if (order.order_id !== orderId) return order;
        persistedTotals = toPersistedOrderTotals({
          ...order,
          totals: { ...order.totals, shipping_fee: safeShippingFee },
        });
        return {
          ...order,
          updated_at: now,
          totals: persistedTotals as unknown as OrderTotals,
        };
      }),
    );

    await updateDoc(doc(this.colRef, orderId), {
      ...(persistedTotals ? { totals: persistedTotals } : { "totals.shipping_fee": safeShippingFee }),
      updated_at: serverTimestamp(),
    });
  }

  async uploadOrderItemDraftImage(orderId: string, itemId: string, file: File): Promise<string> {
    const extension = file.type === "image/png" ? "png" : file.type === "image/webp" ? "webp" : "jpg";
    const path = `orders/${orderId}/items/${itemId}/draft-${Date.now()}.${extension}`;
    const storageEntry = ref(STORAGE, path);
    await uploadBytes(storageEntry, file, { contentType: file.type || "image/jpeg" });
    return getDownloadURL(storageEntry);
  }

  async listIncidents(orderId: string): Promise<Incident[]> {
    const snap = await getDocs(query(collection(FIRESTORE, "orders", orderId, "incidents"), orderBy("createdAt", "desc")));
    return snap.docs.map((docSnap) => {
      const data = docSnap.data() as any;
      const toIso = (val: any) => {
        if (!val) return new Date().toISOString();
        if (val.toDate) return val.toDate().toISOString();
        return String(val);
      };
      return {
        id: docSnap.id,
        orderId,
        packageId: data.packageId ?? null,
        itemId: data.itemId ?? null,
        type: data.type || "",
        severity: (data.severity as IncidentSeverity) || "low",
        status: (data.status as IncidentStatus) || "open",
        title: data.title || data.type || "",
        reason: data.reason || "",
        assigneeId: data.assigneeId ?? null,
        evidenceUrls: Array.isArray(data.evidenceUrls) ? data.evidenceUrls : [],
        createdBy: data.createdBy || "admin",
        createdAt: toIso(data.createdAt),
        updatedAt: data.updatedAt ? toIso(data.updatedAt) : toIso(data.createdAt),
        resolvedBy: data.resolvedBy ?? null,
        resolvedAt: data.resolvedAt ? toIso(data.resolvedAt) : null,
        resolutionNote: data.resolutionNote ?? null,
      } as Incident;
    });
  }

  async listEventsPage(orderId: string, pageSize = 20, cursor?: any): Promise<{ events: OrderEvent[]; cursor?: any }> {
    const base = collection(FIRESTORE, "orders", orderId, "events");
    const q = cursor
      ? query(base, orderBy("createdAt", "desc"), startAfter(cursor), limit(pageSize))
      : query(base, orderBy("createdAt", "desc"), limit(pageSize));
    const snap = await getDocs(q);
    const events = snap.docs.map((docSnap) => {
      const data = docSnap.data() as any;
      const toIso = (val: any) => {
        if (!val) return new Date().toISOString();
        if (val.toDate) return val.toDate().toISOString();
        return String(val);
      };
      return {
        id: docSnap.id,
        orderId,
        type: data.type || "",
        message: data.message || "",
        meta: data.meta ?? null,
        actor: data.actor
          ? data.actor
          : data.meta?.system
            ? { uid: "system", name: "Sistema" }
            : data.createdBy
              ? { uid: "legacy", name: data.createdBy }
              : { uid: "system", name: "Sistema" },
        createdAt: toIso(data.createdAt),
      } as OrderEvent;
    });
    const last = snap.docs[snap.docs.length - 1];
    return { events, cursor: last ? last.get("createdAt") : cursor };
  }

  async updateItemState(orderId: string, itemId: string, state: OrderItemState) {
    const order = this.getById(orderId);
    if (!order) throw new Error("Pedido no encontrado.");
    if (!order.items.some((item) => item.item_id === itemId)) throw new Error("Articulo no encontrado.");
    await this.persistItemPatchAuthoritatively(orderId, itemId, { state });
  }

  async addItem(orderId: string, item: OrderItem) {
    const nextItem = { ...item, item_id: item.item_id || `item-${Date.now()}` };
    const order = this.getById(orderId);
    if (!order) throw new Error("Pedido no encontrado.");
    try {
      const result = await lastValueFrom(this.adminApi.post<OrderItemsMutationResponse>(
        `/api/admin/orders/${encodeURIComponent(orderId)}/items`,
        buildOrderItemMutationRequest(nextItem),
      ));
      await this.mergeAuthoritativeItems(orderId, result.order);
    } catch (error) {
      if (!this.isIncrementalItemsEndpointUnavailable(error)) throw error;
      await this.persistItemsAuthoritatively(orderId, [...order.items, nextItem]);
    }
  }

  async updateItems(orderId: string, items: OrderItem[]) {
    await this.persistItemsAuthoritatively(orderId, items);
  }

  async updateItemConfirmationState(orderId: string, itemId: string, confirmation_state: OrderItem["confirmation_state"]) {
    const order = this.getById(orderId);
    if (!order) throw new Error("Pedido no encontrado.");
    if (!order.items.some((item) => item.item_id === itemId)) throw new Error("Articulo no encontrado.");
    await this.persistItemPatchAuthoritatively(orderId, itemId, { confirmation_state });
  }

  async updateItemConfirmation(
    orderId: string,
    itemId: string,
    payload: { confirmation_state: OrderItem["confirmation_state"]; confirmed_qty?: number | null },
  ) {
    const order = this.getById(orderId);
    if (!order) throw new Error("Pedido no encontrado.");
    if (!order.items.some((item) => item.item_id === itemId)) throw new Error("Articulo no encontrado.");
    await this.persistItemPatchAuthoritatively(orderId, itemId, {
      confirmation_state: payload.confirmation_state,
      confirmed_qty: payload.confirmed_qty ?? null,
    });
  }

  private async persistItemsAuthoritatively(orderId: string, items: OrderItem[]): Promise<void> {
    const result = await lastValueFrom(this.adminApi.put<OrderItemsMutationResponse>(`/api/admin/orders/${encodeURIComponent(orderId)}/items`, {
      ...buildOrderItemsUpdateRequest(items),
    }));
    await this.mergeAuthoritativeItems(orderId, result.order);
  }

  private async persistItemPatchAuthoritatively(
    orderId: string,
    itemId: string,
    patch: Partial<OrderItem>,
  ): Promise<void> {
    try {
      const result = await lastValueFrom(this.adminApi.patch<OrderItemsMutationResponse>(
        `/api/admin/orders/${encodeURIComponent(orderId)}/items/${encodeURIComponent(itemId)}`,
        buildOrderItemPatchRequest(patch),
      ));
      await this.mergeAuthoritativeItems(orderId, result.order);
    } catch (error) {
      if (!this.isIncrementalItemsEndpointUnavailable(error)) throw error;
      const order = this.getById(orderId);
      if (!order) throw new Error("Pedido no encontrado.");
      const items = order.items.map((item) => item.item_id === itemId ? { ...item, ...patch, item_id: itemId } : item);
      await this.persistItemsAuthoritatively(orderId, items);
    }
  }

  private async mergeAuthoritativeItems(orderId: string, authoritative: OrderItemsMutationResponse["order"]): Promise<void> {
    const currentOrder = this.getById(orderId);
    const shippingFee = Math.max(0, Number(currentOrder?.totals?.shipping_fee || 0));
    const mergedTotals = shippingFee > 0
      ? toPersistedOrderTotals({
          items: authoritative.items,
          totals: { ...authoritative.totals, shipping_fee: shippingFee },
        }) as unknown as OrderTotals
      : authoritative.totals;
    const merged = { ...authoritative, totals: mergedTotals };
    this.rows.update((current) => mergeAuthoritativeOrderItems(current, orderId, merged));
    if (shippingFee > 0) {
      await updateDoc(doc(this.colRef, orderId), { totals: mergedTotals }).catch(() => undefined);
    }
  }

  private isIncrementalItemsEndpointUnavailable(error: unknown): boolean {
    return error instanceof ApiError
      && (error.status === 405 || (error.status === 404 && error.code === null));
  }

  async createSupplierOrders(
    orderId: string,
    groups: { supplierId: string; supplierName?: string | null; eta?: string | null; items: SupplierOrderItem[] }[],
    createdBy = "admin"
  ) {
    const now = new Date().toISOString();
    const writes = groups.map((group) => {
      const supplierOrderId = `sup-${Date.now()}-${group.supplierId}`;
      const docRef = doc(FIRESTORE, "orders", orderId, "supplierOrders", supplierOrderId);
      const payload: SupplierOrder = {
        id: supplierOrderId,
        orderId,
        supplierId: group.supplierId,
        supplierName: group.supplierName ?? null,
        eta: group.eta ?? null,
        status: "created",
        createdAt: now,
        createdBy,
        items: group.items,
      };
      return setDoc(docRef, { ...payload, createdAt: serverTimestamp() });
    });
    await Promise.all(writes);
  }

  async listSupplierOrders(orderId: string): Promise<SupplierOrder[]> {
    const snap = await getDocs(query(collection(FIRESTORE, "orders", orderId, "supplierOrders"), orderBy("createdAt", "desc")));
    return snap.docs.map((docSnap) => {
      const data = docSnap.data() as any;
      const toIso = (val: any) => {
        if (!val) return new Date().toISOString();
        if (val.toDate) return val.toDate().toISOString();
        return String(val);
      };
      return {
        id: docSnap.id,
        orderId,
        supplierId: data.supplierId || "",
        supplierName: data.supplierName ?? null,
        eta: data.eta ?? null,
        status: data.status || "created",
        createdAt: toIso(data.createdAt),
        createdBy: data.createdBy || "admin",
        items: Array.isArray(data.items) ? data.items : [],
      } as SupplierOrder;
    });
  }

  async addPackage(orderId: string, pkg: PackageRecord) {
    const now = new Date().toISOString();
    this.rows.update((current) =>
      current.map((order) => {
        if (order.order_id !== orderId) return order;
        const nextPackages = [...order.packages, pkg];
        return { ...order, packages: nextPackages, updated_at: now };
      }),
    );
    const order = this.getById(orderId);
    if (order) {
      await updateDoc(doc(this.colRef, orderId), {
        packages: order.packages,
        updated_at: serverTimestamp(),
      });
    }
  }

  async updatePackages(orderId: string, packages: PackageRecord[]) {
    const now = new Date().toISOString();
    this.rows.update((current) =>
      current.map((order) =>
        order.order_id === orderId ? { ...order, packages, updated_at: now } : order
      ),
    );
    await updateDoc(doc(this.colRef, orderId), {
      packages,
      updated_at: serverTimestamp(),
    });
  }

  async markReadyForRoute(orderId: string, packagesCount: number) {
    const now = new Date().toISOString();
    const order = this.getById(orderId);
    if (!order) return;
    const nextDispatch = order.dispatch_request || { status: "none" as const };
    const next = {
      ...order,
      status: "ready_for_route" as OrderStatus,
      packing: {
        status: "done" as const,
        packages_count: Math.max(0, Math.trunc(packagesCount)),
        completed_at: now,
      },
      fulfillment_status: "packed_gdl" as OrderFulfillmentStatus,
      delivery_status: order.delivery_status || "pending" as OrderDeliveryStatus,
      current_holder_location: order.current_holder_location || "gdl" as OrderHolderLocation,
      dispatch_request: {
        status: (nextDispatch.status || "none") as "none" | "requested" | "accepted" | "rejected",
        requested_at: nextDispatch.requested_at ?? null,
        requested_by: nextDispatch.requested_by ?? null,
        note: nextDispatch.note ?? null,
      },
      updated_at: now,
    };
    this.rows.update((current) => current.map((row) => (row.order_id === orderId ? next : row)));
    await updateDoc(doc(this.colRef, orderId), {
      status: "ready_for_route",
      packing: {
        status: "done",
        packages_count: Math.max(0, Math.trunc(packagesCount)),
        completed_at: serverTimestamp(),
      },
      fulfillment_status: "packed_gdl",
      delivery_status: order.delivery_status || "pending",
      current_holder_location: order.current_holder_location || "gdl",
      updated_at: serverTimestamp(),
    });
  }

  async setPackageState(orderId: string, packageId: string, state: PackageRecord["state"]) {
    const now = new Date().toISOString();
    this.rows.update((current) =>
      current.map((order) => {
        if (order.order_id !== orderId) return order;
        return {
          ...order,
          packages: order.packages.map((pkg) => (pkg.package_id === packageId ? { ...pkg, state } : pkg)),
          updated_at: now,
        };
      }),
    );
    const order = this.getById(orderId);
    if (order) {
      await updateDoc(doc(this.colRef, orderId), {
        packages: order.packages,
        updated_at: serverTimestamp(),
      });
    }
  }

  /**
   * @param fallbackIso Valor provisional para fechas ausentes o pendientes de
   *   `serverTimestamp()`. El listener pasa el momento en que observó el
   *   snapshot, para que un pedido sin cambios conserve su valor entre
   *   snapshots. Sin él se usa la hora actual, como siempre.
   */
  private normalize(id: string, data: any, fallbackIso?: string): Order {
    const toIso = (val: any) => {
      if (!val) return fallbackIso ?? new Date().toISOString();
      if (val.toDate) return val.toDate().toISOString();
      return String(val);
    };
    return {
      order_id: id,
      created_by: normalizeOrderCreator(data.created_by),
      business_id: normalizeBusinessId(data.business_id),
      customer_id: data.customer_id || "",
      route_id: data.route_id ?? null,
      status: normalizeOrderStatus(data.status),
      planned_packages: data.planned_packages ?? null,
      open_incidents_count: data.open_incidents_count ?? 0,
      has_high_incident: data.has_high_incident ?? false,
      last_incident_at: data.last_incident_at ? toIso(data.last_incident_at) : null,
      last_event_at: data.last_event_at ? toIso(data.last_event_at) : null,
      created_at: toIso(data.created_at),
      audit_created_at: data.created_at ? toIso(data.created_at) : null,
      updated_at: toIso(data.updated_at),
      items: Array.isArray(data.items) ? data.items : [],
      packages: Array.isArray(data.packages) ? data.packages.map(normalizePackage) : [],
      timeline: Array.isArray(data.timeline) ? data.timeline : [],
      notes: data.notes || "",
      packing: {
        status: data.packing?.status === "done" ? "done" : "in_progress",
        packages_count: Number(data.packing?.packages_count ?? 0),
        completed_at: data.packing?.completed_at ? toIso(data.packing.completed_at) : null,
      },
      dispatch_request: {
        status: (data.dispatch_request?.status || "none") as "none" | "requested" | "accepted" | "rejected",
        requested_at: data.dispatch_request?.requested_at ? toIso(data.dispatch_request.requested_at) : null,
        requested_by: data.dispatch_request?.requested_by || null,
        note: data.dispatch_request?.note || null,
      },
      route_run_id: data.route_run_id ?? null,
      route_stop_id: data.route_stop_id ?? null,
      shipment_id: data.shipment_id ?? null,
      fulfillment_status: this.normalizeFulfillmentStatus(data.fulfillment_status, data),
      delivery_status: this.normalizeDeliveryStatus(data.delivery_status, data),
      customer_payment_status: this.normalizeCustomerPaymentStatus(data.customer_payment_status, data),
      settlement_status: this.normalizeSettlementStatus(data.settlement_status, data),
      current_holder_location: this.normalizeHolderLocation(data.current_holder_location, data),
      current_holder_user_id: data.current_holder_user_id ?? null,
      current_holder_name: data.current_holder_name ?? null,
      has_returns: Boolean(data.has_returns || (Array.isArray(data.items) && data.items.some((item: any) => Number(item?.returned_qty || 0) > 0))),
      delivered_at: data.delivered_at ? toIso(data.delivered_at) : null,
      paid_at: data.paid_at ? toIso(data.paid_at) : null,
      paid_at_quality: data.paid_at_quality === 'estimated' ? 'estimated' : null,
      closed_at: data.closed_at ? toIso(data.closed_at) : null,
      collection_status: this.normalizeCollectionStatus(data.collection_status),
      collection_reminder_at: data.collection_reminder_at ? toIso(data.collection_reminder_at) : null,
      collection_note: data.collection_note ? String(data.collection_note) : null,
      sales_note_last_generated_at: data.sales_note_last_generated_at ? toIso(data.sales_note_last_generated_at) : null,
      totals: {
        total_amount: Number(data.totals?.total_amount ?? 0),
        paid_amount: Number(data.totals?.paid_amount ?? 0),
        balance_due: Number(data.totals?.balance_due ?? 0),
        discount_amount: Number(data.totals?.discount_amount ?? 0),
        shipping_fee: Number(data.totals?.shipping_fee ?? 0),
        gross_amount: Number(data.totals?.gross_amount ?? data.totals?.total_amount ?? 0),
        returns_amount: Number(data.totals?.returns_amount ?? 0),
        net_amount: Number(data.totals?.net_amount ?? data.totals?.total_amount ?? 0),
        cost_amount: Number(data.totals?.cost_amount ?? 0),
        gross_profit: Number(data.totals?.gross_profit ?? 0),
        overpayment_amount: Number(data.totals?.overpayment_amount ?? 0),
      },
    };
  }

  private normalizeCollectionStatus(value: unknown): CollectionStatus {
    if (value === "pending" || value === "paid" || value === "remind_later") return value;
    return "none";
  }

  private normalizeFulfillmentStatus(value: unknown, data: any): OrderFulfillmentStatus {
    if (value === "pending" || value === "packing_gdl" || value === "packed_gdl" || value === "packing_durango" || value === "packed_durango") {
      return value;
    }
    // `pagado` no implica empaque ni entrega: puede ser un anticipo (RC-01).
    if (data?.packing?.status === "done" || data?.delivered_at || ["ready_for_route", "assigned_to_run", "in_transit", "delivered", "entregado", "closed"].includes(String(data?.status))) {
      return "packed_gdl";
    }
    if (["packing", "empaque"].includes(String(data?.status))) return "packing_gdl";
    return "pending";
  }


  private normalizeDeliveryStatus(value: unknown, data: any): OrderDeliveryStatus {
    if (value === "pending" || value === "delivered" || value === "not_delivered" || value === "incident") return value;
    const status = String(data?.status || "");
    // Sin `delivery_status` guardado, solo una fecha de entrega o un estado de entrega lo
    // demuestran. `pagado` sin fecha de entrega es cobro, no entrega (RC-01).
    if (data?.delivered_at || ["delivered", "entregado", "closed"].includes(status)) return "delivered";
    if (status === "delivered_partial") return "incident";
    return "pending";
  }

  private normalizeCustomerPaymentStatus(value: unknown, data: any): OrderCustomerPaymentStatus {
    if (value === "pending" || value === "partial" || value === "collected") return value;
    const paid = Number(data?.totals?.paid_amount || 0);
    const balance = Number(data?.totals?.balance_due || 0);
    if (paid <= 0) return "pending";
    return balance <= 0 ? "collected" : "partial";
  }

  private normalizeSettlementStatus(value: unknown, data: any): OrderSettlementStatus {
    if (value === "not_applicable" || value === "pending" || value === "sent_to_gdl" || value === "received" || value === "reconciled" || value === "difference") {
      return value;
    }
    const status = String(data?.status || "");
    const paid = Number(data?.totals?.paid_amount || 0);
    const balance = Number(data?.totals?.balance_due || 0);
    if (status === "closed" || (["pagado", "entregado"].includes(status) && paid > 0 && balance <= 0)) return "reconciled";
    return paid > 0 ? "pending" : "not_applicable";
  }

  /**
   * Quien tiene fisicamente el pedido. Unico campo de custodia: antes convivia
   * con `custody_status`, que guardaba lo mismo salvo que decia `shipment`
   * donde este dice `in_transit`. Se sigue leyendo el campo viejo para
   * documentos que la migracion todavia no toca.
   */
  private normalizeHolderLocation(value: unknown, data: any): OrderHolderLocation {
    if (value === "gdl" || value === "in_transit" || value === "durango" || value === "delivery_staff" || value === "customer" || value === "other") return value;

    const legacy = data?.custody_status;
    if (legacy === "shipment") return "in_transit";
    if (legacy === "gdl" || legacy === "durango" || legacy === "delivery_staff" || legacy === "customer") return legacy;

    const status = String(data?.status || "");
    if (data?.delivered_at || ["delivered", "entregado", "closed"].includes(status)) return "customer";
    if (data?.shipment_id) return "in_transit";
    if (data?.route_run_id || ["assigned_to_run", "in_transit", "en_ruta"].includes(status)) return "delivery_staff";
    return "gdl";
  }

  private deriveDeliveryStatus(order: Order | null): OrderDeliveryStatus {
    if (!order) return "pending";
    return this.normalizeDeliveryStatus(order.delivery_status, order);
  }

  private deriveCustomerPaymentStatus(order: Order | null): OrderCustomerPaymentStatus {
    if (!order) return "pending";
    return this.normalizeCustomerPaymentStatus(order.customer_payment_status, order);
  }

  private normalizeCollectionEvent(id: string, data: Record<string, any>): OrderCollectionEvent {
    const toIso = (value: any): string | null => {
      if (!value) return null;
      if (typeof value?.toDate === "function") return value.toDate().toISOString();
      return String(value);
    };
    const method = data["method"];
    const source = data["source_location"];
    const verification = data["verification_status"];
    const statusAfter = data["status_after"];
    const settlementAfter = data["settlement_status_after"];
    return {
      event_id: String(data["event_id"] || id),
      order_id: String(data["order_id"] || ""),
      business_id: normalizeBusinessId(data["business_id"]),
      account_id: data["account_id"] ? String(data["account_id"]) : null,
      amount: Number(data["amount"] || 0),
      method: method === "transferencia" || method === "tarjeta" || method === "otro" ? method : "efectivo",
      status_after: statusAfter === "partial" || statusAfter === "collected" ? statusAfter : "pending",
      settlement_status_after:
        settlementAfter === "sent_to_gdl" || settlementAfter === "received" || settlementAfter === "reconciled" || settlementAfter === "difference" || settlementAfter === "not_applicable"
          ? settlementAfter
          : "pending",
      source_location: source === "durango" || source === "other" ? source : "gdl",
      verification_status: verification === "reported" || verification === "rejected" || verification === "difference" ? verification : "confirmed",
      collected_by: data["collected_by"] || null,
      reported_by: data["reported_by"] || null,
      verified_by: data["verified_by"] || null,
      verified_at: toIso(data["verified_at"]),
      cash_occurred_at: toIso(data["cash_occurred_at"]),
      note: data["note"] || null,
      rejected_reason: data["rejected_reason"] || null,
      created_at: toIso(data["created_at"]),
    };
  }

  private currentActor(nameOverride?: string): { uid: string; name: string } {
    const user = FIREBASE_AUTH.currentUser;
    if (nameOverride) return { uid: user?.uid || "manual", name: nameOverride };
    return user ? { uid: user.uid, name: user.displayName || user.email || "Usuario" } : { uid: "system", name: "Sistema" };
  }
}

export interface OrderCollectionEvent {
  event_id: string;
  order_id: string;
  business_id: BusinessId;
  account_id?: string | null;
  amount: number;
  method: CollectionMethod;
  status_after: OrderCustomerPaymentStatus;
  settlement_status_after: OrderSettlementStatus;
  source_location: "gdl" | "durango" | "other";
  verification_status: OrderCollectionVerificationStatus;
  collected_by: { uid: string; name: string } | null;
  reported_by?: { uid: string; name: string } | null;
  verified_by?: { uid: string; name: string } | null;
  verified_at?: string | null;
  cash_occurred_at?: string | null;
  note?: string | null;
  rejected_reason?: string | null;
  created_at?: string | null;
}

export type RegisterCollectionOptions = {
  sourceLocation?: "gdl" | "durango" | "other";
  verificationStatus?: OrderCollectionVerificationStatus;
  reportedByName?: string | null;
  accountId?: string | null;
  discountAmount?: number | null;
};

/**
 * Inferencia del origen de un snapshot para las métricas (ver
 * `OrdersSnapshotInference`). Usa solo señales observables: primer snapshot,
 * `hasPendingWrites` de los documentos cambiados y si esos documentos tenían
 * escrituras pendientes en el snapshot anterior.
 */
function inferSnapshotCause(event: OrdersSnapshotEvent, initial: boolean, pendingIds: Set<string>): OrdersSnapshotInference {
  if (initial) return "initial";
  if (event.changes.some((change) => change.type !== "removed" && change.doc.metadata?.hasPendingWrites)) return "local_pending";
  if (event.changes.some((change) => pendingIds.has(change.doc.id))) return "pending_resolved";
  return "unattributed";
}

/** Actualiza qué documentos tienen escrituras locales sin confirmar tras un snapshot con cambios. */
function trackPendingDocs(event: OrdersSnapshotEvent, rebuilt: boolean, pendingIds: Set<string>): void {
  if (!event.hasPendingWrites) {
    pendingIds.clear();
    return;
  }
  if (rebuilt) {
    pendingIds.clear();
    for (const doc of event.docs()) if (doc.metadata?.hasPendingWrites) pendingIds.add(doc.id);
    return;
  }
  for (const change of event.changes) {
    if (change.type !== "removed" && change.doc.metadata?.hasPendingWrites) pendingIds.add(change.doc.id);
    else pendingIds.delete(change.doc.id);
  }
}
