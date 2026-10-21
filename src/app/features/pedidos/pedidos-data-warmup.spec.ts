import { Component, EnvironmentInjector } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { Router, provideRouter } from "@angular/router";
import { pedidosDataWarmup } from "../../app.routes";
import { CustomersService } from "../../core/customers.service";
import { OrdersService } from "../../core/orders.service";
import { RoutesService } from "../../core/routes.service";
import { startPedidosDataWarmup } from "./pedidos-data-warmup";

@Component({ template: "" })
class DummyPage {}

/**
 * R5: las lecturas de Pedidos empiezan en el resolver de la ruta, que Angular ejecuta solo
 * después de todos los guards. Nunca antes de autorizar el acceso.
 */
describe("Arranque de datos de Pedidos (R5)", () => {
  let orders: jasmine.SpyObj<OrdersService>;
  let customers: jasmine.SpyObj<CustomersService>;
  let routes: jasmine.SpyObj<RoutesService>;
  const waitFor = async (check: () => boolean) => {
    for (let i = 0; i < 100 && !check(); i++) await new Promise((r) => setTimeout(r, 10));
  };

  function setup(guard: () => boolean) {
    orders = jasmine.createSpyObj<OrdersService>("OrdersService", ["loadFromFirestore"]);
    customers = jasmine.createSpyObj<CustomersService>("CustomersService", ["loadCustomers"]);
    routes = jasmine.createSpyObj<RoutesService>("RoutesService", ["loadFromFirestore"]);
    orders.loadFromFirestore.and.resolveTo();
    customers.loadCustomers.and.resolveTo();
    routes.loadFromFirestore.and.resolveTo();
    TestBed.configureTestingModule({
      providers: [
        provideRouter([
          { path: "pedidos", canActivate: [guard], resolve: { dataWarmup: pedidosDataWarmup }, component: DummyPage },
          { path: "", component: DummyPage },
        ]),
        { provide: OrdersService, useValue: orders },
        { provide: CustomersService, useValue: customers },
        { provide: RoutesService, useValue: routes },
      ],
    });
    return TestBed.inject(Router);
  }

  it("con la ruta autorizada empieza pedidos, clientas y rutas una sola vez", async () => {
    const router = setup(() => true);
    expect(await router.navigateByUrl("/pedidos")).toBeTrue();
    await waitFor(() => routes.loadFromFirestore.calls.count() > 0);
    expect(orders.loadFromFirestore).toHaveBeenCalledTimes(1);
    expect(customers.loadCustomers).toHaveBeenCalledOnceWith();
    expect(routes.loadFromFirestore).toHaveBeenCalledTimes(1);
  });

  it("si un guard rechaza la ruta, no lee ningún dato", async () => {
    const router = setup(() => false);
    expect(await router.navigateByUrl("/pedidos")).toBeFalse();
    await new Promise((r) => setTimeout(r, 80));
    expect(orders.loadFromFirestore).not.toHaveBeenCalled();
    expect(customers.loadCustomers).not.toHaveBeenCalled();
    expect(routes.loadFromFirestore).not.toHaveBeenCalled();
  });

  it("no bloquea la navegación aunque las lecturas sigan pendientes o fallen", async () => {
    const router = setup(() => true);
    orders.loadFromFirestore.and.returnValue(new Promise<void>(() => undefined));
    customers.loadCustomers.and.rejectWith(new Error("permission-denied"));
    routes.loadFromFirestore.and.rejectWith(new Error("unavailable"));
    expect(await router.navigateByUrl("/pedidos")).toBeTrue();
    expect(router.url).toBe("/pedidos");
  });

  it("startPedidosDataWarmup llama a las mismas cargas que la página reutiliza", () => {
    setup(() => true);
    startPedidosDataWarmup(TestBed.inject(EnvironmentInjector));
    expect(orders.loadFromFirestore).toHaveBeenCalledTimes(1);
    expect(customers.loadCustomers).toHaveBeenCalledTimes(1);
    expect(routes.loadFromFirestore).toHaveBeenCalledTimes(1);
  });
});
