import { Injectable, inject, signal } from "@angular/core";
import { FIRESTORE } from "./firebase.providers";
import { collection, doc, getDocs, orderBy, query, runTransaction, serverTimestamp, setDoc, updateDoc, where } from "firebase/firestore";
import { BusinessId, normalizeBusinessId } from "./rbac.constants";
import { BusinessScopeService } from "./business-scope.service";
import { calculateOrderFinancials, toPersistedOrderTotals } from "./order-financials";

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

@Injectable({ providedIn: "root" })
export class CustomersService {
  private colRef = collection(FIRESTORE, "customers");
  private creditMovementsCol = collection(FIRESTORE, "customer_credit_movements");
  customers = signal<Customer[]>([]);
  creditMovements = signal<CustomerCreditMovement[]>([]);
  private businessScope = inject(BusinessScopeService);

  async loadFromFirestore(): Promise<void> {
    // Primero leemos el formato legado: esos documentos aún no tienen business_id.
    // Cuando las reglas V2 ya estén desplegadas, la consulta acotada es el fallback seguro.
    let snap;
    try {
      snap = await getDocs(query(this.colRef, orderBy("first_name", "asc")));
    } catch {
      snap = await getDocs(query(this.colRef, where("business_id", "in", this.businessScope.availableBusinessIds())));
    }

    let creditDocs: Array<{ id: string; data: () => Record<string, unknown> }> = [];
    try {
      const creditSnap = await getDocs(query(this.creditMovementsCol, where("business_id", "in", this.businessScope.availableBusinessIds())));
      creditDocs = creditSnap.docs as Array<{ id: string; data: () => Record<string, unknown> }>;
    } catch {
      // El ledger es nuevo y no debe impedir que carguen las clientas antiguas.
      creditDocs = [];
    }

    const normalizedRows = snap.docs.map((entry) => {
      const data = entry.data() as Partial<Customer>;
      return { customer: this.normalizeCustomer(data, entry.id), legacyWithoutBusiness: !data.business_id };
    }).sort((a, b) => a.customer.first_name.localeCompare(b.customer.first_name, "es"));

    const active = this.businessScope.activeBusinessIds();
    this.customers.set(normalizedRows
      .filter((row) => row.legacyWithoutBusiness || active.includes(row.customer.business_id))
      .map((row) => row.customer));
    this.creditMovements.set(creditDocs.map((entry) => {
      const data = entry.data() as Record<string, unknown>;
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
    }).filter((row) => active.includes(row.business_id)));
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
      const nextStatus = totals["balance_due"] <= 0 ? "pagado" : "pagado_parcial";
      tx.update(customerRef, { credit_balance: Number((available - amount).toFixed(2)), updated_at: serverTimestamp() });
      tx.update(orderRef, {
        totals,
        status: nextStatus,
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
