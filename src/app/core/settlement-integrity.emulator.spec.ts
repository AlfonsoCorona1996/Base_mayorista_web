import { TestBed } from "@angular/core/testing";
import { provideHttpClient } from "@angular/common/http";
import { connectAuthEmulator, signInWithEmailAndPassword, signOut } from "firebase/auth";
import { connectFirestoreEmulator, doc, getDoc, serverTimestamp, setDoc, updateDoc } from "firebase/firestore";

import { DEFAULT_ROLE_PRESETS, RoleId } from "./rbac.constants";
import { FIRESTORE, FIREBASE_AUTH } from "./firebase.providers";
import { Order, OrderCollectionEvent, OrdersService } from "./orders.service";
import { businessDateKey, financePeriodDocumentId, monthIdFromDateInput } from "./finance-ledger";

/**
 * FIX 00 — integridad de la conciliación con las reglas REALES (emulador).
 *
 * Política que se comprueba:
 * 1. Solo quien tiene `cap.settlement.send` o `cap.settlement.reconcile` registra una
 *    conciliación (`settlement_status` distinto de `pending` / `not_applicable`), por cualquier
 *    rama de las reglas: administrador, cobro, estado operativo, conciliación o alta de pedido.
 *    Es el mismo permiso que ya exigía el evento obligatorio `order_settlement_events`.
 * 2. Los reinicios automáticos a `pending` / `not_applicable` (registrar o rechazar un cobro)
 *    siguen permitidos a quien registra cobros.
 * 3. Cambio de conciliación, su evento y, si aplica, el evento de cobro que la origina se
 *    confirman juntos o no se confirma nada; una acción denegada no cambia la memoria local.
 *
 * Además de los roles predeterminados prueba permisos personalizados.
 * NO corre en `npm test`. Ver scripts/emulator/README.md.
 */
const FIRESTORE_PORT = 8597;
const AUTH_PORT = 9697;
const PROJECT = "base-mayorista";
const REST = `http://127.0.0.1:${FIRESTORE_PORT}/v1/projects/${PROJECT}/databases/(default)/documents`;
let emulatorsConnected = false;

function connectEmulatorsOnce(): void {
  if (emulatorsConnected) return;
  connectFirestoreEmulator(FIRESTORE, "127.0.0.1", FIRESTORE_PORT);
  connectAuthEmulator(FIREBASE_AUTH, `http://127.0.0.1:${AUTH_PORT}`, { disableWarnings: true });
  emulatorsConnected = true;
}

// ------------------------------------------------------------------ acceso owner
type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
function toValue(value: unknown): Record<string, unknown> {
  if (value === null || value === undefined) return { nullValue: null };
  if (typeof value === "boolean") return { booleanValue: value };
  if (typeof value === "number") return Number.isInteger(value) ? { integerValue: String(value) } : { doubleValue: value };
  if (typeof value === "string") return { stringValue: value };
  if (Array.isArray(value)) return { arrayValue: { values: value.map(toValue) } };
  return { mapValue: { fields: Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, toValue(v)])) } };
}
function fromValue(v: Record<string, any>): Json {
  if ("nullValue" in v) return null;
  if ("booleanValue" in v) return v["booleanValue"];
  if ("integerValue" in v) return Number(v["integerValue"]);
  if ("doubleValue" in v) return v["doubleValue"];
  if ("stringValue" in v) return v["stringValue"];
  if ("timestampValue" in v) return v["timestampValue"];
  if ("arrayValue" in v) return (v["arrayValue"]["values"] || []).map(fromValue);
  if ("mapValue" in v) return Object.fromEntries(Object.entries(v["mapValue"]["fields"] || {}).map(([k, x]) => [k, fromValue(x as Record<string, any>)]));
  return null;
}
async function ownerSet(path: string, data: Record<string, unknown>): Promise<void> {
  const res = await fetch(`${REST}/${path}`, {
    method: "PATCH",
    headers: { Authorization: "Bearer owner", "Content-Type": "application/json" },
    body: JSON.stringify({ fields: Object.fromEntries(Object.entries(data).map(([k, v]) => [k, toValue(v)])) }),
  });
  if (!res.ok) throw new Error(`ownerSet ${path}: ${res.status} ${await res.text()}`);
}
async function ownerGet(path: string): Promise<Record<string, any> | null> {
  const res = await fetch(`${REST}/${path}`, { headers: { Authorization: "Bearer owner" } });
  if (res.status === 404) return null;
  const json = await res.json();
  return Object.fromEntries(Object.entries(json.fields || {}).map(([k, v]) => [k, fromValue(v as Record<string, any>)]));
}
async function ownerDelete(path: string): Promise<void> {
  await fetch(`${REST}/${path}`, { method: "DELETE", headers: { Authorization: "Bearer owner" } });
}
async function ownerCount(collectionId: string, field: string, value: string): Promise<number> {
  const res = await fetch(`${REST}:runQuery`, {
    method: "POST",
    headers: { Authorization: "Bearer owner", "Content-Type": "application/json" },
    body: JSON.stringify({ structuredQuery: { from: [{ collectionId }], where: { fieldFilter: { field: { fieldPath: field }, op: "EQUAL", value: { stringValue: value } } } } }),
  });
  const rows = await res.json() as Array<{ document?: unknown }>;
  return rows.filter((row) => row.document).length;
}

