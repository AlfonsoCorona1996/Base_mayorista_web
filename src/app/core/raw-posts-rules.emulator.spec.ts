import { connectAuthEmulator, signInWithEmailAndPassword, signOut } from "firebase/auth";
import {
  collection, connectFirestoreEmulator, deleteDoc, doc, getDoc, getDocs, limit, query, setDoc, updateDoc, where,
} from "firebase/firestore";

import { DEFAULT_ROLE_PRESETS, RoleId } from "./rbac.constants";
import { FIRESTORE, FIREBASE_AUTH } from "./firebase.providers";
import { RawPostsService } from "./raw-posts.service";

/**
 * Regla de `raw_posts` (mensaje original en Validación) con las reglas REALES (emulador).
 *
 * Política: solo leer un mensaje por id (`get`), quien pertenece al negocio del mensaje (sin
 * `business_id` cuenta como "bm") y tiene la sección Validación o Catálogo. Nadie lista,
 * consulta, crea, modifica ni borra desde la app: eso es del backend con Admin SDK.
 *
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

function toValue(value: unknown): Record<string, unknown> {
  if (value === null || value === undefined) return { nullValue: null };
  if (typeof value === "boolean") return { booleanValue: value };
  if (typeof value === "number") return Number.isInteger(value) ? { integerValue: String(value) } : { doubleValue: value };
  if (typeof value === "string") return { stringValue: value };
  if (Array.isArray(value)) return { arrayValue: { values: value.map(toValue) } };
  return { mapValue: { fields: Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, toValue(v)])) } };
}

async function ownerSet(path: string, data: Record<string, unknown>): Promise<void> {
  const res = await fetch(`${REST}/${path}`, {
    method: "PATCH",
    headers: { Authorization: "Bearer owner", "Content-Type": "application/json" },
    body: JSON.stringify({ fields: Object.fromEntries(Object.entries(data).map(([k, v]) => [k, toValue(v)])) }),
  });
  if (!res.ok) throw new Error(`ownerSet ${path}: ${res.status} ${await res.text()}`);
}

async function ownerExists(path: string): Promise<boolean> {
  const res = await fetch(`${REST}/${path}`, { headers: { Authorization: "Bearer owner" } });
  return res.status !== 404;
}

interface IdentitySpec {
  key: string;
  role: RoleId | null;
  active: boolean;
  business: "bm" | "catalogo";
  only?: { sections: string[] };
  extra?: Record<string, unknown>;
}

const IDENTITIES: IdentitySpec[] = [
  { key: "super_admin", role: "super_admin", active: true, business: "bm" },
  { key: "admin", role: "admin", active: true, business: "bm" },
  { key: "administrativo", role: "administrativo", active: true, business: "bm" },
  { key: "operativo", role: "operativo", active: true, business: "bm" },
  { key: "repartidor", role: "repartidor", active: true, business: "bm" },
  { key: "durango_operativo", role: "durango_operativo", active: true, business: "bm" },
  { key: "solo_validacion", role: "repartidor", active: true, business: "bm", only: { sections: ["sections.validacion"] } },
  { key: "solo_catalogo", role: "repartidor", active: true, business: "bm", only: { sections: ["sections.catalogo"] } },
  { key: "solo_pedidos", role: "admin", active: true, business: "bm", only: { sections: ["sections.pedidos"] } },
  { key: "otro_negocio", role: "admin", active: true, business: "catalogo" },
  { key: "inactivo", role: "admin", active: false, business: "bm" },
  { key: "debe_cambiar_clave", role: "admin", active: true, business: "bm", extra: { mustChangePassword: true } },
  { key: "anonimo", role: null, active: false, business: "bm" },
];

function userDocFor(spec: IdentitySpec): Record<string, unknown> {
  const role = spec.role as RoleId;
  const preset = DEFAULT_ROLE_PRESETS[role];
  const sections: Record<string, boolean> = spec.only
    ? Object.fromEntries(spec.only.sections.map((key) => [key, true]))
    : { ...preset.sections } as Record<string, boolean>;
  return {
    isActive: spec.active,
    roleId: role,
    displayName: `Raw ${spec.key}`,
    email: `${spec.key}@example.com`,
    sections,
    capabilities: { ...preset.capabilities },
    businessMemberships: { [spec.business]: { businessId: spec.business, enabled: true, roleId: role } },
    ...(spec.extra || {}),
  };
}

/** Puede leer un mensaje del negocio indicado (sin business_id cuenta como "bm"). */
function expectedGet(spec: IdentitySpec, business: "bm" | "catalogo" = "bm"): boolean {
  if (!spec.role || !spec.active || spec.extra) return false;
  const sections = userDocFor(spec)["sections"] as Record<string, boolean>;
  const inBusiness = spec.role === "super_admin" || spec.business === business;
  return inBusiness && (sections["sections.validacion"] === true || sections["sections.catalogo"] === true);
}

type Outcome = "ALLOW" | "DENY" | "ERROR";

async function attempt(fn: () => Promise<unknown>): Promise<{ outcome: Outcome; detail: string }> {
  try {
    await fn();
    return { outcome: "ALLOW", detail: "" };
  } catch (error) {
    const code = (error as { code?: string } | null)?.code || "";
    const message = error instanceof Error ? error.message : String(error);
    if (code === "permission-denied" || /permission|PERMISSION_DENIED|insufficient permissions/i.test(message)) {
      return { outcome: "DENY", detail: code };
    }
    return { outcome: "ERROR", detail: `${code} ${message}`.trim().slice(0, 160) };
  }
}

