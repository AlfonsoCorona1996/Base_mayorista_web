// Ejecutar solo con firebase.users-test.json y un backend local corregido.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const project = process.env.GCLOUD_PROJECT;
const authHost = process.env.FIREBASE_AUTH_EMULATOR_HOST;
const firestoreHost = process.env.FIRESTORE_EMULATOR_HOST;
assert.ok(project?.startsWith("demo-"), "Se requiere proyecto demo-");
assert.match(authHost || "", /^127\.0\.0\.1:\d+$/);
assert.match(firestoreHost || "", /^127\.0\.0\.1:\d+$/);
const backend = resolve(process.env.USERS_BACKEND_DIR || "../../Base Mayorista Backend/Base_Mayorista");
const requireBackend = createRequire(resolve(backend, "package.json"));
const express = requireBackend("express");
// Inicializar antes de importar el backend evita cargar credenciales de produccion.
const emulatorAdmin = requireBackend("firebase-admin");
emulatorAdmin.initializeApp({ projectId: project, storageBucket: `${project}.appspot.com` });
const { admin, firestore } = await import(pathToFileURL(resolve(backend, "firebase_admin.js")));
const { default: usersRouter } = await import(pathToFileURL(resolve(backend, "admin_users_routes.js")));
const { createSessionAuthorization } = await import(pathToFileURL(resolve(backend, "session_authorization.js")));
const app = express();
app.use(express.json());
app.use("/admin/users", usersRouter);
app.use("/api", createSessionAuthorization({ auth: admin.auth(), firestore }));
app.get("/api/admin/market-insights/latest", (_req, res) => res.json({ ok: true }));
app.put("/api/wa/bot/settings", (_req, res) => res.json({ ok: true }));
app.get("/api/operations", (_req, res) => res.json({ ok: true }));
const server = app.listen(0, "127.0.0.1");
await new Promise((done) => server.once("listening", done));
const base = `http://127.0.0.1:${server.address().port}`;
let passed = 0;
async function check(name, fn) { await fn(); passed++; console.log(`PASS ${name}`); }
async function call(path, token, body, method = body ? "POST" : "GET") {
  const response = await fetch(`${base}${path}`, {
    method, headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, body: await response.json(), headers: response.headers };
}
async function login(email, password) {
  const response = await fetch(`http://${authHost}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=demo-key`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password, returnSecureToken: true }),
  });
  const body = await response.json();
  assert.equal(response.status, 200, "Login en emulador");
  return body.idToken;
}
function value(input) {
  if (typeof input === "boolean") return { booleanValue: input };
  if (typeof input === "number") return { integerValue: String(input) };
  if (typeof input === "string") return { stringValue: input };
  return { mapValue: { fields: Object.fromEntries(Object.entries(input).map(([key, item]) => [key, value(item)])) } };
}
async function direct(path, token, body, method = "GET") {
  const response = await fetch(`http://${firestoreHost}/v1/projects/${project}/databases/(default)/documents/${path}`, {
    method, headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    ...(body ? { body: JSON.stringify({ fields: value(body).mapValue.fields }) } : {}),
  });
  return response.status;
}
const adminPassword = "Admin-emulator-only-882!";
const newPassword = "Nueva-emulator-only-994!";
const permissions = Object.fromEntries(["dashboard", "validacion", "pedidos", "catalogo", "edicion_productos", "categorias", "proveedores", "inventario", "administracion", "clientas", "rutas", "localidades", "salidas", "embarques", "durango", "usuarios"].map((key) => [key, ["pedidos", "validacion", "clientas", "inventario", "proveedores", "salidas", "embarques"].includes(key)]));
const invite = { display_name: "Jazmin", username: "Jazmin", role: "operativo", login_mode: "username_only", permissions,
  businessMemberships: { bm: { enabled: true, roleId: "operativo" } } };
