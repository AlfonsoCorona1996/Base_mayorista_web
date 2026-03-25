import { Injectable } from "@angular/core";
import {
  Timestamp,
  collection,
  doc,
  getDoc,
  getDocs,
  orderBy,
  query,
  runTransaction,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
} from "firebase/firestore";
import { ulid } from "ulid";
import { FIRESTORE } from "../core/firebase.providers";

export type RouteRunStatus = "draft" | "scheduled" | "in_transit" | "completed" | "cancelled";
export type DispatchRequestStatus = "none" | "requested" | "accepted" | "rejected";
export type StopStatus = "pending" | "delivered" | "partial" | "failed";

export interface RunCounts {
  orders_total: number;
  packages_total: number;
  balance_total: number;
}

export interface RunActor {
  uid: string;
  name: string;
}

export interface RouteRunDoc {
  runId: string;
  route_id: string;
  route_name_snapshot: string;
  scheduled_at: string;
  status: RouteRunStatus;
  driver?: { uid: string; name: string } | null;
  notes?: string | null;
  counts: RunCounts;
  createdAt?: string | null;
  createdBy?: RunActor | null;
  updatedAt?: string | null;
}

export interface RouteRunStopDoc {
  order_id: string;
  order_number: string;
  customer_id: string;
  customer_name: string;
  address_snapshot?: Record<string, any> | null;
  packages_count: number;
  total_amount: number;
  paid_amount: number;
  balance_due: number;
  stop_status: StopStatus;
  delivered_package_ids?: string[];
  delivered_at?: string | null;
  createdAt?: string | null;
}

export interface DispatchOrderRow {
  order_id: string;
  customer_id: string;
  route_id: string | null;
  status: string;
  route_run_id?: string | null;
  dispatch_request: {
    status: DispatchRequestStatus;
    requested_at?: string | null;
    requested_by?: RunActor | null;
    note?: string | null;
  };
  packing: {
    status: "in_progress" | "done";
    packages_count: number;
    completed_at?: string | null;
  };
  totals: {
    total_amount: number;
    paid_amount: number;
    balance_due: number;
  };
  updated_at: string;
}

export interface AcceptRequestParams {
  order: DispatchOrderRow;
  routeName: string;
  customerName: string;
  actor: RunActor;
  scheduledDate?: Date | null;
  runId?: string | null;
}

@Injectable({ providedIn: "root" })
export class RouteRunsService {
  async createDraftRun(
    routeId: string,
    routeName: string,
    actor: RunActor,
    scheduledDate?: Date | null,
  ): Promise<string> {
    const runId = `run_${ulid()}`;
    const scheduledAt = this.resolveScheduledDate(scheduledDate || new Date());
    await setDoc(doc(FIRESTORE, "route_runs", runId), {
      runId,
      route_id: routeId,
      route_name_snapshot: routeName || routeId,
      scheduled_at: Timestamp.fromDate(scheduledAt),
      status: "draft",
      counts: {
        orders_total: 0,
        packages_total: 0,
        balance_total: 0,
      },
      createdAt: serverTimestamp(),
      createdBy: actor,
      updatedAt: serverTimestamp(),
    });
    return runId;
  }

  async listRuns(): Promise<RouteRunDoc[]> {
    const snap = await getDocs(query(collection(FIRESTORE, "route_runs"), orderBy("scheduled_at", "asc")));
    return snap.docs.map((entry) => this.normalizeRun(entry.id, entry.data() as Record<string, any>));
  }

  async getRun(runId: string): Promise<RouteRunDoc | null> {
    const snap = await getDoc(doc(FIRESTORE, "route_runs", runId));
    if (!snap.exists()) return null;
    return this.normalizeRun(snap.id, snap.data() as Record<string, any>);
  }

  async listStops(runId: string): Promise<RouteRunStopDoc[]> {
    const snap = await getDocs(query(collection(FIRESTORE, "route_runs", runId, "stops"), orderBy("createdAt", "asc")));
    return snap.docs.map((entry) => this.normalizeStop(entry.data() as Record<string, any>));
  }

  async listDispatchOrders(): Promise<DispatchOrderRow[]> {
    const snap = await getDocs(collection(FIRESTORE, "orders"));
    return snap.docs.map((entry) => this.normalizeDispatchOrder(entry.id, entry.data() as Record<string, any>));
  }

