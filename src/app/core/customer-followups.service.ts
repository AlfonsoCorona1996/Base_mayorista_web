import { Injectable, inject, signal } from "@angular/core";
import { collection, doc, getDocs, query, serverTimestamp, setDoc, updateDoc, where } from "firebase/firestore";
import { FIREBASE_AUTH, FIRESTORE } from "./firebase.providers";
import { BusinessScopeService } from "./business-scope.service";
import { BusinessId, normalizeBusinessId } from "./rbac.constants";

export type CustomerFollowupType = "payment_reminder" | "post_sale" | "birthday" | "reactivation" | "quote" | "general_note";
export type CustomerFollowupStatus = "open" | "done" | "snoozed" | "canceled";

export interface CustomerFollowup {
  followup_id: string;
  business_id: BusinessId;
  customer_id: string;
  order_id: string | null;
  type: CustomerFollowupType;
  status: CustomerFollowupStatus;
  due_at: string;
  title: string;
  amount_due: number | null;
  note: string | null;
  source: string | null;
  created_by: string | null;
  created_at?: any;
  updated_at?: any;
  completed_at?: any;
}

export interface CustomerFollowupInput {
  followup_id?: string;
  business_id?: BusinessId | null;
  customer_id: string;
  order_id?: string | null;
  type: CustomerFollowupType;
  status?: CustomerFollowupStatus;
  due_at?: string | null;
  title: string;
  amount_due?: number | null;
  note?: string | null;
  source?: string | null;
}

@Injectable({ providedIn: "root" })
export class CustomerFollowupsService {
  private colRef = collection(FIRESTORE, "customer_followups");
  private businessScope = inject(BusinessScopeService);
  followups = signal<CustomerFollowup[]>([]);

  async loadFromFirestore(): Promise<void> {
    const businessIds = this.businessScope.availableBusinessIds();
    if (!businessIds.length) {
      this.followups.set([]);
      return;
    }

    let docs: Array<{ id: string; data: () => Record<string, unknown> }> = [];
    try {
      const snap = await getDocs(query(this.colRef, where("business_id", "in", businessIds)));
      docs = snap.docs as Array<{ id: string; data: () => Record<string, unknown> }>;
    } catch {
      docs = [];
    }

    const active = this.businessScope.activeBusinessIds();
    const rows = docs
      .map((entry) => this.normalize(entry.id, entry.data()))
      .filter((row) => active.includes(row.business_id))
      .sort((a, b) => this.dueTime(a.due_at) - this.dueTime(b.due_at));
    this.followups.set(rows);
  }

  list(): CustomerFollowup[] {
    return this.followups();
  }

  forCustomer(customerId: string): CustomerFollowup[] {
    return this.followups().filter((row) => row.customer_id === customerId);
  }

  openForCustomer(customerId: string): CustomerFollowup[] {
    return this.forCustomer(customerId).filter((row) => row.status === "open" || row.status === "snoozed");
  }

  async save(input: CustomerFollowupInput): Promise<CustomerFollowup> {
    const customerId = String(input.customer_id || "").trim();
    if (!customerId) throw new Error("customer_id requerido");
    const followupId = String(input.followup_id || `followup_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`).trim();
    const payload: CustomerFollowup = {
      followup_id: followupId,
      business_id: normalizeBusinessId(input.business_id || this.businessScope.writeBusinessId()),
      customer_id: customerId,
      order_id: input.order_id ? String(input.order_id) : null,
      type: input.type,
      status: input.status || "open",
      due_at: input.due_at || new Date().toISOString().slice(0, 10),
      title: String(input.title || "").trim() || "Seguimiento",
      amount_due: input.amount_due == null ? null : Math.max(0, Number(input.amount_due || 0)),
      note: input.note ? String(input.note).trim() : null,
      source: input.source ? String(input.source).trim() : null,
      created_by: FIREBASE_AUTH.currentUser?.uid || null,
      created_at: serverTimestamp(),
      updated_at: serverTimestamp(),
      completed_at: null,
    };

    await setDoc(doc(this.colRef, followupId), payload, { merge: true });
    this.followups.update((current) => this.upsert(current, payload));
    await this.loadFromFirestore();
    return payload;
  }