// ------------------------------------------------------------------ identidades
interface IdentitySpec {
  key: string;
  role: RoleId | null;
  active: boolean;
  business: "bm" | "catalogo";
  /** Ajustes sobre el preset del rol (permisos personalizados). */
  add?: string[];
  remove?: string[];
  only?: { sections: string[]; capabilities: string[] };
}

const IDENTITIES: IdentitySpec[] = [
  { key: "super_admin", role: "super_admin", active: true, business: "bm" },
  { key: "admin", role: "admin", active: true, business: "bm" },
  { key: "administrativo", role: "administrativo", active: true, business: "bm" },
  { key: "operativo", role: "operativo", active: true, business: "bm" },
  { key: "repartidor", role: "repartidor", active: true, business: "bm" },
  { key: "durango_operativo", role: "durango_operativo", active: true, business: "bm" },
  { key: "sin_permisos", role: "repartidor", active: true, business: "bm", only: { sections: ["sections.pedidos"], capabilities: ["cap.orders.view"] } },
  { key: "otro_negocio", role: "admin", active: true, business: "catalogo" },
  { key: "inactivo", role: "admin", active: false, business: "bm" },
  { key: "anonimo", role: null, active: false, business: "bm" },
  // Permisos personalizados.
  { key: "admin_sin_conciliacion", role: "admin", active: true, business: "bm", remove: ["cap.settlement.send", "cap.settlement.reconcile"] },
  { key: "administrativo_con_conciliacion", role: "administrativo", active: true, business: "bm", add: ["cap.settlement.reconcile"] },
  { key: "repartidor_sin_envio", role: "repartidor", active: true, business: "bm", remove: ["cap.settlement.send"] },
  { key: "cobrador_sin_conciliacion", role: "operativo", active: true, business: "bm", add: ["cap.payments.register", "cap.finance.accounts.view"], remove: ["cap.settlement.send", "cap.settlement.reconcile"] },
  // Puede conciliar y ver la conciliación, nada más.
  { key: "conciliador", role: "operativo", active: true, business: "bm", only: { sections: ["sections.pedidos"], capabilities: ["cap.orders.view", "cap.settlement.view", "cap.settlement.reconcile"] } },
  // Puede conciliar pero no ver cobros: tampoco los lista en la interfaz.
  { key: "solo_conciliacion", role: "operativo", active: true, business: "bm", only: { sections: ["sections.pedidos"], capabilities: ["cap.orders.view", "cap.settlement.reconcile"] } },
];

const OPERATIONAL_CAPS = [
  "cap.shipments.create", "cap.shipments.edit", "cap.shipments.send", "cap.shipments.receive", "cap.packing.finish",
  "cap.delivery.mark_delivered", "cap.delivery.mark_partial", "cap.payments.register", "cap.settlement.send", "cap.settlement.reconcile",
];

function userDocFor(spec: IdentitySpec): Record<string, unknown> {
  const role = spec.role as RoleId;
  const preset = DEFAULT_ROLE_PRESETS[role];
  let sections: Record<string, boolean> = { ...preset.sections } as Record<string, boolean>;
  let capabilities: Record<string, boolean> = { ...preset.capabilities } as Record<string, boolean>;
  if (spec.only) {
    sections = Object.fromEntries(spec.only.sections.map((key) => [key, true]));
    capabilities = Object.fromEntries(spec.only.capabilities.map((key) => [key, true]));
  }
  for (const key of spec.add || []) capabilities[key] = true;
  for (const key of spec.remove || []) delete capabilities[key];
  return {
    isActive: spec.active,
    roleId: role,
    displayName: `Settle ${spec.key}`,
    email: `${spec.key}@example.com`,
    sections,
    capabilities,
    businessMemberships: { [spec.business]: { businessId: spec.business, enabled: true, roleId: role } },
  };
}

