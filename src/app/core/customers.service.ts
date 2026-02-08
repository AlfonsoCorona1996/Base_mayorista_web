import { Injectable, signal } from "@angular/core";
import { FIRESTORE } from "./firebase.providers";
import { collection, doc, getDocs, orderBy, query, serverTimestamp, setDoc, updateDoc } from "firebase/firestore";

export type OptInStatus = "opted_in" | "opted_out" | "unknown";

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
  first_name: string;
  last_name: string;
  whatsapp: string;
  route_id: string | null;
  locality_id: string | null;
  active: boolean;
  notes?: string;
  tags?: string[];
  insights?: CustomerInsights | null;
  opt_in?: CustomerOptIn | null;
  created_at?: any;
  updated_at?: any;
}

@Injectable({ providedIn: "root" })
export class CustomersService {
  private colRef = collection(FIRESTORE, "customers");
  customers = signal<Customer[]>([]);

  async loadFromFirestore(): Promise<void> {
    const q = query(this.colRef, orderBy("first_name", "asc"));
    const snap = await getDocs(q);

    const rows = snap.docs.map((entry) => {
      const data = entry.data() as Partial<Customer>;
      return this.normalizeCustomer(data, entry.id);
    });

    this.customers.set(rows);
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
      first_name: (customer.first_name || "").trim(),
      last_name: (customer.last_name || "").trim(),
      whatsapp: (customer.whatsapp || "").trim(),
      route_id: customer.route_id || null,
      locality_id: customer.locality_id || null,
      active: customer.active ?? true,
      notes: customer.notes || "",
      tags: Array.isArray(customer.tags) ? customer.tags.filter(Boolean) : [],
      insights: customer.insights ?? null,
      opt_in: customer.opt_in ?? { status: "unknown", source: null, collected_at: null },
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

  private normalizeCustomer(data: Partial<Customer>, fallbackId: string): Customer {
    const customerId = (data.customer_id || fallbackId || "").trim();

    return {
      customer_id: customerId,
      first_name: (data.first_name || "").trim(),
      last_name: (data.last_name || "").trim(),
      whatsapp: (data.whatsapp || "").trim(),
      route_id: data.route_id || null,
      locality_id: data.locality_id || null,
      active: data.active ?? true,
      notes: data.notes || "",
      tags: Array.isArray(data.tags) ? data.tags.filter(Boolean) : [],
      insights: data.insights || null,
      opt_in: data.opt_in || { status: "unknown", source: null, collected_at: null },
      created_at: data.created_at ?? null,
      updated_at: data.updated_at ?? null,
    };
  }
}
