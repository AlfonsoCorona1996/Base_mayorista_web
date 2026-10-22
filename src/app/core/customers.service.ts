import { Injectable, InjectionToken, computed, inject, signal } from "@angular/core";
import { FIRESTORE } from "./firebase.providers";
import { QuerySnapshot, collection, doc, getDocs, orderBy, query, runTransaction, serverTimestamp, setDoc, updateDoc, where } from "firebase/firestore";
import { BusinessId, normalizeBusinessId } from "./rbac.constants";
import { BusinessScopeService } from "./business-scope.service";
import { calculateOrderFinancials, toPersistedOrderTotals } from "./order-financials";
import { statusAfterCollection } from "./order-closure";
import { LatestLoadGate, LoadTicket } from "./latest-load-gate";
import { PerfMetricsService, PerfSource, firebaseErrorCode } from "./perf-metrics.service";

export type OptInStatus = "opted_in" | "opted_out" | "unknown";
export type CommercialStage = "nueva" | "activa" | "frecuente" | "en_riesgo" | "inactiva" | "recuperada" | "prospecto";

export interface CustomerInsights {
  last_order_at: string | null;
  total_orders: number | null;
  total_spent: number | null;
  avg_order_value: number | null;
  avg_units_per_order: number | null;
  frequency_days: number | null;
  preferred_categories: string[];
  preferred_products: string[];
}

export interface CustomerOptIn {
  status: OptInStatus;
  source: string | null;
  collected_at: string | null;
}

export interface Customer {
  customer_id: string;
  business_id: BusinessId;
  first_name: string;
  last_name: string;
  whatsapp: string;
  route_id: string | null;
  locality_id: string | null;
  active: boolean;
  birthday?: string | null;
  address?: string;
  delivery_reference?: string;
  commercial_stage?: CommercialStage | null;
  preferred_sizes?: string[];
  preferred_categories?: string[];
  preferred_colors?: string[];
  source?: string;
  wa_opt_in_notes?: string;
  notes?: string;
  tags?: string[];
  insights?: CustomerInsights | null;
  opt_in?: CustomerOptIn | null;
  credit_balance?: number;
  follow_up_at?: string | null;
  created_at?: any;
  updated_at?: any;
}

export interface CustomerCreditMovement {
  movement_id: string;
  business_id: BusinessId;
  customer_id: string;
  type: "return_credit" | "application" | "refund" | "adjustment";
  amount: number;
  order_id: string | null;
  return_id: string | null;
  notes: string | null;
  created_at?: any;
}

/** Disponibilidad de un recurso cargado bajo demanda. */
export type DataLoadStatus = "idle" | "loading" | "ready" | "error";

export interface RawFirestoreDoc {
  id: string;
  data(): Record<string, unknown>;
}

export interface RawQueryResult {
  docs: RawFirestoreDoc[];
  fromCache: boolean;
}

/**
 * Lecturas de Firestore que usa CustomersService. Separadas en un token para
 * poder controlar en pruebas el orden y el resultado de cada consulta.
 */
export interface CustomersDataSource {
  /** Formato legado: incluye documentos que todavía no tienen business_id. */
  fetchAllCustomers(): Promise<RawQueryResult>;
  fetchCustomersByBusiness(businessIds: BusinessId[]): Promise<RawQueryResult>;
  fetchCreditMovements(businessIds: BusinessId[]): Promise<RawQueryResult>;
}

export const CUSTOMERS_DATA_SOURCE = new InjectionToken<CustomersDataSource>("CUSTOMERS_DATA_SOURCE", {
  providedIn: "root",
  factory: () => {
    const customersCol = collection(FIRESTORE, "customers");
    const creditCol = collection(FIRESTORE, "customer_credit_movements");
    const toResult = (snap: QuerySnapshot): RawQueryResult => ({ docs: snap.docs, fromCache: snap.metadata.fromCache });
    return {
      fetchAllCustomers: async () => toResult(await getDocs(query(customersCol, orderBy("first_name", "asc")))),
      fetchCustomersByBusiness: async (businessIds) => toResult(await getDocs(query(customersCol, where("business_id", "in", businessIds)))),
      fetchCreditMovements: async (businessIds) => toResult(await getDocs(query(creditCol, where("business_id", "in", businessIds)))),
    };
  },
});

interface StoredCustomer {
  customer: Customer;
  legacyWithoutBusiness: boolean;
}

