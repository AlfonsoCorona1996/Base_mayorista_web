import { TestBed } from "@angular/core/testing";
import { provideHttpClient } from "@angular/common/http";
import { connectAuthEmulator, createUserWithEmailAndPassword } from "firebase/auth";
import { connectFirestoreEmulator, deleteDoc, doc, getDoc, setDoc } from "firebase/firestore";

import { CAPABILITY_KEYS, SECTION_KEYS } from "./rbac.constants";
import { FIRESTORE, FIREBASE_AUTH } from "./firebase.providers";
import { InventoryService } from "./inventory.service";
import { OrdersService } from "./orders.service";
import { SupplierOperationsService } from "./supplier-operations.service";

/**
 * Prueba de integracion contra el emulador local de Firebase (Firestore + Auth).
 * NO corre en `npm test` normal (ver angular.json / README): solo se ejecuta
 * explicitamente con los emuladores levantados, ej.:
 *   npx firebase --config firebase.emulator-test.json emulators:start --project demo-test --only firestore,auth
 *   npx ng test --include=\"**\/orders-delete-inventory-release.emulator.spec.ts\"
 *
 * Usa firebase.emulator-test.json / firestore.emulator-test.rules (reglas
 * permisivas SOLO para el emulador local) porque la version del emulador de
 * Firestore que trae firebase-tools hoy no soporta `.exists()` como metodo
 * sobre el resultado de get(), sintaxis que si usa el firestore.rules real de
 * produccion. El firestore.rules/firebase.json reales no se tocan.
 *
 * Cubre la regresion: OrdersService.deleteOrder() debia liberar el inventario
 * reservado (directo y de proveedor) antes de borrar el pedido.
 */
let emulatorsConnected = false;

function connectEmulatorsOnce(): void {
  if (emulatorsConnected) return;
  connectFirestoreEmulator(FIRESTORE, "127.0.0.1", 8080);
  connectAuthEmulator(FIREBASE_AUTH, "http://127.0.0.1:9099", { disableWarnings: true });
  emulatorsConnected = true;
}

function baseInventoryDoc(overrides: Record<string, unknown>) {
  const nowIso = new Date().toISOString();
  return {
    business_id: "bm",
    title: "Producto de prueba",
    category_hint: null,
    supplier_id: null,
    variant_name: null,
    color_name: null,
    size_label: null,
    unit_price: 100,
    notes: null,
    image_urls: [],
    source_reason: "ajuste_manual",
    reservations: {},
    idempotency_keys: {},
    created_at: nowIso,
    updated_at: nowIso,
    ...overrides,
  };
}

