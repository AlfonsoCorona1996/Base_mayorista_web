import { Injectable, computed, signal } from "@angular/core";
import {
  collection,
  doc,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  Unsubscribe,
} from "firebase/firestore";
import { ulid } from "ulid";
import { FIREBASE_AUTH, FIRESTORE } from "./firebase.providers";
import { BusinessId, normalizeBusinessId } from "./rbac.constants";

export type ShipmentStatus = "draft" | "sent" | "partial_received" | "received" | "closed";
export type ShipmentItemType = "package" | "loose_item";
export type ShipmentItemStatus = "pending" | "sent" | "received" | "packed" | "delivered" | "incident";
export type ShipmentLooseInstruction = "add_to_package" | "create_new_package";

export interface ShipmentItem {
  item_id: string;
  type: ShipmentItemType;
  status: ShipmentItemStatus;
  order_id: string;
  business_id: BusinessId;
  customer_id?: string | null;
  customer_name: string;
  package_id?: string | null;
  package_label?: string | null;
  title: string;
  quantity: number;
  contents?: Array<{ title: string; quantity: number; variant?: string | null; color?: string | null }>;
  instruction?: ShipmentLooseInstruction | null;
  target_package_id?: string | null;
  notes?: string | null;
}

export interface ShipmentBusinessSummary {
  business_id: BusinessId;
  orders_total: number;
  packages_total: number;
  loose_items_total: number;
  sale_total: number;
  balance_due: number;
}

export interface Shipment {
  shipment_id: string;
  status: ShipmentStatus;
  origin_location: "gdl" | "durango" | string;
  destination_location: "durango" | "gdl" | string;
  title: string;
  notes?: string | null;
  sent_at?: string | null;
  received_at?: string | null;
  closed_at?: string | null;
  created_by?: { uid: string; name: string } | null;
  created_at: string;
  updated_at: string;
  items: ShipmentItem[];
  business_summaries: ShipmentBusinessSummary[];
}

export type CreateShipmentInput = {
  title?: string | null;
  notes?: string | null;
  destination_location?: "durango" | "gdl" | string;
  items: ShipmentItem[];
  business_summaries?: ShipmentBusinessSummary[];
};

@Injectable({ providedIn: "root" })
export class ShipmentsService {
  private rowsState = signal<Shipment[]>([]);
  private loadingState = signal(true);
  private unsub: Unsubscribe | null = null;

  readonly rows = this.rowsState.asReadonly();
  readonly loading = this.loadingState.asReadonly();
  readonly activeShipments = computed(() => this.rowsState().filter((row) => row.status !== "closed"));

  watch(): void {
    if (this.unsub) return;
    this.loadingState.set(true);
    const q = query(collection(FIRESTORE, "shipments"), orderBy("created_at", "desc"));
    this.unsub = onSnapshot(
      q,
      (snap) => {
        this.rowsState.set(snap.docs.map((entry) => this.normalize(entry.id, entry.data())));
        this.loadingState.set(false);
      },
      () => this.loadingState.set(false),
    );
  }

  stop(): void {
    this.unsub?.();
    this.unsub = null;
  }

  getById(shipmentId: string): Shipment | null {
    return this.rowsState().find((row) => row.shipment_id === shipmentId) || null;
  }

  async createShipment(input: CreateShipmentInput): Promise<string> {
    const shipmentId = ulid();
    const now = new Date().toISOString();
    const user = FIREBASE_AUTH.currentUser;
    const items = input.items.map((item) => ({
      ...item,
      item_id: item.item_id || ulid(),
      business_id: normalizeBusinessId(item.business_id),
      status: item.status || "pending",
      notes: item.notes || null,
    }));
    const shipment: Shipment = {
      shipment_id: shipmentId,
      status: "draft",
      origin_location: "gdl",
      destination_location: input.destination_location || "durango",
      title: (input.title || "").trim() || `Embarque ${new Intl.DateTimeFormat("es-MX", { dateStyle: "medium" }).format(new Date())}`,
      notes: input.notes || null,
      created_by: user ? { uid: user.uid, name: user.displayName || user.email || "Usuario" } : { uid: "system", name: "Sistema" },
      created_at: now,
      updated_at: now,
      items,
      business_summaries: input.business_summaries?.length ? input.business_summaries : this.buildBusinessSummaries(items),
    };
    await setDoc(doc(FIRESTORE, "shipments", shipmentId), {
      ...shipment,
      created_at: serverTimestamp(),
      updated_at: serverTimestamp(),
    });
    return shipmentId;
  }

  async updateStatus(shipmentId: string, status: ShipmentStatus): Promise<void> {
    const patch: Record<string, unknown> = {
      status,
      updated_at: serverTimestamp(),
    };
    if (status === "sent") patch["sent_at"] = serverTimestamp();
    if (status === "received") patch["received_at"] = serverTimestamp();
    if (status === "closed") patch["closed_at"] = serverTimestamp();
    await updateDoc(doc(FIRESTORE, "shipments", shipmentId), patch);
  }