  async requestDispatch(orderId: string, actor: RunActor, note?: string): Promise<void> {
    const eventId = `evt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    await updateDoc(doc(FIRESTORE, "orders", orderId), {
      dispatch_request: {
        status: "requested",
        requested_at: serverTimestamp(),
        requested_by: actor,
        note: note || null,
      },
      updated_at: serverTimestamp(),
    });
    await setDoc(doc(FIRESTORE, "orders", orderId, "events", eventId), {
      id: eventId,
      orderId,
      type: "dispatch_requested",
      message: "Solicitud de salida enviada",
      meta: { note: note || null },
      actor,
      createdAt: serverTimestamp(),
    });
  }

  async cancelDispatchRequest(orderId: string, actor: RunActor): Promise<void> {
    const eventId = `evt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    await updateDoc(doc(FIRESTORE, "orders", orderId), {
      dispatch_request: {
        status: "none",
        requested_at: null,
        requested_by: null,
      },
      updated_at: serverTimestamp(),
    });
    await setDoc(doc(FIRESTORE, "orders", orderId, "events", eventId), {
      id: eventId,
      orderId,
      type: "dispatch_request_cancelled",
      message: "Solicitud de salida cancelada",
      actor,
      createdAt: serverTimestamp(),
    });
  }

  async acceptDispatchRequest(params: AcceptRequestParams): Promise<string> {
    const explicitRunId = (params.runId || "").trim();
    let runCandidate: RouteRunDoc | null = null;
    let scheduledDate = this.resolveScheduledDate(params.scheduledDate || new Date());
    let runId = explicitRunId;
    if (explicitRunId) {
      runCandidate = await this.getRun(explicitRunId);
      if (!runCandidate) {
        throw new Error("La salida seleccionada no existe.");
      }
      if (runCandidate.status !== "draft" && runCandidate.status !== "scheduled") {
        throw new Error("La salida seleccionada ya no esta disponible.");
      }
      if (params.order.route_id && runCandidate.route_id !== params.order.route_id) {
        throw new Error("La salida seleccionada no corresponde a la ruta del pedido.");
      }
      runId = runCandidate.runId;
      scheduledDate = this.resolveScheduledDate(new Date(runCandidate.scheduled_at));
    } else {
      runCandidate = await this.findOpenRunForDate(params.order.route_id, scheduledDate);
      runId = runCandidate?.runId || `run_${ulid()}`;
    }
    const runRef = doc(FIRESTORE, "route_runs", runId);
    const stopRef = doc(FIRESTORE, "route_runs", runId, "stops", params.order.order_id);
    const orderRef = doc(FIRESTORE, "orders", params.order.order_id);
    const eventId = `evt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const eventRef = doc(FIRESTORE, "orders", params.order.order_id, "events", eventId);

    await runTransaction(FIRESTORE, async (tx) => {
      const runSnap = await tx.get(runRef);
      const stopSnap = await tx.get(stopRef);
      const orderSnap = await tx.get(orderRef);
      if (!orderSnap.exists()) {
        throw new Error("El pedido no existe.");
      }

      if (!runSnap.exists()) {
        tx.set(runRef, {
          runId,
          route_id: params.order.route_id || "sin_ruta",
          route_name_snapshot: params.routeName || params.order.route_id || "Sin ruta",
          scheduled_at: Timestamp.fromDate(scheduledDate),
          status: "draft",
          counts: {
            orders_total: 0,
            packages_total: 0,
            balance_total: 0,
          },
          createdAt: serverTimestamp(),
          createdBy: params.actor,
          updatedAt: serverTimestamp(),
        });
      }

      const stopPayload = {
        order_id: params.order.order_id,
        order_number: params.order.order_id,
        customer_id: params.order.customer_id,
        customer_name: params.customerName,
        packages_count: Math.max(0, Math.trunc(params.order.packing.packages_count || 0)),
        total_amount: Number(params.order.totals.total_amount || 0),
        paid_amount: Number(params.order.totals.paid_amount || 0),
        balance_due: Number(params.order.totals.balance_due || 0),
        stop_status: "pending",
        createdAt: serverTimestamp(),
      };

      if (!stopSnap.exists()) {
        tx.set(stopRef, stopPayload);
      }

      const runData = runSnap.exists()
        ? (runSnap.data() as Record<string, any>)
        : {
            counts: { orders_total: 0, packages_total: 0, balance_total: 0 },
          };
      const runCounts = runData["counts"] || {};
      const currentOrders = Number(runCounts["orders_total"] || 0);
      const currentPackages = Number(runCounts["packages_total"] || 0);
      const currentBalance = Number(runCounts["balance_total"] || 0);
      const alreadyIncluded = stopSnap.exists();
      const addOrders = alreadyIncluded ? 0 : 1;
      const addPackages = alreadyIncluded ? 0 : stopPayload.packages_count;
      const addBalance = alreadyIncluded ? 0 : stopPayload.balance_due;

      tx.set(
        runRef,
        {
          updatedAt: serverTimestamp(),
          counts: {
            orders_total: currentOrders + addOrders,
            packages_total: currentPackages + addPackages,
            balance_total: currentBalance + addBalance,
          },
        },
        { merge: true },
      );

      tx.update(orderRef, {
        route_run_id: runId,
        status: "assigned_to_run",
        dispatch_request: {
          status: "accepted",
          requested_at: params.order.dispatch_request.requested_at || null,
          requested_by: params.order.dispatch_request.requested_by || null,
          note: params.order.dispatch_request.note || null,
        },
        updated_at: serverTimestamp(),
      });

      tx.set(eventRef, {
        id: eventId,
        orderId: params.order.order_id,
        type: alreadyIncluded ? "dispatch_accepted" : "added_to_run",
        message: alreadyIncluded ? "Solicitud aceptada" : "Pedido agregado a salida",
        meta: {
          runId,
          route_id: params.order.route_id,
          scheduled_at: Timestamp.fromDate(scheduledDate),
        },
        actor: params.actor,
        createdAt: serverTimestamp(),
      });
    });

    return runId;
  }

  async rejectDispatchRequest(orderId: string, actor: RunActor, note?: string): Promise<void> {
    const eventId = `evt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    await updateDoc(doc(FIRESTORE, "orders", orderId), {
      dispatch_request: {
        status: "rejected",
        note: note || null,
      },
      updated_at: serverTimestamp(),
    });
    await setDoc(doc(FIRESTORE, "orders", orderId, "events", eventId), {
      id: eventId,
      orderId,
      type: "dispatch_rejected",
      message: "Solicitud de salida rechazada",
      meta: { note: note || null },
      actor,
      createdAt: serverTimestamp(),
    });
  }