try {
  // Limpieza unicamente del proyecto demo y de los emuladores indicados arriba.
  assert.equal((await fetch(`http://${authHost}/emulator/v1/projects/${project}/accounts`, { method: "DELETE" })).status, 200);
  assert.equal((await fetch(`http://${firestoreHost}/emulator/v1/projects/${project}/databases/(default)/documents`, { method: "DELETE" })).status, 200);
  const administrator = await admin.auth().createUser({ email: "admin@example.test", password: adminPassword });
  await admin.auth().setCustomUserClaims(administrator.uid, { roleId: "super_admin", isActive: true });
  await firestore.collection("users").doc(administrator.uid).set({ roleId: "super_admin", isActive: true, mustChangePassword: false, invitePending: false, sections: { administracion: true, usuarios: true } });
  const adminToken = await login("admin@example.test", adminPassword);
  let created;
  await check("Alta exacta Jazmin una vez y unicidad concurrente sin distinguir mayusculas", async () => {
    const initial = await call("/admin/users/invite", adminToken, invite);
    assert.equal(initial.status, 200);
    created = initial.body;
    assert.equal(created.username, "Jazmin");
    for (const username of ["jazmin", "JAZMIN"]) {
      assert.equal((await call("/admin/users/invite", adminToken, { ...invite, username })).status, 409);
    }
    const results = await Promise.all([
      call("/admin/users/invite", adminToken, { ...invite, username: "RaceCase" }),
      call("/admin/users/invite", adminToken, { ...invite, username: "racecase" }),
    ]);
    assert.deepEqual(results.map((item) => item.status).sort(), [200, 409]);
  });
  const ref = firestore.collection("users").doc(created.uid);
  // Comprobar tambien la identidad Auth, la persistencia y las cabeceras de respuesta.
  await check("Conservar username exacto y asociar UID Auth/Firestore sin guardar passwords", async () => {
    const exact = await call("/admin/users/invite", adminToken, { ...invite, username: "ExactCase" });
    assert.equal(exact.status, 200);
    const profile = (await firestore.collection("users").doc(exact.body.uid).get()).data();
    assert.equal(profile.username, "ExactCase");
    assert.equal(profile.usernameNormalized, "exactcase");
    assert.equal(profile.uid, exact.body.uid);
    assert.equal((await admin.auth().getUser(exact.body.uid)).email, "exactcase@users.base-mayorista.local");
    assert.ok(!JSON.stringify(profile).includes(exact.body.temporary_password));
    assert.equal(exact.headers.get("cache-control"), "no-store");
  });
  const token = await login("jazmin@users.base-mayorista.local", created.temporary_password);
  await check("Login temporal y bloqueo inicial, incluso en operaciones directas", async () => {
    const boot = await call("/admin/users/session/bootstrap", token);
    assert.equal(boot.status, 200);
    assert.equal(boot.body.user.mustChangePassword, true);
    assert.equal(boot.body.user.invitePending, true);
    // Simular un reset forzado de una cuenta activa: el flag por si solo debe bloquear.
    await ref.update({ isActive: true, invitePending: false, mustChangePassword: true });
    assert.equal((await call("/api/operations", token)).status, 403);
    assert.equal(await direct("orders", token), 403);
    assert.equal(await direct("users", token), 403);
    assert.equal(await direct(`users/${created.uid}`, token, { roleId: "super_admin", isActive: true, mustChangePassword: false }, "PATCH"), 403);
  });
  await check("Activacion sin password, con password debil o para otro UID: denegada", async () => {
    assert.equal((await call("/admin/users/complete-first-login", token, {})).status, 422);
    assert.equal((await call("/admin/users/complete-first-login", token, { password: "corta" })).status, 422);
    assert.equal((await call("/admin/users/complete-first-login", token, { uid: administrator.uid, password: newPassword })).status, 403);
    assert.equal((await ref.get()).data().mustChangePassword, true);
  });
  await check("Cambio de password real antes de activar el perfil", async () => {
    const completed = await call("/admin/users/complete-first-login", token, { password: newPassword });
    assert.equal(completed.status, 200);
    assert.equal((await ref.get()).data().mustChangePassword, false);
  });
  const readyToken = await login("jazmin@users.base-mayorista.local", newPassword);
  await check("Ventas habilitadas; Administracion, Usuarios y privilegios directos denegados", async () => {
    const boot = await call("/admin/users/session/bootstrap", readyToken);
    assert.equal(boot.status, 200);
    assert.equal(boot.body.user.sections.pedidos, true);
    assert.equal(boot.body.user.sections.administracion, false);
    assert.equal(boot.body.user.sections.usuarios, false);
    assert.equal(boot.body.user.capabilities["cap.orders.create"], true);
    assert.equal(boot.body.user.capabilities["cap.users.invite"], false);
    assert.equal((await call("/api/operations", readyToken)).status, 200);
    assert.equal((await call("/api/admin/market-insights/latest", readyToken)).status, 403);
    assert.equal((await call("/api/wa/bot/settings", readyToken, {}, "PUT")).status, 403);
    assert.equal((await call("/api/WA/BOT/settings/", readyToken, {}, "PUT")).status, 403);
    assert.equal((await call("/admin/users/invite", readyToken, { ...invite, username: "Escalada" })).status, 403);
    assert.equal((await call("/admin/users/list", readyToken)).status, 403);
    assert.equal((await call("/admin/users/update-access", readyToken, { uid: created.uid, roleId: "super_admin", isActive: true })).status, 403);
    assert.equal(await direct("customers/sales-test", readyToken, { business_id: "bm", name: "Cliente de emulador" }, "PATCH"), 200);
    assert.equal(await direct("finance_accounts/privileged", readyToken, { business_id: "bm" }, "PATCH"), 403);
    assert.equal(await direct("roles/operativo", readyToken, { sections: { administracion: true } }, "PATCH"), 403);
    assert.equal(await direct(`users/${created.uid}`, readyToken, { roleId: "super_admin" }, "PATCH"), 403);
    assert.equal(await direct("users", readyToken), 403);
  });
  await check("La password temporal ya no permite iniciar sesion", async () => {
    await assert.rejects(login("jazmin@users.base-mayorista.local", created.temporary_password));
  });
  await check("Cuenta Auth ajena sin perfil no puede autoconcederse permisos", async () => {
    const stranger = await admin.auth().createUser({ email: "stranger@example.test", password: newPassword });
    const strangerToken = await login("stranger@example.test", newPassword);
    assert.equal(await direct(`users/${stranger.uid}`, strangerToken, { roleId: "super_admin", isActive: true }, "PATCH"), 403);
    assert.equal((await call("/admin/users/session/bootstrap", strangerToken)).status, 403);
    assert.equal((await call("/admin/users/invite", strangerToken, invite)).status, 403);
  });
  await check("Admin conserva token, UID, password y privilegios; claims obsoletos no autorizan", async () => {
    assert.equal((await admin.auth().verifyIdToken(adminToken, true)).uid, administrator.uid);
    assert.equal((await call("/admin/users/list", adminToken)).status, 200);
    await login("admin@example.test", adminPassword);
    await firestore.collection("users").doc(administrator.uid).update({ isActive: false });
    assert.equal((await call("/admin/users/list", adminToken)).status, 403);
  });
  await check("Unicidad tambien frente a perfiles antiguos sin indice", async () => {
    // Se restablece solo al administrador de prueba del emulador.
    await firestore.collection("users").doc(administrator.uid).update({ isActive: true });
    await firestore.collection("users").doc("legacy-test").set({ username: "LegacyCase" });
    assert.equal((await call("/admin/users/invite", adminToken, { ...invite, username: "legacycase" })).status, 409);
    const audits = await firestore.collection("audit_logs").get();
    assert.ok(!JSON.stringify(audits.docs.map((doc) => doc.data())).includes(created.temporary_password));
    assert.ok(!JSON.stringify(audits.docs.map((doc) => doc.data())).includes(newPassword));
  });
  await check("Fallo al asignar claims revierte Auth, perfil y reserva sin dejar cuenta huerfana", async () => {
    const auth = admin.auth();
    const original = auth.setCustomUserClaims;
    auth.setCustomUserClaims = async () => { throw new Error("emulator-injected-setup-failure"); };
    try {
      assert.equal((await call("/admin/users/invite", adminToken, { ...invite, username: "RollbackTest" })).status, 500);
    } finally {
      auth.setCustomUserClaims = original;
    }
    await assert.rejects(admin.auth().getUserByEmail("rollbacktest@users.base-mayorista.local"), { code: "auth/user-not-found" });
    assert.equal((await firestore.collection("users").where("usernameNormalized", "==", "rollbacktest").get()).empty, true);
    assert.equal((await firestore.collection("usernames").doc("rollbacktest").get()).exists, false);
  });
  await check("Un preset operativo personalizado no concede Administracion ni gestion de usuarios", async () => {
    const result = await call("/admin/users/invite", adminToken, {
      ...invite, username: "RoleSafe",
      permissions: { ...permissions, administracion: true },
      businessMemberships: { bm: { enabled: true, roleId: "super_admin", sections: { administracion: true, usuarios: true }, capabilities: { "cap.users.invite": true, "cap.finance.accounts.create": true } } },
    });
    assert.equal(result.status, 200);
    const profile = (await firestore.collection("users").doc(result.body.uid).get()).data();
    assert.equal(profile.roleId, "operativo");
    assert.equal(profile.sections.administracion, false);
    assert.equal(profile.sections.usuarios, false);
    assert.equal(profile.businessMemberships.bm.roleId, "operativo");
    assert.equal(profile.businessMemberships.bm.sections["sections.administracion"], false);
    assert.equal(profile.businessMemberships.bm.sections["sections.usuarios"], false);
    assert.equal(profile.businessMemberships.bm.capabilities["cap.users.invite"], false);
    assert.equal(profile.businessMemberships.bm.capabilities["cap.finance.accounts.create"], false);
  });
  console.log(`${passed}/${passed} PASS: solo Auth/Firestore locales del proyecto ${project}`);
} finally {
  await new Promise((done) => server.close(done));
  await admin.app().delete();
}