describe("raw_posts — mensaje original con reglas reales (emulador)", () => {
  const emails = new Map<string, string | null>();
  const matrix: Array<{ identity: string; operation: string; expected: Outcome; outcome: Outcome; detail: string }> = [];
  const run = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
  const legacyId = `raw-legacy-${run}`;
  const bmId = `raw-bm-${run}`;
  const otherId = `raw-otro-${run}`;
  let previousTimeout = 0;

  beforeAll(async () => {
    previousTimeout = jasmine.DEFAULT_TIMEOUT_INTERVAL;
    jasmine.DEFAULT_TIMEOUT_INTERVAL = 600000;
    connectEmulatorsOnce();
    for (const spec of IDENTITIES) {
      if (!spec.role) { emails.set(spec.key, null); continue; }
      const email = `raw-${spec.key}-${run}@example.com`;
      const res = await fetch(`http://127.0.0.1:${AUTH_PORT}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=demo-key`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password: "Test1234!", returnSecureToken: true }),
      });
      const json = await res.json();
      if (!json.localId) throw new Error(`signUp ${email}: ${JSON.stringify(json)}`);
      await ownerSet(`users/${json.localId}`, userDocFor(spec));
      emails.set(spec.key, email);
    }
    // Como los 385 documentos reales: sin business_id.
    await ownerSet(`raw_posts/${legacyId}`, { message: { raw_text: "Vestido largo talla CH M G $350" }, media: { images: [{ url: "https://example.com/a.jpg" }] } });
    await ownerSet(`raw_posts/${bmId}`, { business_id: "bm", message: { raw_text: "Cazadora Bomber" }, media: { images: [] } });
    await ownerSet(`raw_posts/${otherId}`, { business_id: "catalogo", message: { raw_text: "Otro negocio" }, media: { images: [] } });
  });

  afterAll(async () => {
    jasmine.DEFAULT_TIMEOUT_INTERVAL = previousTimeout;
    await signOut(FIREBASE_AUTH).catch(() => undefined);
    console.log(`[RAW-POSTS-RULES] ${JSON.stringify(matrix)}`);
  });

  async function as(key: string): Promise<void> {
    if (FIREBASE_AUTH.currentUser) await signOut(FIREBASE_AUTH);
    const email = emails.get(key);
    if (email) await signInWithEmailAndPassword(FIREBASE_AUTH, email, "Test1234!");
  }

  for (const spec of IDENTITIES) {
    it(`get por id y nada más · ${spec.key}`, async () => {
      await as(spec.key);
      const service = new RawPostsService();
      const writeId = `raw-escritura-${run}-${spec.key}`;
      const ops: Array<{ op: string; expected: boolean; fn: () => Promise<unknown> }> = [
        { op: "get_sin_business_id", expected: expectedGet(spec), fn: async () => {
          const post = await service.getById(legacyId);
          if (post?.message?.raw_text !== "Vestido largo talla CH M G $350") throw new Error("contenido inesperado");
        } },
        { op: "get_business_bm", expected: expectedGet(spec), fn: () => getDoc(doc(FIRESTORE, "raw_posts", bmId)) },
        { op: "get_otro_negocio", expected: expectedGet(spec, "catalogo"), fn: () => getDoc(doc(FIRESTORE, "raw_posts", otherId)) },
        { op: "list", expected: false, fn: () => getDocs(query(collection(FIRESTORE, "raw_posts"), limit(5))) },
        { op: "query_por_texto", expected: false, fn: () => getDocs(query(collection(FIRESTORE, "raw_posts"), where("message.raw_text", "==", "Cazadora Bomber"))) },
        { op: "create", expected: false, fn: () => setDoc(doc(FIRESTORE, "raw_posts", writeId), { business_id: "bm", message: { raw_text: "nuevo" } }) },
        { op: "update", expected: false, fn: () => updateDoc(doc(FIRESTORE, "raw_posts", bmId), { "message.raw_text": "cambiado" }) },
        { op: "quitar_imagen", expected: false, fn: () => service.removeImageUrl(legacyId, "https://example.com/a.jpg") },
        { op: "delete", expected: false, fn: () => deleteDoc(doc(FIRESTORE, "raw_posts", legacyId)) },
      ];
      const failures: string[] = [];
      for (const op of ops) {
        const result = await attempt(op.fn);
        const expected: Outcome = op.expected ? "ALLOW" : "DENY";
        matrix.push({ identity: spec.key, operation: op.op, expected, outcome: result.outcome, detail: result.detail });
        if (result.outcome !== expected) failures.push(`${op.op}: esperado ${expected}, obtuvo ${result.outcome} ${result.detail}`);
      }
      // Ninguna escritura llegó a la base.
      if (await ownerExists(`raw_posts/${writeId}`)) failures.push("create dejó un documento");
      if (!(await ownerExists(`raw_posts/${legacyId}`))) failures.push("delete borró el documento");
      expect(failures).withContext(spec.key).toEqual([]);
    });
  }
});