/** Lo que la política permite a cada identidad (independiente de la implementación). */
function expectations(spec: IdentitySpec) {
  if (!spec.role) return { valid: false, admin: false, settle: false, payments: false, operational: false, creator: false };
  const caps = userDocFor(spec)["capabilities"] as Record<string, boolean>;
  const valid = spec.active && spec.business === "bm";
  const admin = valid && (spec.role === "admin" || spec.role === "super_admin");
  return {
    valid,
    admin,
    settle: valid && (caps["cap.settlement.send"] === true || caps["cap.settlement.reconcile"] === true),
    payments: valid && caps["cap.payments.register"] === true,
    operational: valid && OPERATIONAL_CAPS.some((key) => caps[key] === true),
    creator: valid && (admin || spec.role === "operativo"),
  };
}

type Outcome = "ALLOW" | "DENY" | "ERROR";
interface Cell { identity: string; operation: string; outcome: Outcome; state: string; detail: string }

function classify(error: unknown): { outcome: Outcome; detail: string } {
  const code = (error as { code?: string } | null)?.code || "";
  const message = error instanceof Error ? error.message : String(error);
  if (code === "permission-denied" || /permission|PERMISSION_DENIED|insufficient permissions/i.test(message)) {
    return { outcome: "DENY", detail: code || message.slice(0, 120) };
  }
  return { outcome: "ERROR", detail: `${code} ${message}`.trim().slice(0, 160) };
}