  async updateRunSchedule(runId: string, scheduledAt: Date): Promise<void> {
    const normalized = new Date(scheduledAt);
    normalized.setHours(0, 0, 0, 0);
    await updateDoc(doc(FIRESTORE, "route_runs", runId), {
      scheduled_at: Timestamp.fromDate(normalized),
      status: "scheduled",
      updatedAt: serverTimestamp(),
    });
  }

  async assignRunDriver(runId: string, driver: { uid: string; name: string } | null): Promise<void> {
    await updateDoc(doc(FIRESTORE, "route_runs", runId), {
      driver: driver || null,
      updatedAt: serverTimestamp(),
    });
  }

  async updateRunStatus(runId: string, status: RouteRunStatus): Promise<void> {
    await updateDoc(doc(FIRESTORE, "route_runs", runId), {
      status,
      updatedAt: serverTimestamp(),
    });
  }

  /** Marca el estado de entrega de una parada */
  async markStop(runId: string, orderId: string, status: StopStatus): Promise<void> {
    const stopRef = doc(FIRESTORE, "route_runs", runId, "stops", orderId);
    await updateDoc(stopRef, {
      stop_status: status,
      delivered_at: status === "delivered" || status === "partial"
        ? serverTimestamp()
        : null,
    });
  }

  private async findOpenRunForDate(routeId: string | null, scheduledDate: Date): Promise<RouteRunDoc | null> {
    if (!routeId) return null;
    const start = new Date(scheduledDate);
    start.setHours(0, 0, 0, 0);
    const end = new Date(scheduledDate);
    end.setHours(23, 59, 59, 999);

    const snap = await getDocs(
      query(
        collection(FIRESTORE, "route_runs"),
        where("route_id", "==", routeId),
        where("status", "in", ["draft", "scheduled"]),
        where("scheduled_at", ">=", Timestamp.fromDate(start)),
        where("scheduled_at", "<=", Timestamp.fromDate(end)),
      ),
    );
    const rows = snap.docs.map((entry) => this.normalizeRun(entry.id, entry.data() as Record<string, any>));
    rows.sort((a, b) => (a.scheduled_at < b.scheduled_at ? -1 : 1));
    return rows[0] || null;
  }

