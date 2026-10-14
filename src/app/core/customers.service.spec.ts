import { signal } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { BusinessScopeService } from "./business-scope.service";
import {
  CUSTOMERS_DATA_SOURCE,
  CustomersDataSource,
  CustomersService,
  RawQueryResult,
} from "./customers.service";
import { BusinessId } from "./rbac.constants";

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function result(docs: Array<Record<string, unknown>>, fromCache = false): RawQueryResult {
  return {
    fromCache,
    docs: docs.map((data) => ({ id: String(data["customer_id"] ?? data["movement_id"]), data: () => data })),
  };
}

const ANA = { customer_id: "c-ana", business_id: "bm", first_name: "Ana", last_name: "Lopez", whatsapp: "1", active: true, credit_balance: 120 };
const BETY = { customer_id: "c-bety", business_id: "bm", first_name: "Bety", last_name: "Ruiz", whatsapp: "2", active: true };
const CATA = { customer_id: "c-cata", business_id: "catalogo", first_name: "Cata", last_name: "Diaz", whatsapp: "3", active: true };
const LEGACY = { customer_id: "c-legacy", first_name: "Lola", last_name: "Legado", whatsapp: "4", active: true };

const MOVEMENTS = [
  { movement_id: "m1", business_id: "bm", customer_id: "c-ana", type: "return_credit", amount: 150 },
  { movement_id: "m2", business_id: "bm", customer_id: "c-ana", type: "application", amount: -30 },
  { movement_id: "m3", business_id: "catalogo", customer_id: "c-cata", type: "return_credit", amount: 80 },
];

/** Espera a que se drenen las promesas encadenadas pendientes. */
const settle = () => new Promise<void>((resolve) => setTimeout(resolve));

