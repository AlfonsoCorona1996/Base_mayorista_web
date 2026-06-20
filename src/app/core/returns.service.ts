import { Injectable, computed, inject, signal } from "@angular/core";
import {
  Unsubscribe,
  collection,
  doc,
  onSnapshot,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
} from "firebase/firestore";
import { FIRESTORE } from "./firebase.providers";
import { BusinessId, normalizeBusinessId } from "./rbac.constants";
import { BusinessScopeService } from "./business-scope.service";
import { InventoryService } from "./inventory.service";
import { Order, OrderItem } from "./orders.service";

export type ReturnDisposition = "available" | "review" | "damaged";
export type ReturnStatus = "restocked" | "pending_review" | "damaged";

export interface ReturnRecord {
  return_id: string;
  business_id: BusinessId;
  order_id: string;
  order_item_id: string;
  qty: number;
  disposition: ReturnDisposition;
  status: ReturnStatus;
  inventory_id: string | null;
  reason: string | null;
  product_snapshot: Record<string, unknown>;
  created_by: string | null;
  created_at?: unknown;
  updated_at?: unknown;
  restocked_at?: unknown;
}

export interface RegisterReturnInput {
  order: Order;
  item: OrderItem;
  qty: number;
  disposition: ReturnDisposition;
  reason?: string | null;
  createdBy?: string | null;
}

@Injectable({ providedIn: "root" })
export class ReturnsService {
  private colRef = collection(FIRESTORE, "returns");
  private businessScope = inject(BusinessScopeService);
  private inventory = inject(InventoryService);
  private unsubscribe: Unsubscribe | null = null;
  private rows = signal<ReturnRecord[]>([]);

  returns = computed(() => {
    const active = this.businessScope.activeBusinessIds();
    return this.rows().filter((row) => active.includes(row.business_id || "bm"));
  });

  pendingReview = computed(() => this.returns().filter((row) => row.status === "pending_review"));