export interface LoadOptions {
  /** Inicia una lectura nueva aunque haya otra en curso (la usa la carga completa). */
  force?: boolean;
}

@Injectable({ providedIn: "root" })
export class CustomersService {
  private colRef = collection(FIRESTORE, "customers");
  private creditMovementsCol = collection(FIRESTORE, "customer_credit_movements");
  private businessScope = inject(BusinessScopeService);
  private dataSource = inject(CUSTOMERS_DATA_SOURCE);
  private perf = inject(PerfMetricsService);

  // Se guarda todo lo autorizado y se filtra al negocio activo al leer: cambiar de
  // negocio no necesita otra consulta ni deja clientas del ámbito anterior.
  private customerRows = signal<StoredCustomer[]>([]);
  private creditRows = signal<CustomerCreditMovement[]>([]);

  /** Clientas del negocio activo (los documentos legados sin business_id se conservan). */
  readonly customers = computed<Customer[]>(() => {
    const active = this.businessScope.activeBusinessIds();
    return this.customerRows()
      .filter((row) => row.legacyWithoutBusiness || active.includes(row.customer.business_id))
      .map((row) => row.customer);
  });

  /** Movimientos de saldo a favor del negocio activo. */
  readonly creditMovements = computed<CustomerCreditMovement[]>(() => {
    const active = this.businessScope.activeBusinessIds();
    return this.creditRows().filter((row) => active.includes(row.business_id));
  });

  /** Estado de la última lectura de clientas básicas. */
  readonly customersStatus = signal<DataLoadStatus>("idle");
  readonly customersError = signal<string | null>(null);
  /** Hay un resultado exitoso publicado para los negocios autorizados vigentes. */
  readonly customersLoaded = signal(false);
  /** Origen del último resultado publicado según Firestore. */
  readonly customersSource = signal<"cache" | "server" | null>(null);

  /** Estado de la última lectura del historial de saldo a favor. */
  readonly creditStatus = signal<DataLoadStatus>("idle");
  readonly creditError = signal<string | null>(null);
  readonly creditLoaded = signal(false);

  private customersGate = new LatestLoadGate();
  private creditGate = new LatestLoadGate();
  private customersKey: string | null = null;
  private creditKey: string | null = null;

  /**
   * Carga completa con el contrato histórico: clientas + historial de saldo a favor.
   *
   * - Como antes, siempre hace lecturas nuevas: nunca reutiliza una lectura iniciada
   *   antes (p. ej. antes de que otra pantalla registrara una devolución con saldo).
   * - Las clientas se publican en cuanto termina su consulta; ya no esperan al ledger.
   * - La promesa resuelve cuando ambas lecturas terminaron, así que quien la espera
   *   sigue recibiendo datos completos (p. ej. la ficha de clienta).
   * - Rechaza si fallan las clientas, como antes. Un fallo del ledger tampoco rechaza
   *   (antes se silenciaba igual), pero ahora queda en `creditStatus`/`creditError`.
   */
  async loadFromFirestore(): Promise<void> {
    const customers = this.loadCustomers({ force: true });
    const credit = this.loadCreditMovements({ force: true }).catch(() => undefined);
    await Promise.all([customers, credit]);
  }

  /**
   * Solo clientas básicas (nombre, WhatsApp, ruta, saldo de la ficha). Es lo que
   * necesitan el buscador y los nombres de Pedidos. Comparte la lectura en curso.
   */
  loadCustomers(options: LoadOptions = {}): Promise<void> {
    const businessIds = this.businessScope.availableBusinessIds();
    const key = businessIds.join("|");
    return this.customersGate.run(key, options.force === true, (ticket) =>
      this.fetchAndPublishCustomers(businessIds, key, ticket),
    );
  }

  /** Solo el historial de movimientos de saldo a favor. Comparte la lectura en curso. */
  loadCreditMovements(options: LoadOptions = {}): Promise<void> {
    const businessIds = this.businessScope.availableBusinessIds();
    const key = businessIds.join("|");
    return this.creditGate.run(key, options.force === true, (ticket) =>
      this.fetchAndPublishCredit(businessIds, key, ticket),
    );
  }