  private resolveScheduledDate(value: Date): Date {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      const fallback = new Date();
      fallback.setHours(10, 0, 0, 0);
      return fallback;
    }
    if (date.getHours() === 0 && date.getMinutes() === 0) {
      date.setHours(10, 0, 0, 0);
    }
    return date;
  }

  private normalizeRun(runId: string, data: Record<string, any>): RouteRunDoc {
    return {
      runId,
      route_id: (data["route_id"] || "").toString(),
      route_name_snapshot: (data["route_name_snapshot"] || "Ruta").toString(),
      scheduled_at: toIso(data["scheduled_at"]) || new Date().toISOString(),
      status: (data["status"] || "draft") as RouteRunStatus,
      driver: data["driver"] || null,
      notes: data["notes"] || null,
      counts: {
        orders_total: Number(data["counts"]?.["orders_total"] || 0),
        packages_total: Number(data["counts"]?.["packages_total"] || 0),
        balance_total: Number(data["counts"]?.["balance_total"] || 0),
      },
      createdAt: toIso(data["createdAt"]),
      createdBy: data["createdBy"] || null,
      updatedAt: toIso(data["updatedAt"]),
    };
  }

  private normalizeStop(data: Record<string, any>): RouteRunStopDoc {
    return {
      order_id: (data["order_id"] || "").toString(),
      order_number: (data["order_number"] || data["order_id"] || "").toString(),
      customer_id: (data["customer_id"] || "").toString(),
      customer_name: (data["customer_name"] || "Cliente").toString(),
      address_snapshot: data["address_snapshot"] || null,
      packages_count: Number(data["packages_count"] || 0),
      total_amount: Number(data["total_amount"] || 0),
      paid_amount: Number(data["paid_amount"] || 0),
      balance_due: Number(data["balance_due"] || 0),
      stop_status: (data["stop_status"] || "pending") as StopStatus,
      delivered_package_ids: Array.isArray(data["delivered_package_ids"]) ? data["delivered_package_ids"] : [],
      delivered_at: toIso(data["delivered_at"]),
      createdAt: toIso(data["createdAt"]),
    };
  }

  private normalizeDispatchOrder(orderId: string, data: Record<string, any>): DispatchOrderRow {
    const packingRaw = (data["packing"] || {}) as Record<string, any>;
    const requestRaw = (data["dispatch_request"] || {}) as Record<string, any>;
    const totalsRaw = (data["totals"] || {}) as Record<string, any>;
    const computedClientTotal = computeClientTotalFromItems(data["items"]);
    const totalAmount = Number(totalsRaw["total_amount"] || 0) || computedClientTotal;
    const paidAmount = Number(totalsRaw["paid_amount"] || 0);
    const balanceDue = Number(totalsRaw["balance_due"] || 0) || Math.max(0, totalAmount - paidAmount);
    return {
      order_id: orderId,
      customer_id: (data["customer_id"] || "").toString(),
      route_id: (data["route_id"] || null) as string | null,
      status: (data["status"] || "borrador").toString(),
      route_run_id: (data["route_run_id"] || null) as string | null,
      dispatch_request: {
        status: (requestRaw["status"] || "none") as DispatchRequestStatus,
        requested_at: toIso(requestRaw["requested_at"]),
        requested_by: requestRaw["requested_by"] || null,
        note: requestRaw["note"] || null,
      },
      packing: {
        status: (packingRaw["status"] || "in_progress") as "in_progress" | "done",
        packages_count: Number(packingRaw["packages_count"] || 0),
        completed_at: toIso(packingRaw["completed_at"]),
      },
      totals: {
        total_amount: totalAmount,
        paid_amount: paidAmount,
        balance_due: balanceDue,
      },
      updated_at: toIso(data["updated_at"]) || new Date().toISOString(),
    };
  }
}

function toIso(value: any): string | null {
  if (!value) return null;
  if (typeof value === "string") return value;
  if (value instanceof Date) return value.toISOString();
  if (value?.toDate) return value.toDate().toISOString();
  return null;
}

function computeClientTotalFromItems(rawItems: unknown): number {
  if (!Array.isArray(rawItems)) return 0;
  let total = 0;
  for (const row of rawItems) {
    const item = (row || {}) as Record<string, any>;
    const qtyRaw = Number(item["confirmed_qty"]);
    const qty = Number.isFinite(qtyRaw) && qtyRaw > 0 ? qtyRaw : Number(item["quantity"] || 0);
    const price = Number(item["price_clienta"] ?? item["price_public"] ?? 0);
    if (!Number.isFinite(qty) || !Number.isFinite(price)) continue;
    total += Math.max(0, qty) * Math.max(0, price);
  }
  return Number(total.toFixed(2));
}