  watch(): void {
    if (this.unsubscribe) return;
    this.unsubscribe = onSnapshot(
      query(this.colRef, where("business_id", "in", this.businessScope.availableBusinessIds())),
      (snap) => {
        const rows = snap.docs
          .map((entry) => this.normalize(entry.id, entry.data() as Record<string, unknown>))
          .sort((a, b) => this.toMillis(b.updated_at || b.created_at) - this.toMillis(a.updated_at || a.created_at));
        this.rows.set(rows);
      },
    );
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  async registerReturn(input: RegisterReturnInput): Promise<ReturnRecord> {
    const businessId = normalizeBusinessId(input.order.business_id);
    const qty = Math.max(1, Math.trunc(Number(input.qty) || 1));
    const returnId = `ret_${input.order.order_id}_${input.item.item_id}_${Date.now()}`;
    const inventoryId = this.buildInventoryId(businessId, input.item);
    const status = this.statusForDisposition(input.disposition);
    const ref = doc(this.colRef, returnId);
    const snapshot = this.productSnapshot(input.item);

    const record: ReturnRecord = {
      return_id: returnId,
      business_id: businessId,
      order_id: input.order.order_id,
      order_item_id: input.item.item_id,
      qty,
      disposition: input.disposition,
      status,
      inventory_id: input.disposition === "available" ? inventoryId : null,
      reason: input.reason?.trim() || null,
      product_snapshot: snapshot,
      created_by: input.createdBy || null,
    };

    await setDoc(ref, {
      ...record,
      created_at: serverTimestamp(),
      updated_at: serverTimestamp(),
      restocked_at: input.disposition === "available" ? serverTimestamp() : null,
    });

    if (input.disposition === "available") {
      await this.inventory.receiveReturn({
        inventoryId,
        business_id: businessId,
        qty,
        returnId,
        orderId: input.order.order_id,
        orderItemId: input.item.item_id,
        idempotencyKey: `return_${returnId}`,
        title: input.item.title,
        sku: String(input.item.product_id || input.item.inventory_id || inventoryId),
        supplier_id: input.item.supplier_id || null,
        variant_name: input.item.variant || null,
        color_name: input.item.color || null,
        unit_price: input.item.price_cost ?? input.item.price_clienta ?? input.item.price_public ?? null,
        image_url: input.item.image_url || null,
        notes: input.reason || `Devolución del pedido ${input.order.order_id}.`,
      });
    }

    return record;
  }

  async restockReturn(row: ReturnRecord): Promise<void> {
    if (row.status !== "pending_review") return;
    const inventoryId = row.inventory_id || this.buildInventoryId(row.business_id, row.product_snapshot);
    await this.inventory.receiveReturn({
      inventoryId,
      business_id: row.business_id,
      qty: row.qty,
      returnId: row.return_id,
      orderId: row.order_id,
      orderItemId: row.order_item_id,
      idempotencyKey: `return_${row.return_id}_review_restock`,
      title: String(row.product_snapshot["title"] || "Producto devuelto"),
      sku: String(row.product_snapshot["product_id"] || row.product_snapshot["inventory_id"] || inventoryId),
      supplier_id: this.nullableText(row.product_snapshot["supplier_id"]),
      variant_name: this.nullableText(row.product_snapshot["variant"]),
      color_name: this.nullableText(row.product_snapshot["color"]),
      unit_price: this.safePrice(row.product_snapshot["price_cost"] ?? row.product_snapshot["price_clienta"] ?? row.product_snapshot["price_public"]),
      image_url: this.nullableText(row.product_snapshot["image_url"]),
      notes: row.reason || `Devolución del pedido ${row.order_id}.`,
    });
    await updateDoc(doc(this.colRef, row.return_id), {
      status: "restocked",
      disposition: "available",
      inventory_id: inventoryId,
      restocked_at: serverTimestamp(),
      updated_at: serverTimestamp(),
    });
  }

  async markDamaged(row: ReturnRecord): Promise<void> {
    if (row.status !== "pending_review") return;
    await updateDoc(doc(this.colRef, row.return_id), {
      status: "damaged",
      disposition: "damaged",
      inventory_id: null,
      updated_at: serverTimestamp(),
    });
  }

  private normalize(id: string, data: Record<string, unknown>): ReturnRecord {
    return {
      return_id: String(data["return_id"] || id),
      business_id: normalizeBusinessId(data["business_id"]),
      order_id: String(data["order_id"] || ""),
      order_item_id: String(data["order_item_id"] || ""),
      qty: Math.max(0, Math.trunc(Number(data["qty"] || 0))),
      disposition: this.normalizeDisposition(data["disposition"]),
      status: this.normalizeStatus(data["status"]),
      inventory_id: this.nullableText(data["inventory_id"]),
      reason: this.nullableText(data["reason"]),
      product_snapshot: (data["product_snapshot"] || {}) as Record<string, unknown>,
      created_by: this.nullableText(data["created_by"]),
      created_at: data["created_at"] ?? null,
      updated_at: data["updated_at"] ?? null,
      restocked_at: data["restocked_at"] ?? null,
    };
  }

  private statusForDisposition(value: ReturnDisposition): ReturnStatus {
    if (value === "available") return "restocked";
    if (value === "damaged") return "damaged";
    return "pending_review";
  }

  private normalizeDisposition(value: unknown): ReturnDisposition {
    if (value === "available" || value === "damaged") return value;
    return "review";
  }

  private normalizeStatus(value: unknown): ReturnStatus {
    if (value === "restocked" || value === "damaged") return value;
    return "pending_review";
  }

  private productSnapshot(item: OrderItem | Record<string, unknown>): Record<string, unknown> {
    const source = item as Record<string, unknown>;
    return {
      item_id: String(source["item_id"] || ""),
      title: String(source["title"] || ""),
      variant: source["variant"] ?? null,
      color: source["color"] ?? null,
      source: source["source"] ?? null,
      business_id: source["business_id"] ?? null,
      product_ref_type: source["product_ref_type"] ?? null,
      supplier_id: source["supplier_id"] ?? null,
      product_id: source["product_id"] ?? null,
      inventory_id: source["inventory_id"] ?? null,
      price_clienta: source["price_clienta"] ?? null,
      price_public: source["price_public"] ?? null,
      price_cost: source["price_cost"] ?? null,
      image_url: source["image_url"] ?? null,
    };
  }

  private buildInventoryId(businessId: BusinessId, item: OrderItem | Record<string, unknown>): string {
    const source = item as Record<string, unknown>;
    const stable = [
      businessId,
      source["product_id"] || source["inventory_id"] || source["title"],
      source["variant"],
      source["color"],
    ]
      .map((part) => this.slugify(String(part || "")))
      .filter(Boolean)
      .join("-");
    return `ret-${stable || Date.now()}`;
  }

  private slugify(value: string): string {
    return String(value || "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80);
  }

  private nullableText(value: unknown): string | null {
    const text = String(value ?? "").trim();
    return text || null;
  }

  private safePrice(value: unknown): number | null {
    if (value === null || value === undefined || value === "") return null;
    const number = Number(value);
    return Number.isFinite(number) ? Math.max(0, Number(number.toFixed(2))) : null;
  }

  private toMillis(value: unknown): number {
    if (!value) return 0;
    if (typeof value === "object" && value !== null && typeof (value as { toMillis?: unknown }).toMillis === "function") {
      return (value as { toMillis: () => number }).toMillis();
    }
    if (typeof value === "object" && value !== null && typeof (value as { toDate?: unknown }).toDate === "function") {
      return (value as { toDate: () => Date }).toDate().getTime();
    }
    const parsed = new Date(String(value));
    return Number.isNaN(parsed.getTime()) ? 0 : parsed.getTime();
  }
}