describe("OrdersService.deleteOrder — liberacion de inventario (emulador)", () => {
  beforeAll(async () => {
    connectEmulatorsOnce();
    TestBed.configureTestingModule({ providers: [provideHttpClient()] });

    const email = `test-${Date.now()}@example.com`;
    const cred = await createUserWithEmailAndPassword(FIREBASE_AUTH, email, "Test1234!");
    const uid = cred.user.uid;

    const capabilities = Object.fromEntries(CAPABILITY_KEYS.map((key) => [key, true]));
    const sections = Object.fromEntries(SECTION_KEYS.map((key) => [key, true]));

    await setDoc(doc(FIRESTORE, "users", uid), {
      isActive: true,
      roleId: "super_admin",
      displayName: "Test Runner",
      sections,
      capabilities,
      businessMemberships: {
        bm: { businessId: "bm", enabled: true, roleId: "super_admin" },
      },
    });
  });

  it("libera la reserva directa de inventario y la de proveedor al borrar el pedido", async () => {
    const inventory = TestBed.inject(InventoryService);
    const orders = TestBed.inject(OrdersService);
    const supplierOps = TestBed.inject(SupplierOperationsService);

    const stamp = Date.now();
    const orderId = `test-order-${stamp}`;
    const invIdDirect = `test-inv-direct-${stamp}`;
    const invIdSupplier = `test-inv-supplier-${stamp}`;
    const opId = `op-${orderId}-item-supplier-1`;

    // Item de inventario propio: se reserva desde que se agrega al pedido.
    await setDoc(
      doc(FIRESTORE, "inventory_items", invIdDirect),
      baseInventoryDoc({
        inventory_id: invIdDirect,
        title: "Producto directo",
        quantity_on_hand: 10,
        on_hand_qty: 10,
        reserved_qty: 0,
        available_qty: 10,
      }),
    );

    // Item de proveedor: se reserva solo cuando llega fisicamente (receiveLineAndAllocate).
    await setDoc(
      doc(FIRESTORE, "inventory_items", invIdSupplier),
      baseInventoryDoc({
        inventory_id: invIdSupplier,
        title: "Producto proveedor",
        quantity_on_hand: 5,
        on_hand_qty: 5,
        reserved_qty: 0,
        available_qty: 5,
      }),
    );

    await inventory.loadFromFirestore();

    // Reserva real via el codigo de produccion (no seed a mano) para el item de inventario propio.
    await inventory.reserveStock({
      sku: invIdDirect,
      qty: 3,
      orderId,
      orderItemId: "item-direct-1",
      idempotencyKey: `seed_reserve_${orderId}_item-direct-1`,
    });

    // Simula el resultado de receiveLineAndAllocate: mercancia de proveedor ya
    // recibida y reservada para este pedido (reserved_qty=2 aplicado en el item de inventario).
    await setDoc(
      doc(FIRESTORE, "inventory_items", invIdSupplier),
      {
        reserved_qty: 2,
        available_qty: 3,
        quantity_on_hand: 3,
        reservations: {
          [orderId]: { qty: 2, order_number: orderId, status: "reserved", updated_at: new Date().toISOString() },
        },
      },
      { merge: true },
    );
    await setDoc(doc(FIRESTORE, "supplier_operations", opId), {
      op_id: opId,
      business_id: "bm",
      order_id: orderId,
      reserved_for_order_id: orderId,
      order_item_id: "item-supplier-1",
      supplier_id: "sup-test",
      supplier_name: "Proveedor Test",
      customer_id: "cust-test",
      customer_name: "Clienta Test",
      title: "Producto proveedor",
      variant: null,
      color: null,
      image_url: null,
      quantity: 2,
      price_cost: 50,
      product_id: null,
      variant_id: null,
      status: "recibido",
      inventory_item_id: invIdSupplier,
      received_to_inventory: true,
      reservation_applied: true,
      received_qty: 2,
      reserved_qty_for_order: 2,
      idempotency_keys: {},
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    // Pedido con un item de inventario propio (con inventory_id) y uno de proveedor
    // (sin inventory_id en el item de la orden: esa liga solo vive en supplier_operations,
    // que es como lo hace el codigo real — ver supplier-operations.service.ts).
    await setDoc(doc(FIRESTORE, "orders", orderId), {
      order_id: orderId,
      business_id: "bm",
      customer_id: "cust-test",
      route_id: null,
      status: "recibido_qa",
      items: [
        {
          item_id: "item-direct-1",
          title: "Producto directo",
          quantity: 3,
          confirmed_qty: 3,
          returned_qty: 0,
          source: "inventario",
          state: "reservado_inventario",
          inventory_id: invIdDirect,
        },
        {
          item_id: "item-supplier-1",
          title: "Producto proveedor",
          quantity: 2,
          confirmed_qty: 2,
          returned_qty: 0,
          source: "catalogo",
          state: "recibido_qa",
          supplier_id: "sup-test",
          inventory_id: null,
        },
      ],
      packages: [],
      timeline: [],
      packing: { status: "in_progress", packages_count: 0 },
      dispatch_request: { status: "none" },
      totals: { total_amount: 0, paid_amount: 0, balance_due: 0 },
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    await orders.loadFromFirestore();
    await supplierOps.loadFromFirestore();

    // --- Estado antes de borrar: confirma que la reserva quedo aplicada ---
    const directBefore = (await getDoc(doc(FIRESTORE, "inventory_items", invIdDirect))).data();
    expect(directBefore?.["reserved_qty"]).toBe(3);
    expect(directBefore?.["available_qty"]).toBe(7);

    // --- Accion bajo prueba ---
    await orders.deleteOrder(orderId);

    // --- El pedido ya no existe ---
    const orderAfter = await getDoc(doc(FIRESTORE, "orders", orderId));
    expect(orderAfter.exists()).toBeFalse();

    // --- La operacion de proveedor tambien se borro ---
    const opAfter = await getDoc(doc(FIRESTORE, "supplier_operations", opId));
    expect(opAfter.exists()).toBeFalse();

    // --- La reserva directa se libero (este era el bug: quedaba huerfana) ---
    const directAfter = (await getDoc(doc(FIRESTORE, "inventory_items", invIdDirect))).data();
    expect(directAfter?.["reserved_qty"]).toBe(0);
    expect(directAfter?.["available_qty"]).toBe(10);
    expect((directAfter?.["reservations"] as Record<string, unknown>)?.[orderId]).toBeUndefined();

    // --- La reserva de proveedor tambien se libero ---
    const supplierAfter = (await getDoc(doc(FIRESTORE, "inventory_items", invIdSupplier))).data();
    expect(supplierAfter?.["reserved_qty"]).toBe(0);
    expect(supplierAfter?.["available_qty"]).toBe(5);
    expect((supplierAfter?.["reservations"] as Record<string, unknown>)?.[orderId]).toBeUndefined();
  });
});
