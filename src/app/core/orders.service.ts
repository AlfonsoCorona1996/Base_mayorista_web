import { Injectable, computed, signal } from "@angular/core";
import { FIRESTORE } from "./firebase.providers";
import {
  arrayUnion,
  collection,
  doc,
  getDocs,
  limit,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  startAfter,
  updateDoc,
} from "firebase/firestore";
import { getDownloadURL, ref, uploadBytes } from "firebase/storage";
import { FIREBASE_AUTH, STORAGE } from "./firebase.providers";

export type OrderStatus =
  | "borrador"
  | "confirmando_proveedor"
  | "reservado_inventario"
  | "solicitado_proveedor"
  | "en_transito"
  | "recibido_qa"
  | "empaque"
  | "en_ruta"
  | "entregado"
  | "pago_pendiente"
  | "pagado"
  | "cancelado"
  | "devuelto";

export type OrderItemState = OrderStatus | "sin_estado";

export interface OrderItem {
  item_id: string;
  title: string;
  variant?: string | null;
  color?: string | null;
  quantity: number;
  source: "catalogo" | "inventario";
  state: OrderItemState;
  confirmation_state?: "confirmed" | "out_of_stock" | "substitute" | "pending";
  supplier_id?: string | null;
  product_id?: string | null;
  price_public?: number | null;
  price_cost?: number | null;
  discount_pct?: number | null;
  inventory_id?: string | null;
  image_url?: string | null;
}

export interface PackageRecord {
  package_id: string;
  label: string;
  sequence: number;
  total_packages: number;
  state: "armado" | "en_ruta" | "entregado" | "devuelto";
  amount_due: number | null;
  item_ids: string[];
  created_at: string;
}

export interface TimelineEntry {
  id: string;
  label: string;
  created_at: string;
  actor?: string;
}

export interface Order {
  order_id: string;
  customer_id: string;
  route_id: string | null;
  status: OrderStatus;
  planned_packages?: number | null;
  open_incidents_count?: number;
  has_high_incident?: boolean;
  last_incident_at?: string | null;
  last_event_at?: string | null;
  created_at: string;
  updated_at: string;
  items: OrderItem[];
  packages: PackageRecord[];
  timeline: TimelineEntry[];
  notes?: string;
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

@Injectable({ providedIn: "root" })
export class OrdersService {
  private colRef = collection(FIRESTORE, "orders");
  private rows = signal<Order[]>([]);
  loading = signal(false);

  list = computed(() => this.rows());

  async loadFromFirestore(): Promise<void> {
    this.loading.set(true);
    const q = query(this.colRef, orderBy("updated_at", "desc"));
    const snap = await getDocs(q);
    const rows: Order[] = snap.docs.map((d) => this.normalize(d.id, d.data() as any));
    this.rows.set(rows);
    this.loading.set(false);
  }

  async createDraft(customerId: string, routeId: string | null, notes?: string): Promise<string> {
    const now = new Date().toISOString();
    const orderId = `P-${Date.now()}`;
    const draft: Order = {
      order_id: orderId,
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
            state: "armado",
            amount_due: 1420,
            item_ids: ["item-1"],
            created_at: now,
          },
        ],
        timeline: [
          { id: "t1", label: "Pedido creado", created_at: now, actor: "admin" },
          { id: "t2", label: "Reservado en inventario", created_at: now, actor: "admin" },
        ],
      },
      {
        order_id: "P-2402",
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
      },
      {
        order_id: "P-2403",
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
      },
    ];

    this.rows.set(sample);
    this.loading.set(false);
  }

  getById(orderId: string): Order | null {
    return this.rows().find((o) => o.order_id === orderId) || null;
  }

  add(order: Order): string {
    const id = order.order_id || `P-${Date.now()}`;
    const next: Order = { ...order, order_id: id };
    this.rows.set([next, ...this.rows()]);
    return id;
  }

  async updateStatus(orderId: string, status: OrderStatus, note?: string) {
    const now = new Date().toISOString();
    this.rows.update((current) =>
      current.map((order) => {
        if (order.order_id !== orderId) return order;
        const updated: Order = {
          ...order,
          status,
          updated_at: now,
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
    const now = new Date().toISOString();
    this.rows.update((current) =>
      current.map((order) => {
        if (order.order_id !== orderId) return order;
        return {
          ...order,
          items: order.items.map((item) => (item.item_id === itemId ? { ...item, state } : item)),
          updated_at: now,
        };
      }),
    );
    const order = this.getById(orderId);
    if (order) {
      await updateDoc(doc(this.colRef, orderId), {
        items: order.items,
        updated_at: serverTimestamp(),
      });
    }
  }

  async addItem(orderId: string, item: OrderItem) {
    const nextItem = { ...item, item_id: item.item_id || `item-${Date.now()}` };
    const now = new Date().toISOString();
    this.rows.update((current) =>
      current.map((order) => {
        if (order.order_id !== orderId) return order;
        return {
          ...order,
          items: [...order.items, nextItem],
          updated_at: now,
        };
      }),
    );
    const order = this.getById(orderId);
    if (order) {
      await updateDoc(doc(this.colRef, orderId), {
        items: order.items,
        updated_at: serverTimestamp(),
      });
    }
  }

  async updateItems(orderId: string, items: OrderItem[]) {
    const now = new Date().toISOString();
    this.rows.update((current) =>
      current.map((order) =>
        order.order_id === orderId ? { ...order, items, updated_at: now } : order
      ),
    );
    await updateDoc(doc(this.colRef, orderId), {
      items,
      updated_at: serverTimestamp(),
    });
  }

  async updateItemConfirmationState(orderId: string, itemId: string, confirmation_state: OrderItem["confirmation_state"]) {
    const now = new Date().toISOString();
    this.rows.update((current) =>
      current.map((order) => {
        if (order.order_id !== orderId) return order;
        return {
          ...order,
          items: order.items.map((item) =>
            item.item_id === itemId ? { ...item, confirmation_state } : item
          ),
          updated_at: now,
        };
      }),
    );
    const order = this.getById(orderId);
    if (order) {
      await updateDoc(doc(this.colRef, orderId), {
        items: order.items,
        updated_at: serverTimestamp(),
      });
    }
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

  private normalize(id: string, data: any): Order {
    const toIso = (val: any) => {
      if (!val) return new Date().toISOString();
      if (val.toDate) return val.toDate().toISOString();
      return String(val);
    };
    return {
      order_id: id,
      customer_id: data.customer_id || "",
      route_id: data.route_id ?? null,
      status: (data.status as OrderStatus) || "borrador",
      planned_packages: data.planned_packages ?? null,
      open_incidents_count: data.open_incidents_count ?? 0,
      has_high_incident: data.has_high_incident ?? false,
      last_incident_at: data.last_incident_at ? toIso(data.last_incident_at) : null,
      last_event_at: data.last_event_at ? toIso(data.last_event_at) : null,
      created_at: toIso(data.created_at),
      updated_at: toIso(data.updated_at),
      items: Array.isArray(data.items) ? data.items : [],
      packages: Array.isArray(data.packages) ? data.packages : [],
      timeline: Array.isArray(data.timeline) ? data.timeline : [],
      notes: data.notes || "",
    };
  }
}