  async createPaymentReminder(input: {
    businessId: BusinessId;
    customerId: string;
    orderId: string;
    amountDue: number;
    dueAt?: string | null;
    note?: string | null;
    source?: string | null;
  }): Promise<CustomerFollowup> {
    return this.save({
      followup_id: `payment_${input.orderId}`,
      business_id: input.businessId,
      customer_id: input.customerId,
      order_id: input.orderId,
      type: "payment_reminder",
      status: "open",
      due_at: input.dueAt || new Date().toISOString().slice(0, 10),
      title: "Cobro pendiente",
      amount_due: input.amountDue,
      note: input.note || null,
      source: input.source || "sales_note",
    });
  }

  async completeFollowup(followupId: string): Promise<void> {
    await this.patchStatus(followupId, "done", { completed_at: serverTimestamp() });
  }

  async snoozeFollowup(followupId: string, dueAt: string): Promise<void> {
    await this.patchStatus(followupId, "snoozed", { due_at: dueAt });
  }

  async cancelFollowup(followupId: string): Promise<void> {
    await this.patchStatus(followupId, "canceled");
  }

  async completePaymentReminderForOrder(orderId: string): Promise<void> {
    const snap = await getDocs(query(this.colRef, where("order_id", "==", orderId)));
    const targets = snap.docs
      .map((entry) => this.normalize(entry.id, entry.data() as Record<string, unknown>))
      .filter((row) => row.type === "payment_reminder" && row.status !== "done" && row.status !== "canceled");
    await Promise.all(targets.map((row) => this.completeFollowup(row.followup_id)));
  }

  private async patchStatus(followupId: string, status: CustomerFollowupStatus, extra: Record<string, unknown> = {}): Promise<void> {
    await updateDoc(doc(this.colRef, followupId), {
      status,
      ...extra,
      updated_at: serverTimestamp(),
    });
    this.followups.update((current) =>
      current.map((row) => row.followup_id === followupId ? { ...row, status, ...extra, updated_at: new Date().toISOString() } : row),
    );
  }

  private normalize(id: string, data: Record<string, unknown>): CustomerFollowup {
    return {
      followup_id: String(data["followup_id"] || id),
      business_id: normalizeBusinessId(data["business_id"]),
      customer_id: String(data["customer_id"] || ""),
      order_id: data["order_id"] ? String(data["order_id"]) : null,
      type: this.normalizeType(data["type"]),
      status: this.normalizeStatus(data["status"]),
      due_at: this.toIsoDate(data["due_at"]),
      title: String(data["title"] || "Seguimiento"),
      amount_due: data["amount_due"] == null ? null : Number(data["amount_due"] || 0),
      note: data["note"] ? String(data["note"]) : null,
      source: data["source"] ? String(data["source"]) : null,
      created_by: data["created_by"] ? String(data["created_by"]) : null,
      created_at: data["created_at"] ?? null,
      updated_at: data["updated_at"] ?? null,
      completed_at: data["completed_at"] ?? null,
    };
  }

  private normalizeType(value: unknown): CustomerFollowupType {
    const safe = String(value || "");
    if (safe === "post_sale" || safe === "birthday" || safe === "reactivation" || safe === "quote" || safe === "general_note") return safe;
    return "payment_reminder";
  }

  private normalizeStatus(value: unknown): CustomerFollowupStatus {
    const safe = String(value || "");
    if (safe === "done" || safe === "snoozed" || safe === "canceled") return safe;
    return "open";
  }

  private toIsoDate(value: unknown): string {
    if (!value) return new Date().toISOString().slice(0, 10);
    if (typeof value === "object" && value && "toDate" in value && typeof (value as { toDate: () => Date }).toDate === "function") {
      return (value as { toDate: () => Date }).toDate().toISOString().slice(0, 10);
    }
    return String(value).slice(0, 10);
  }

  private dueTime(value: string): number {
    const time = new Date(value).getTime();
    return Number.isFinite(time) ? time : Number.MAX_SAFE_INTEGER;
  }

  private upsert(rows: CustomerFollowup[], next: CustomerFollowup): CustomerFollowup[] {
    const exists = rows.some((row) => row.followup_id === next.followup_id);
    return exists ? rows.map((row) => row.followup_id === next.followup_id ? next : row) : [next, ...rows];
  }
}