  private async fetchAndPublishCustomers(businessIds: BusinessId[], key: string, ticket: LoadTicket): Promise<void> {
    const loadId = this.perf.newLoadId("customers");
    const startedAt = this.perf.now();
    if (this.customersKey !== null && this.customersKey !== key) {
      // Cambiaron los negocios autorizados: no se conserva nada leído con el permiso anterior.
      this.customerRows.set([]);
      this.customersLoaded.set(false);
      this.customersSource.set(null);
      this.customersKey = null;
    }
    this.customersStatus.set("loading");
    this.customersError.set(null);

    let result: RawQueryResult;
    try {
      result = await this.queryCustomers(businessIds, loadId, ticket.isCurrent);
    } catch (error) {
      // El fallo de una carga ya reemplazada no se muestra: se espera a la vigente.
      if (!ticket.isCurrent()) return this.customersGate.latest() ?? undefined;
      this.customersStatus.set("error");
      this.customersError.set("No se pudieron cargar las clientas.");
      this.perf.record("customers_publish_ms", startedAt, { result: "error", load_id: loadId, error_code: firebaseErrorCode(error) });
      throw error;
    }
    // Una carga posterior ya publicó: esta respuesta, más vieja, no debe sobrescribirla.
    if (!ticket.claimPublish()) return this.customersGate.latest() ?? undefined;

    const rows = result.docs
      .map((entry) => {
        const data = entry.data() as Partial<Customer>;
        return { customer: this.normalizeCustomer(data, entry.id), legacyWithoutBusiness: !data.business_id };
      })
      .sort((a, b) => a.customer.first_name.localeCompare(b.customer.first_name, "es"));

    this.customerRows.set(rows);
    this.customersKey = key;
    this.customersLoaded.set(true);
    this.customersSource.set(result.fromCache ? "cache" : "server");
    this.customersStatus.set("ready");
    this.customersError.set(null);
    this.perf.record("customers_publish_ms", startedAt, {
      result: "success",
      load_id: loadId,
      source: result.fromCache ? "cache" : "server",
      docs: rows.length,
      docs_in_scope: this.customers().length,
    });
  }

  // Primero leemos el formato legado: esos documentos aún no tienen business_id.
  // Cuando las reglas V2 ya estén desplegadas, la consulta acotada es el fallback seguro.
  private async queryCustomers(businessIds: BusinessId[], loadId: string, isCurrent: () => boolean): Promise<RawQueryResult> {
    const legacyStartedAt = this.perf.now();
    try {
      const result = await this.dataSource.fetchAllCustomers();
      this.perf.record("customers_query_ms", legacyStartedAt, this.querySuccess(loadId, "legacy", result));
      return result;
    } catch (legacyError) {
      this.perf.record("customers_query_ms", legacyStartedAt, {
        result: "error", load_id: loadId, attempt: "legacy", error_code: firebaseErrorCode(legacyError),
      });
      // Una carga ya reemplazada no gasta otra lectura en el fallback.
      if (!isCurrent()) throw legacyError;
    }

    const scopedStartedAt = this.perf.now();
    try {
      const result = await this.dataSource.fetchCustomersByBusiness(businessIds);
      this.perf.record("customers_query_ms", scopedStartedAt, this.querySuccess(loadId, "business_scope", result));
      return result;
    } catch (error) {
      this.perf.record("customers_query_ms", scopedStartedAt, {
        result: "error", load_id: loadId, attempt: "business_scope", error_code: firebaseErrorCode(error),
      });
      throw error;
    }
  }

  private async fetchAndPublishCredit(businessIds: BusinessId[], key: string, ticket: LoadTicket): Promise<void> {
    const loadId = this.perf.newLoadId("credit");
    const startedAt = this.perf.now();
    if (this.creditKey !== null && this.creditKey !== key) {
      this.creditRows.set([]);
      this.creditLoaded.set(false);
      this.creditKey = null;
    }
    this.creditStatus.set("loading");
    this.creditError.set(null);

    let result: RawQueryResult;
    try {
      result = await this.dataSource.fetchCreditMovements(businessIds);
    } catch (error) {
      if (!ticket.isCurrent()) return this.creditGate.latest() ?? undefined;
      // Se conservan los movimientos ya publicados para este mismo ámbito; el estado
      // de error indica que pueden no estar actualizados.
      this.creditStatus.set("error");
      this.creditError.set("No se pudo cargar el historial de saldo a favor.");
      this.perf.record("customer_credit_query_ms", startedAt, { result: "error", load_id: loadId, error_code: firebaseErrorCode(error) });
      throw error;
    }
    if (!ticket.claimPublish()) return this.creditGate.latest() ?? undefined;

    const rows = result.docs.map((entry) => {
      const data = entry.data();
      return {
        movement_id: String(data["movement_id"] || entry.id),
        business_id: normalizeBusinessId(data["business_id"]),
        customer_id: String(data["customer_id"] || ""),
        type: this.normalizeCreditType(data["type"]),
        amount: Number(data["amount"] || 0),
        order_id: data["order_id"] ? String(data["order_id"]) : null,
        return_id: data["return_id"] ? String(data["return_id"]) : null,
        notes: data["notes"] ? String(data["notes"]) : null,
        created_at: data["created_at"] ?? null,
      };
    });
    this.creditRows.set(rows);
    this.creditKey = key;
    this.creditLoaded.set(true);
    this.creditStatus.set("ready");
    this.creditError.set(null);
    this.perf.record("customer_credit_query_ms", startedAt, {
      result: "success",
      load_id: loadId,
      source: result.fromCache ? "cache" : "server",
      docs: rows.length,
      docs_in_scope: this.creditMovements().length,
    });
  }