describe("FIX 00 — integridad de la conciliación con reglas reales (emulador)", () => {
  let orders: OrdersService;
  const emails = new Map<string, string | null>();
  const matrix: Cell[] = [];
  const failures: string[] = [];
  const run = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
  let seq = 0;
  let previousTimeout = 0;
  const nowIso = () => new Date().toISOString();
  const next = (prefix: string) => `${prefix}-${run}-${++seq}`;

  beforeAll(async () => {
    previousTimeout = jasmine.DEFAULT_TIMEOUT_INTERVAL;
    jasmine.DEFAULT_TIMEOUT_INTERVAL = 600000;
    connectEmulatorsOnce();
    TestBed.configureTestingModule({ providers: [provideHttpClient()] });
    orders = TestBed.inject(OrdersService);
    for (const spec of IDENTITIES) {
      if (!spec.role) { emails.set(spec.key, null); continue; }
      const email = `settle-${spec.key}-${run}@example.com`;
      const res = await fetch(`http://127.0.0.1:${AUTH_PORT}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=demo-key`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password: "Test1234!", returnSecureToken: true }),
      });
      const json = await res.json();
      if (!json.localId) throw new Error(`signUp ${email}: ${JSON.stringify(json)}`);
      await ownerSet(`users/${json.localId}`, userDocFor(spec));
      emails.set(spec.key, email);
    }
    await ownerSet(`customers/cust-${run}`, { customer_id: `cust-${run}`, business_id: "bm", first_name: "Clienta", last_name: "Conciliación" });
    await ownerSet("finance_accounts/acc_caja_general", { account_id: "acc_caja_general", business_id: "bm", name: "General", balance: 100000 });
  });

  afterAll(async () => {
    jasmine.DEFAULT_TIMEOUT_INTERVAL = previousTimeout;
    await signOut(FIREBASE_AUTH).catch(() => undefined);
    console.log(`[SETTLEMENT-INTEGRITY] ${JSON.stringify(matrix)}`);
  });

  async function as(key: string): Promise<void> {
    if (FIREBASE_AUTH.currentUser) await signOut(FIREBASE_AUTH);
    const email = emails.get(key);
    if (email) await signInWithEmailAndPassword(FIREBASE_AUTH, email, "Test1234!");
  }

  async function attempt(fn: () => Promise<unknown>): Promise<{ outcome: Outcome; detail: string }> {
    try {
      await fn();
      return { outcome: "ALLOW", detail: "" };
    } catch (error) {
      return classify(error);
    }
  }

  function check(condition: boolean, message: string): void {
    if (!condition) failures.push(message);
  }

  async function seedOrder(orderId: string, extra: Record<string, unknown> = {}): Promise<void> {
    await ownerSet(`orders/${orderId}`, {
      order_id: orderId, business_id: "bm", customer_id: `cust-${run}`, route_id: null, status: "pagado",
      delivery_status: "delivered", delivered_at: nowIso(), customer_payment_status: "collected", settlement_status: "pending",
      items: [{ item_id: "i-1", title: "Artículo", quantity: 1, confirmed_qty: 1, returned_qty: 0, price_clienta: 300, price_public: 300, price_cost: 100, state: "entregado", confirmation_state: "confirmed", source: "manual" }],
      packages: [], timeline: [], notes: "",
      totals: { total_amount: 300, paid_amount: 300, balance_due: 0, gross_amount: 300, net_amount: 300, discount_amount: 0 },
      created_at: nowIso(), updated_at: nowIso(), ...extra,
    });
  }

  async function seedReportedCollection(orderId: string): Promise<OrderCollectionEvent> {
    const eventId = `evt-${orderId}`;
    const event: OrderCollectionEvent = {
      event_id: eventId, order_id: orderId, business_id: "bm", account_id: "acc_caja_general", amount: 300, method: "efectivo",
      status_after: "collected", settlement_status_after: "pending", source_location: "durango", verification_status: "reported",
      collected_by: { uid: "durango", name: "Durango" }, reported_by: { uid: "durango", name: "Durango" },
      verified_by: null, verified_at: null, cash_occurred_at: null, note: null, rejected_reason: null, created_at: nowIso(),
    };
    await ownerSet(`order_collection_events/${eventId}`, { ...event } as unknown as Record<string, unknown>);
    return event;
  }

  async function loadAs(orderId: string): Promise<Order | null> {
    const snap = await getDoc(doc(FIRESTORE, "orders", orderId)).catch(() => null);
    if (!snap?.exists()) return null;
    const order = { ...(snap.data() as Record<string, any>), order_id: orderId, timeline: [] } as unknown as Order;
    orders.add(order);
    return order;
  }

  const settlementEvents = (orderId: string) => ownerCount("order_settlement_events", "order_id", orderId);

  // ---------------------------------------------------------------- rutas directas
  for (const spec of IDENTITIES) {
    it(`rutas de escritura directas · ${spec.key}`, async () => {
      const exp = expectations(spec);
      const direct: Array<{ op: string; expected: boolean; from: string; patch: () => Record<string, unknown> }> = [
        { op: "R1_rama_admin_conciliar", expected: exp.admin && exp.settle, from: "pending", patch: () => ({ settlement_status: "reconciled", notes: "directo", updated_at: serverTimestamp() }) },
        { op: "R2_rama_cobro_conciliar", expected: exp.settle && (exp.admin || exp.payments), from: "pending", patch: () => ({ settlement_status: "reconciled", collection_note: "directo", updated_at: serverTimestamp() }) },
        { op: "R3_rama_operativa_conciliar", expected: exp.settle && (exp.admin || exp.operational), from: "pending", patch: () => ({ settlement_status: "reconciled", current_holder_name: "directo", updated_at: serverTimestamp() }) },
        { op: "R4_rama_conciliacion", expected: exp.settle, from: "pending", patch: () => ({ settlement_status: "reconciled", updated_at: serverTimestamp() }) },
        { op: "R5_reinicio_por_cobro", expected: exp.admin || exp.payments, from: "reconciled", patch: () => ({ settlement_status: "pending", collection_note: "nuevo cobro", updated_at: serverTimestamp() }) },
        { op: "R6_operativo_sin_conciliacion", expected: exp.admin || exp.operational, from: "pending", patch: () => ({ current_holder_name: "Lupita", updated_at: serverTimestamp() }) },
      ];
      for (const row of direct) {
        const orderId = next("PDIR");
        await seedOrder(orderId, { settlement_status: row.from });
        await as(spec.key);
        const result = await attempt(() => updateDoc(doc(FIRESTORE, "orders", orderId), row.patch()));
        const saved = await ownerGet(`orders/${orderId}`);
        matrix.push({ identity: spec.key, operation: row.op, ...result, state: `settlement=${saved?.["settlement_status"]}` });
        check((result.outcome === "ALLOW") === row.expected, `${spec.key} ${row.op}: esperado ${row.expected ? "ALLOW" : "DENY"}, obtenido ${result.outcome} ${result.detail}`);
      }
      // R9/R10: el evento de cobro. Marcar diferencia es conciliación; rechazar conserva sus permisos.
      const sections = (spec.role ? userDocFor(spec)["sections"] : {}) as Record<string, boolean>;
      const canTouchCollection = exp.valid && (sections["sections.administracion"] === true
        || (userDocFor(spec)["capabilities"] as Record<string, boolean>)["cap.settlement.reconcile"] === true);
      for (const [op, patch, expected] of [
        ["R9_cobro_diferencia_directo", { verification_status: "difference" }, canTouchCollection && exp.settle],
        ["R10_cobro_rechazo_directo", { verification_status: "rejected", rejected_reason: "directo" }, canTouchCollection],
      ] as const) {
        const orderId = next("PCOL");
        await seedOrder(orderId);
        const collection = await seedReportedCollection(orderId);
        await as(spec.key);
        const result = await attempt(() => updateDoc(doc(FIRESTORE, "order_collection_events", collection.event_id), { ...patch }));
        const saved = await ownerGet(`order_collection_events/${collection.event_id}`);
        matrix.push({ identity: spec.key, operation: op, ...result, state: `cobro=${saved?.["verification_status"]}` });
        check((result.outcome === "ALLOW") === expected, `${spec.key} ${op}: esperado ${expected ? "ALLOW" : "DENY"}, obtenido ${result.outcome} ${result.detail}`);
      }
      // R7: alta de un pedido ya conciliado (ruta alternativa) y alta normal.
      for (const [op, settlement, expected] of [
        ["R7_alta_conciliada", "reconciled", exp.creator && exp.settle],
        ["R8_alta_normal", null, exp.creator],
      ] as const) {
        const orderId = next("PNEW");
        await as(spec.key);
        const result = await attempt(() => setDoc(doc(FIRESTORE, "orders", orderId), {
          order_id: orderId, business_id: "bm", customer_id: `cust-${run}`, status: "borrador", items: [], packages: [], timeline: [],
          totals: { total_amount: 0, paid_amount: 0, balance_due: 0 }, ...(settlement ? { settlement_status: settlement } : {}),
          created_at: serverTimestamp(), updated_at: serverTimestamp(),
        }));
        matrix.push({ identity: spec.key, operation: op, ...result, state: "-" });
        check((result.outcome === "ALLOW") === expected, `${spec.key} ${op}: esperado ${expected ? "ALLOW" : "DENY"}, obtenido ${result.outcome} ${result.detail}`);
      }
      expect(failures.filter((line) => line.startsWith(`${spec.key} `))).toEqual([]);
    });
  }

  // ---------------------------------------------------------------- servicio: atomicidad
  for (const spec of IDENTITIES) {
    it(`servicio: conciliación atómica · ${spec.key}`, async () => {
      const exp = expectations(spec);

      // S1. Marcar dinero enviado (markSettlement).
      const sentOrder = next("PSENT");
      await seedOrder(sentOrder);
      await as(spec.key);
      const local = await loadAs(sentOrder);
      const s1 = await attempt(() => orders.markSettlement(sentOrder, "sent_to_gdl", "Prueba"));
      const s1Order = await ownerGet(`orders/${sentOrder}`);
      const s1Events = await settlementEvents(sentOrder);
      matrix.push({ identity: spec.key, operation: "S1_dinero_enviado", ...s1, state: `settlement=${s1Order?.["settlement_status"]} eventos=${s1Events}` });
      if (s1.outcome === "ALLOW") {
        check(s1Order?.["settlement_status"] === "sent_to_gdl" && s1Events === 1, `${spec.key} S1: permitido pero incompleto (settlement=${s1Order?.["settlement_status"]}, eventos=${s1Events})`);
      } else {
        check(s1Order?.["settlement_status"] === "pending" && s1Events === 0, `${spec.key} S1: denegado con escritura parcial (settlement=${s1Order?.["settlement_status"]}, eventos=${s1Events})`);
        if (local) check(orders.getById(sentOrder)?.settlement_status === "pending", `${spec.key} S1: la memoria local quedó en ${orders.getById(sentOrder)?.settlement_status} tras la negación`);
      }
      check((s1.outcome === "ALLOW") === exp.settle, `${spec.key} S1: esperado ${exp.settle ? "ALLOW" : "DENY"}, obtenido ${s1.outcome} ${s1.detail}`);

      // S2. Marcar diferencia en un cobro reportado (evento de cobro + pedido + evento de conciliación).
      const diffOrder = next("PDIF");
      await seedOrder(diffOrder);
      const diffEvent = await seedReportedCollection(diffOrder);
      await as(spec.key);
      await loadAs(diffOrder);
      const s2 = await attempt(() => orders.markCollectionDifference(diffEvent, "Prueba"));
      const s2Order = await ownerGet(`orders/${diffOrder}`);
      const s2Collection = await ownerGet(`order_collection_events/${diffEvent.event_id}`);
      const s2Events = await settlementEvents(diffOrder);
      matrix.push({ identity: spec.key, operation: "S2_diferencia", ...s2, state: `cobro=${s2Collection?.["verification_status"]} settlement=${s2Order?.["settlement_status"]} eventos=${s2Events}` });
      if (s2.outcome === "ALLOW") {
        check(s2Collection?.["verification_status"] === "difference" && s2Order?.["settlement_status"] === "difference" && s2Events === 1, `${spec.key} S2: permitido pero incompleto`);
      } else {
        check(s2Collection?.["verification_status"] === "reported" && s2Order?.["settlement_status"] === "pending" && s2Events === 0,
          `${spec.key} S2: denegado con escritura parcial (cobro=${s2Collection?.["verification_status"]}, settlement=${s2Order?.["settlement_status"]}, eventos=${s2Events})`);
      }
      if (!exp.settle) check(s2.outcome !== "ALLOW", `${spec.key} S2: concilió sin permiso`);

      // S3. Confirmar dinero recibido (evento de cobro + libro + cuenta + pedido + evento de conciliación).
      const confOrder = next("PCONF");
      await seedOrder(confOrder);
      const confEvent = await seedReportedCollection(confOrder);
      const balanceBefore = Number((await ownerGet("finance_accounts/acc_caja_general"))?.["balance"] || 0);
      await as(spec.key);
      await loadAs(confOrder);
      const s3 = await attempt(() => orders.confirmReportedCollection(confEvent, "Prueba"));
      const s3Order = await ownerGet(`orders/${confOrder}`);
      const s3Collection = await ownerGet(`order_collection_events/${confEvent.event_id}`);
      const s3Ledger = await ownerGet(`finance_ledger_entries/ledger_collection_${confEvent.event_id}`);
      const balanceAfter = Number((await ownerGet("finance_accounts/acc_caja_general"))?.["balance"] || 0);
      const s3Events = await settlementEvents(confOrder);
      matrix.push({ identity: spec.key, operation: "S3_confirmar_recibido", ...s3, state: `cobro=${s3Collection?.["verification_status"]} libro=${s3Ledger ? "si" : "no"} cuenta=${balanceAfter - balanceBefore} settlement=${s3Order?.["settlement_status"]} eventos=${s3Events}` });
      if (s3.outcome === "ALLOW") {
        check(s3Collection?.["verification_status"] === "confirmed" && !!s3Ledger && balanceAfter - balanceBefore === 300 && s3Order?.["settlement_status"] === "received" && s3Events === 1, `${spec.key} S3: permitido pero incompleto`);
      } else {
        check(s3Collection?.["verification_status"] === "reported" && !s3Ledger && balanceAfter === balanceBefore && s3Order?.["settlement_status"] === "pending" && s3Events === 0,
          `${spec.key} S3: denegado con escritura parcial (cobro=${s3Collection?.["verification_status"]}, libro=${!!s3Ledger}, cuenta=${balanceAfter - balanceBefore}, settlement=${s3Order?.["settlement_status"]}, eventos=${s3Events})`);
      }
      if (!exp.settle) check(s3.outcome !== "ALLOW", `${spec.key} S3: concilió sin permiso`);

      // Usuarios autorizados siguen conciliando.
      if (["super_admin", "admin", "administrativo_con_conciliacion", "conciliador"].includes(spec.key)) {
        check(s1.outcome === "ALLOW" && s2.outcome === "ALLOW", `${spec.key}: debía poder conciliar (S1 ${s1.outcome}, S2 ${s2.outcome})`);
      }
      // Marcar diferencia lee el evento de cobro para no registrarla dos veces; sin permiso para
      // ver cobros se niega completa (y en la interfaz el cobro ni siquiera se lista).
      if (spec.key === "solo_conciliacion") check(s1.outcome === "ALLOW", `${spec.key}: debía poder marcar dinero enviado (S1 ${s1.outcome})`);
      // Defecto ANTERIOR, fuera de FIX 00: confirmar recibido lee dentro de su transacción una
      // entrada del libro mayor que aún no existe, y la regla de lectura de
      // `finance_ledger_entries` evalúa `resource.data` sobre un documento inexistente; solo
      // `super_admin` la supera. Ocurre igual con las reglas y el cliente publicados. Aquí solo
      // se exige que la negación sea limpia (comprobado arriba) y que super_admin confirme.
      if (spec.key === "super_admin") check(s3.outcome === "ALLOW", `${spec.key}: debía poder confirmar el cobro (S3 ${s3.outcome})`);
      expect(failures.filter((line) => line.startsWith(`${spec.key} `) || line.startsWith(`${spec.key}:`))).toEqual([]);
    });
  }

  it("conciliar cierra un pedido entregado, liquidado y con inventario comprobado; no lo cierra si falta el inventario", async () => {
    await as("admin");
    const ready = next("PCLOSE");
    await seedOrder(ready);
    await loadAs(ready);
    await orders.markSettlement(ready, "reconciled", "Prueba");
    const closed = await ownerGet(`orders/${ready}`);
    expect(closed?.["status"]).toBe("closed");
    expect(closed?.["settlement_status"]).toBe("reconciled");
    expect(closed?.["closed_at"]).toBeTruthy();
    expect(await settlementEvents(ready)).toBe(1);

    const pending = next("PNOCLOSE");
    await seedOrder(pending, { inventory_sync: { status: "failed", scope: "close", attempts: 1 } });
    await loadAs(pending);
    await orders.markSettlement(pending, "reconciled", "Prueba");
    const open = await ownerGet(`orders/${pending}`);
    expect(open?.["status"]).toBe("pagado");
    expect(open?.["settlement_status"]).toBe("reconciled");
    expect(await settlementEvents(pending)).toBe(1);
  });

  it("un fallo dentro de la confirmación (periodo cerrado) no deja nada registrado", async () => {
    await as("super_admin");
    const orderId = next("PPER");
    await seedOrder(orderId);
    const event = await seedReportedCollection(orderId);
    const periodPath = `finance_periods/${financePeriodDocumentId("bm", monthIdFromDateInput(businessDateKey()))}`;
    const balanceBefore = Number((await ownerGet("finance_accounts/acc_caja_general"))?.["balance"] || 0);
    await ownerSet(periodPath, { period_id: periodPath.split("/")[1], business_id: "bm", status: "closed" });
    try {
      await loadAs(orderId);
      const result = await attempt(() => orders.confirmReportedCollection(event, "Prueba"));
      expect(result.outcome).toBe("ERROR");
      expect((await ownerGet(`order_collection_events/${event.event_id}`))?.["verification_status"]).toBe("reported");
      expect(await ownerGet(`finance_ledger_entries/ledger_collection_${event.event_id}`)).toBeNull();
      expect(Number((await ownerGet("finance_accounts/acc_caja_general"))?.["balance"] || 0)).toBe(balanceBefore);
      expect((await ownerGet(`orders/${orderId}`))?.["settlement_status"]).toBe("pending");
      expect(await settlementEvents(orderId)).toBe(0);
      expect(orders.getById(orderId)?.settlement_status).toBe("pending");
    } finally {
      await ownerDelete(periodPath);
    }
  });

  it("dos confirmaciones simultáneas del mismo cobro lo registran una sola vez", async () => {
    await as("super_admin");
    const orderId = next("PDUP");
    await seedOrder(orderId);
    const event = await seedReportedCollection(orderId);
    await loadAs(orderId);
    const balanceBefore = Number((await ownerGet("finance_accounts/acc_caja_general"))?.["balance"] || 0);
    const results = await Promise.allSettled([
      orders.confirmReportedCollection(event, "Sesión A"),
      orders.confirmReportedCollection(event, "Sesión B"),
    ]);
    expect(results.map((row) => row.status)).toEqual(["fulfilled", "fulfilled"]);
    expect(Number((await ownerGet("finance_accounts/acc_caja_general"))?.["balance"] || 0) - balanceBefore).toBe(300);
    expect((await ownerGet(`order_collection_events/${event.event_id}`))?.["verification_status"]).toBe("confirmed");
    expect(await settlementEvents(orderId)).toBe(1);
  });

});