describe("CustomersService - disponibilidad separada de clientas y saldo a favor", () => {
  let service: CustomersService;
  let available: ReturnType<typeof signal<BusinessId[]>>;
  let active: ReturnType<typeof signal<BusinessId[]>>;
  let customerQueries: Deferred<RawQueryResult>[];
  let scopedQueries: Deferred<RawQueryResult>[];
  let creditQueries: Deferred<RawQueryResult>[];
  let source: jasmine.SpyObj<CustomersDataSource>;

  beforeEach(() => {
    available = signal<BusinessId[]>(["bm", "catalogo"]);
    active = signal<BusinessId[]>(["bm"]);
    customerQueries = [];
    scopedQueries = [];
    creditQueries = [];
    source = jasmine.createSpyObj<CustomersDataSource>("CustomersDataSource", [
      "fetchAllCustomers",
      "fetchCustomersByBusiness",
      "fetchCreditMovements",
    ]);
    source.fetchAllCustomers.and.callFake(() => push(customerQueries));
    source.fetchCustomersByBusiness.and.callFake(() => push(scopedQueries));
    source.fetchCreditMovements.and.callFake(() => push(creditQueries));

    TestBed.configureTestingModule({
      providers: [
        CustomersService,
        { provide: CUSTOMERS_DATA_SOURCE, useValue: source },
        {
          provide: BusinessScopeService,
          useValue: { availableBusinessIds: available, activeBusinessIds: active, writeBusinessId: () => "bm" },
        },
      ],
    });
    service = TestBed.inject(CustomersService);
  });

  function push(list: Deferred<RawQueryResult>[]): Promise<RawQueryResult> {
    const next = deferred<RawQueryResult>();
    list.push(next);
    return next.promise;
  }

  it("A. publica las clientas al terminar su consulta aunque el ledger siga pendiente", async () => {
    let completed = false;
    const full = service.loadFromFirestore().then(() => (completed = true));

    expect(service.customersStatus()).toBe("loading");
    expect(service.customersLoaded()).toBeFalse();

    customerQueries[0].resolve(result([ANA, BETY]));
    await settle();

    expect(service.customers().map((c) => c.customer_id)).toEqual(["c-ana", "c-bety"]);
    expect(service.getById("c-bety")?.first_name).toBe("Bety");
    expect(service.customersStatus()).toBe("ready");
    expect(service.creditStatus()).toBe("loading");
    expect(completed).withContext("la carga completa todavía no terminó").toBeFalse();

    creditQueries[0].resolve(result(MOVEMENTS));
    await full;
    expect(completed).toBeTrue();
    expect(service.creditStatus()).toBe("ready");
  });

  it("A. la consulta del ledger se inicia en paralelo, no después de las clientas", () => {
    void service.loadFromFirestore();
    expect(source.fetchAllCustomers).toHaveBeenCalledTimes(1);
    expect(source.fetchCreditMovements).toHaveBeenCalledTimes(1);
  });

  it("A. loadCustomers() no consulta el ledger", async () => {
    const load = service.loadCustomers();
    customerQueries[0].resolve(result([ANA]));
    await load;
    expect(source.fetchCreditMovements).not.toHaveBeenCalled();
    expect(service.creditStatus()).toBe("idle");
  });

  it("B. si el ledger falla, las clientas siguen disponibles y el crédito informa el fallo", async () => {
    const full = service.loadFromFirestore();
    customerQueries[0].resolve(result([ANA]));
    creditQueries[0].reject({ code: "permission-denied" });

    await expectAsync(full).toBeResolved();
    expect(service.customers().length).toBe(1);
    expect(service.customersStatus()).toBe("ready");
    expect(service.creditStatus()).toBe("error");
    expect(service.creditError()).toContain("historial de saldo a favor");
    expect(service.creditLoaded()).toBeFalse();
  });

  it("B. un fallo posterior del ledger conserva los movimientos válidos ya publicados", async () => {
    const first = service.loadCreditMovements();
    creditQueries[0].resolve(result(MOVEMENTS));
    await first;

    const second = service.loadCreditMovements({ force: true });
    creditQueries[1].reject(new Error("unavailable"));
    await expectAsync(second).toBeRejected();

    expect(service.creditStatus()).toBe("error");
    expect(service.creditLoaded()).toBeTrue();
    expect(service.creditMovementsFor("c-ana").length).toBe(2);
  });

  it("C. mientras la consulta está pendiente no se presenta como cargada", () => {
    void service.loadCustomers();
    expect(service.customersStatus()).toBe("loading");
    expect(service.customersLoaded()).toBeFalse();
    expect(service.customers()).toEqual([]);
  });

  it("D. si fallan ambas consultas de clientas, queda en error y la promesa rechaza", async () => {
    const load = service.loadCustomers();
    customerQueries[0].reject({ code: "permission-denied" });
    await settle();
    expect(source.fetchCustomersByBusiness).toHaveBeenCalledOnceWith(["bm", "catalogo"]);
    scopedQueries[0].reject({ code: "unavailable" });

    await expectAsync(load).toBeRejected();
    expect(service.customersStatus()).toBe("error");
    expect(service.customersError()).toBe("No se pudieron cargar las clientas.");
    expect(service.customersLoaded()).toBeFalse();
  });

  it("D. un fallo al refrescar conserva las clientas válidas ya publicadas", async () => {
    const first = service.loadCustomers();
    customerQueries[0].resolve(result([ANA]));
    await first;

    const retry = service.loadCustomers();
    customerQueries[1].reject({ code: "unavailable" });
    await settle();
    scopedQueries[0].reject({ code: "unavailable" });
    await expectAsync(retry).toBeRejected();

    expect(service.customersStatus()).toBe("error");
    expect(service.customersLoaded()).toBeTrue();
    expect(service.getById("c-ana")).not.toBeNull();
  });

  it("usa la consulta acotada por negocio cuando la legacy falla", async () => {
    const load = service.loadCustomers();
    customerQueries[0].reject({ code: "permission-denied" });
    await settle();
    scopedQueries[0].resolve(result([ANA, CATA]));
    await load;
    expect(service.customers().map((c) => c.customer_id)).toEqual(["c-ana"]);
  });

  it("F. llamadas concurrentes y reintentos comparten la misma lectura", async () => {
    const a = service.loadCustomers();
    const b = service.loadCustomers();

    expect(source.fetchAllCustomers).toHaveBeenCalledTimes(1);
    expect(b).toBe(a);

    customerQueries[0].resolve(result([ANA]));
    await Promise.all([a, b]);

    // Un reintento después de terminar abre exactamente una lectura nueva.
    const retry1 = service.loadCustomers();
    const retry2 = service.loadCustomers();
    expect(source.fetchAllCustomers).toHaveBeenCalledTimes(2);
    customerQueries[1].resolve(result([ANA]));
    await Promise.all([retry1, retry2]);
  });

  it("F. un reintento tras un error no multiplica consultas", async () => {
    const load = service.loadCustomers();
    customerQueries[0].reject({ code: "unavailable" });
    await settle();
    scopedQueries[0].reject({ code: "unavailable" });
    await expectAsync(load).toBeRejected();

    void service.loadCustomers().catch(() => null);
    void service.loadCustomers().catch(() => null);
    void service.loadCustomers().catch(() => null);
    expect(source.fetchAllCustomers).toHaveBeenCalledTimes(2);
  });

  it("G. cambiar de negocio filtra al instante sin consultar de nuevo ni dejar clientas del otro negocio", async () => {
    const load = service.loadCustomers();
    customerQueries[0].resolve(result([ANA, CATA, LEGACY]));
    await load;

    expect(service.customers().map((c) => c.customer_id).sort()).toEqual(["c-ana", "c-legacy"]);

    active.set(["catalogo"]);
    expect(service.customers().map((c) => c.customer_id).sort()).toEqual(["c-cata", "c-legacy"]);
    expect(service.getById("c-ana")).toBeNull();

    active.set(["bm", "catalogo"]);
    expect(service.customers().length).toBe(3);
    expect(source.fetchAllCustomers).toHaveBeenCalledTimes(1);
  });

  it("G. si cambian los negocios autorizados se descartan los datos leídos con el permiso anterior", async () => {
    const load = service.loadCustomers();
    customerQueries[0].resolve(result([ANA, CATA]));
    await load;

    available.set(["catalogo"]);
    active.set(["catalogo"]);
    void service.loadCustomers();

    expect(service.customers()).toEqual([]);
    expect(service.customersLoaded()).toBeFalse();
    expect(service.customersStatus()).toBe("loading");
  });

  it("G. el historial de crédito también se filtra al negocio activo", async () => {
    const load = service.loadCreditMovements();
    creditQueries[0].resolve(result(MOVEMENTS));
    await load;

    expect(service.creditMovements().map((m) => m.movement_id)).toEqual(["m1", "m2"]);
    active.set(["catalogo"]);
    expect(service.creditMovements().map((m) => m.movement_id)).toEqual(["m3"]);
  });

  it("H. una respuesta vieja no reemplaza una carga más reciente", async () => {
    let oldDone = false;
    const oldLoad = service.loadCustomers().then(() => (oldDone = true));
    const newLoad = service.loadCustomers({ force: true });
    expect(source.fetchAllCustomers).toHaveBeenCalledTimes(2);

    customerQueries[1].resolve(result([BETY]));
    await newLoad;
    expect(service.customers().map((c) => c.customer_id)).toEqual(["c-bety"]);

    customerQueries[0].resolve(result([ANA]));
    await oldLoad;
    expect(oldDone).toBeTrue();
    expect(service.customers().map((c) => c.customer_id)).toEqual(["c-bety"]);
  });

  it("H. una respuesta anterior se publica si la nueva aún no llega, y la nueva la reemplaza", async () => {
    const oldLoad = service.loadCustomers();
    const newLoad = service.loadCustomers({ force: true });

    customerQueries[0].resolve(result([ANA]));
    await oldLoad;
    expect(service.customers().map((c) => c.customer_id)).toEqual(["c-ana"]);

    customerQueries[1].resolve(result([BETY]));
    await newLoad;
    expect(service.customers().map((c) => c.customer_id)).toEqual(["c-bety"]);
  });

  it("4. si la carga nueva falla, no se descarta el resultado válido de la anterior", async () => {
    const oldLoad = service.loadCustomers();
    const newLoad = service.loadCustomers({ force: true });

    customerQueries[1].reject({ code: "unavailable" });
    await settle();
    scopedQueries[0].reject({ code: "unavailable" });
    await expectAsync(newLoad).toBeRejected();
    expect(service.customersStatus()).toBe("error");

    customerQueries[0].resolve(result([ANA]));
    await oldLoad;
    expect(service.getById("c-ana")).not.toBeNull();
    expect(service.customersStatus()).toBe("ready");
    expect(service.customersError()).toBeNull();
  });

  it("4. la carga completa no reutiliza una lectura iniciada antes (p. ej. antes de una devolución)", async () => {
    const before = service.loadCustomers();
    const full = service.loadFromFirestore();
    expect(source.fetchAllCustomers).withContext("lectura nueva, no compartida").toHaveBeenCalledTimes(2);

    // La lectura vieja trae el saldo previo y llega después: no debe pisar el saldo nuevo.
    customerQueries[1].resolve(result([{ ...ANA, credit_balance: 300 }]));
    creditQueries[0].resolve(result(MOVEMENTS));
    await full;
    customerQueries[0].resolve(result([{ ...ANA, credit_balance: 120 }]));
    await before;

    expect(service.getById("c-ana")?.credit_balance).toBe(300);
  });

  it("4. la carga completa espera su propia lectura aunque la anterior llegue primero", async () => {
    let fullDone = false;
    void service.loadCustomers();
    const full = service.loadFromFirestore().then(() => (fullDone = true));

    customerQueries[0].resolve(result([{ ...ANA, credit_balance: 120 }]));
    creditQueries[0].resolve(result([]));
    await settle();
    expect(fullDone).withContext("aún falta la lectura posterior a la escritura").toBeFalse();

    customerQueries[1].resolve(result([{ ...ANA, credit_balance: 300 }]));
    await full;
    expect(service.getById("c-ana")?.credit_balance).toBe(300);
  });

  it("H. el error de una carga obsoleta no marca error sobre la vigente", async () => {
    const oldLoad = service.loadCustomers();
    const newLoad = service.loadCustomers({ force: true });

    customerQueries[1].resolve(result([BETY]));
    await newLoad;
    customerQueries[0].reject({ code: "unavailable" });
    await oldLoad;

    expect(service.customersStatus()).toBe("ready");
    expect(service.customersError()).toBeNull();
    expect(source.fetchCustomersByBusiness).not.toHaveBeenCalled();
  });

  it("I. la ficha de clienta recibe el historial completo y el saldo de la ficha intacto", async () => {
    const full = service.loadFromFirestore();
    customerQueries[0].resolve(result([ANA, BETY]));
    creditQueries[0].resolve(result(MOVEMENTS));
    await full;

    const movements = service.creditMovementsFor("c-ana");
    expect(movements.map((m) => [m.movement_id, m.type, m.amount])).toEqual([
      ["m1", "return_credit", 150],
      ["m2", "application", -30],
    ]);
    expect(service.creditMovementsFor("c-bety")).toEqual([]);
    expect(service.getById("c-ana")?.credit_balance).toBe(120);
    expect(service.creditLoaded()).toBeTrue();
  });

  it("I. cada carga completa (también tras escribir) hace lecturas nuevas aunque haya otra en curso", async () => {
    void service.loadFromFirestore();
    const reload = service.loadFromFirestore();
    expect(source.fetchAllCustomers).toHaveBeenCalledTimes(2);
    expect(source.fetchCreditMovements).toHaveBeenCalledTimes(2);

    customerQueries[0].resolve(result([ANA]));
    creditQueries[0].resolve(result([]));
    customerQueries[1].resolve(result([ANA, BETY]));
    creditQueries[1].resolve(result(MOVEMENTS));
    await reload;
    expect(service.customers().length).toBe(2);
    expect(service.creditMovements().length).toBe(2);
  });

  it("registra el origen caché/servidor del último resultado", async () => {
    const load = service.loadCustomers();
    customerQueries[0].resolve(result([ANA], true));
    await load;
    expect(service.customersSource()).toBe("cache");
  });
});