  private querySuccess(loadId: string, attempt: "legacy" | "business_scope", result: RawQueryResult) {
    const source: PerfSource = result.fromCache ? "cache" : "server";
    return { result: "success" as const, load_id: loadId, attempt, source, docs: result.docs.length };
  }

  getActive(): Customer[] {
    return this.customers().filter((customer) => customer.active);
  }

  getById(id: string): Customer | null {
    return this.customers().find((customer) => customer.customer_id === id) || null;
  }

  async save(customer: Customer): Promise<void> {
    const customerId = (customer.customer_id || "").trim();
    if (!customerId) throw new Error("customer_id requerido");

    const now = serverTimestamp();
    const payload: Customer = {
      ...customer,
      customer_id: customerId,
      business_id: normalizeBusinessId(customer.business_id || this.businessScope.writeBusinessId()),
      first_name: (customer.first_name || "").trim(),
      last_name: (customer.last_name || "").trim(),
      whatsapp: (customer.whatsapp || "").trim(),
      route_id: customer.route_id || null,
      locality_id: customer.locality_id || null,
      active: customer.active ?? true,
      birthday: this.cleanString(customer.birthday) || null,
      address: this.cleanString(customer.address),
      delivery_reference: this.cleanString(customer.delivery_reference),
      commercial_stage: this.normalizeCommercialStage(customer.commercial_stage),
      preferred_sizes: this.normalizeList(customer.preferred_sizes),
      preferred_categories: this.normalizeList(customer.preferred_categories),
      preferred_colors: this.normalizeList(customer.preferred_colors),
      source: this.cleanString(customer.source),
      wa_opt_in_notes: this.cleanString(customer.wa_opt_in_notes),
      notes: customer.notes || "",
      tags: Array.isArray(customer.tags) ? customer.tags.filter(Boolean) : [],
      insights: customer.insights ?? null,
      opt_in: customer.opt_in ?? { status: "unknown", source: null, collected_at: null },
      credit_balance: Math.max(0, Number(customer.credit_balance || 0)),
      follow_up_at: customer.follow_up_at || null,
      created_at: customer.created_at ?? now,
      updated_at: now,
    };

    await setDoc(doc(this.colRef, customerId), payload, { merge: true });
    await this.loadFromFirestore();
  }

  async setActive(customerId: string, active: boolean): Promise<void> {
    await updateDoc(doc(this.colRef, customerId), {
      active,
      updated_at: serverTimestamp(),
    });
    await this.loadFromFirestore();
  }

  creditMovementsFor(customerId: string): CustomerCreditMovement[] {
    return this.creditMovements().filter((row) => row.customer_id === customerId);
  }