  async updateItemStatus(shipmentId: string, itemId: string, status: ShipmentItemStatus): Promise<void> {
    const shipment = this.getById(shipmentId);
    if (!shipment) return;
    const items = shipment.items.map((item) => (item.item_id === itemId ? { ...item, status } : item));
    const hasPending = items.some((item) => item.status === "pending" || item.status === "sent");
    const hasReceived = items.some((item) => item.status === "received" || item.status === "packed" || item.status === "delivered");
    const nextStatus: ShipmentStatus =
      shipment.status === "closed"
        ? "closed"
        : hasReceived && hasPending
          ? "partial_received"
          : hasReceived
            ? "received"
            : shipment.status;
    await updateDoc(doc(FIRESTORE, "shipments", shipmentId), {
      items,
      status: nextStatus,
      business_summaries: this.buildBusinessSummaries(items),
      updated_at: serverTimestamp(),
    });
  }

  async saveItems(shipmentId: string, items: ShipmentItem[]): Promise<void> {
    const normalized = items.map((item) => ({ ...item, business_id: normalizeBusinessId(item.business_id) }));
    await updateDoc(doc(FIRESTORE, "shipments", shipmentId), {
      items: normalized,
      business_summaries: this.buildBusinessSummaries(normalized),
      updated_at: serverTimestamp(),
    });
  }

  buildBusinessSummaries(items: ShipmentItem[]): ShipmentBusinessSummary[] {
    const map = new Map<BusinessId, ShipmentBusinessSummary>();
    for (const businessId of ["bm", "catalogo"] as BusinessId[]) {
      map.set(businessId, {
        business_id: businessId,
        orders_total: 0,
        packages_total: 0,
        loose_items_total: 0,
        sale_total: 0,
        balance_due: 0,
      });
    }
    const ordersByBusiness = new Map<BusinessId, Set<string>>();
    for (const item of items) {
      const businessId = normalizeBusinessId(item.business_id);
      const summary = map.get(businessId)!;
      if (!ordersByBusiness.has(businessId)) ordersByBusiness.set(businessId, new Set());
      if (item.order_id) ordersByBusiness.get(businessId)!.add(item.order_id);
      if (item.type === "package") summary.packages_total += 1;
      if (item.type === "loose_item") summary.loose_items_total += Number(item.quantity || 0);
    }
    for (const [businessId, orders] of ordersByBusiness.entries()) {
      map.get(businessId)!.orders_total = orders.size;
    }
    return Array.from(map.values()).filter(
      (row) => row.orders_total || row.packages_total || row.loose_items_total || row.sale_total || row.balance_due,
    );
  }

  private normalize(id: string, data: Record<string, any>): Shipment {
    const toIso = (value: any) => {
      if (!value) return null;
      if (value.toDate) return value.toDate().toISOString();
      return String(value);
    };
    const items = Array.isArray(data["items"]) ? data["items"].map((item: any) => this.normalizeItem(item)) : [];
    return {
      shipment_id: id,
      status: this.normalizeStatus(data["status"]),
      origin_location: data["origin_location"] || "gdl",
      destination_location: data["destination_location"] || "durango",
      title: String(data["title"] || "Embarque"),
      notes: data["notes"] || null,
      sent_at: toIso(data["sent_at"]),
      received_at: toIso(data["received_at"]),
      closed_at: toIso(data["closed_at"]),
      created_by: data["created_by"] || null,
      created_at: toIso(data["created_at"]) || new Date().toISOString(),
      updated_at: toIso(data["updated_at"]) || new Date().toISOString(),
      items,
      business_summaries: Array.isArray(data["business_summaries"])
        ? data["business_summaries"].map((row: any) => ({
            business_id: normalizeBusinessId(row?.business_id),
            orders_total: Number(row?.orders_total || 0),
            packages_total: Number(row?.packages_total || 0),
            loose_items_total: Number(row?.loose_items_total || 0),
            sale_total: Number(row?.sale_total || 0),
            balance_due: Number(row?.balance_due || 0),
          }))
        : this.buildBusinessSummaries(items),
    };
  }

  private normalizeItem(raw: any): ShipmentItem {
    return {
      item_id: String(raw?.item_id || ulid()),
      type: raw?.type === "loose_item" ? "loose_item" : "package",
      status: this.normalizeItemStatus(raw?.status),
      order_id: String(raw?.order_id || ""),
      business_id: normalizeBusinessId(raw?.business_id),
      customer_id: raw?.customer_id || null,
      customer_name: String(raw?.customer_name || "Clienta"),
      package_id: raw?.package_id || null,
      package_label: raw?.package_label || null,
      title: String(raw?.title || "Paquete"),
      quantity: Number(raw?.quantity || 1),
      contents: Array.isArray(raw?.contents) ? raw.contents : [],
      instruction: raw?.instruction === "add_to_package" || raw?.instruction === "create_new_package" ? raw.instruction : null,
      target_package_id: raw?.target_package_id || null,
      notes: raw?.notes || null,
    };
  }

  private normalizeStatus(value: unknown): ShipmentStatus {
    if (value === "sent" || value === "partial_received" || value === "received" || value === "closed") return value;
    return "draft";
  }

  private normalizeItemStatus(value: unknown): ShipmentItemStatus {
    if (value === "sent" || value === "received" || value === "packed" || value === "delivered" || value === "incident") return value;
    return "pending";
  }
}