  async applyCreditToOrder(customerId: string, orderId: string, requestedAmount?: number): Promise<number> {
    const customerRef = doc(this.colRef, customerId);
    const orderRef = doc(FIRESTORE, "orders", orderId);
    const movementRef = doc(this.creditMovementsCol, `application_${orderId}_${Date.now()}`);
    const applied = await runTransaction(FIRESTORE, async (tx) => {
      const [customerSnap, orderSnap] = await Promise.all([tx.get(customerRef), tx.get(orderRef)]);
      if (!customerSnap.exists() || !orderSnap.exists()) throw new Error("No se encontró la clienta o el pedido.");
      const customerData = customerSnap.data() as Record<string, any>;
      const orderData = orderSnap.data() as Record<string, any>;
      const available = Math.max(0, Number(customerData["credit_balance"] || 0));
      const financials = calculateOrderFinancials(orderData);
      const amount = Math.min(available, financials.balanceDue, Math.max(0, Number(requestedAmount ?? financials.balanceDue)));
      if (amount <= 0) throw new Error("No hay saldo a favor aplicable a este pedido.");
      const paidAmount = Number((financials.paidAmount + amount).toFixed(2));
      const totals = toPersistedOrderTotals({ ...orderData, totals: { ...(orderData["totals"] || {}), paid_amount: paidAmount } });
      // Aplicar saldo a favor es cobro, no entrega (RC-01/RC-04): antes de entregar se
      // conserva la etapa operativa del pedido destino.
      const nextStatus = statusAfterCollection(
        { ...orderData, totals },
        totals["balance_due"] <= 0 ? "collected" : "partial",
      );
      tx.update(customerRef, { credit_balance: Number((available - amount).toFixed(2)), updated_at: serverTimestamp() });
      tx.update(orderRef, {
        totals,
        status: nextStatus,
        customer_payment_status: totals["balance_due"] <= 0 ? "collected" : "partial",
        paid_at: totals["balance_due"] <= 0 ? serverTimestamp() : orderData["paid_at"] || null,
        collection_status: totals["balance_due"] <= 0 ? "paid" : "pending",
        collection_reminder_at: totals["balance_due"] <= 0 ? null : orderData["collection_reminder_at"] || null,
        collection_note: totals["balance_due"] <= 0 ? "Cobro liquidado al aplicar saldo a favor." : orderData["collection_note"] || null,
        updated_at: serverTimestamp(),
      });
      tx.set(movementRef, {
        movement_id: movementRef.id,
        business_id: normalizeBusinessId(customerData["business_id"]),
        customer_id: customerId,
        type: "application",
        amount: -amount,
        order_id: orderId,
        return_id: null,
        notes: "Saldo a favor aplicado al pedido",
        created_at: serverTimestamp(),
      });
      return amount;
    });
    await this.loadFromFirestore();
    return applied;
  }

  private normalizeCreditType(value: unknown): CustomerCreditMovement["type"] {
    if (value === "application" || value === "refund" || value === "adjustment") return value;
    return "return_credit";
  }

  private normalizeCustomer(data: Partial<Customer>, fallbackId: string): Customer {
    const customerId = (data.customer_id || fallbackId || "").trim();

    return {
      customer_id: customerId,
      business_id: normalizeBusinessId(data.business_id),
      first_name: (data.first_name || "").trim(),
      last_name: (data.last_name || "").trim(),
      whatsapp: (data.whatsapp || "").trim(),
      route_id: data.route_id || null,
      locality_id: data.locality_id || null,
      active: data.active ?? true,
      birthday: this.cleanString(data.birthday) || null,
      address: this.cleanString(data.address),
      delivery_reference: this.cleanString(data.delivery_reference),
      commercial_stage: this.normalizeCommercialStage(data.commercial_stage),
      preferred_sizes: this.normalizeList(data.preferred_sizes),
      preferred_categories: this.normalizeList(data.preferred_categories),
      preferred_colors: this.normalizeList(data.preferred_colors),
      source: this.cleanString(data.source),
      wa_opt_in_notes: this.cleanString(data.wa_opt_in_notes),
      notes: data.notes || "",
      tags: Array.isArray(data.tags) ? data.tags.filter(Boolean) : [],
      insights: data.insights || null,
      opt_in: data.opt_in || { status: "unknown", source: null, collected_at: null },
      credit_balance: Math.max(0, Number(data.credit_balance || 0)),
      follow_up_at: data.follow_up_at || null,
      created_at: data.created_at ?? null,
      updated_at: data.updated_at ?? null,
    };
  }

  private cleanString(value: unknown): string {
    return String(value || "").trim();
  }

  private normalizeList(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    return value.map((entry) => String(entry || "").trim()).filter(Boolean);
  }

  private normalizeCommercialStage(value: unknown): CommercialStage | null {
    const safe = String(value || "").trim();
    const allowed: CommercialStage[] = ["nueva", "activa", "frecuente", "en_riesgo", "inactiva", "recuperada", "prospecto"];
    return allowed.includes(safe as CommercialStage) ? (safe as CommercialStage) : null;
  }
}
