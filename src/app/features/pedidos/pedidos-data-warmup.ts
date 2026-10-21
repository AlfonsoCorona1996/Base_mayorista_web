import { Injector } from "@angular/core";
import { CustomersService } from "../../core/customers.service";
import { OrdersService } from "../../core/orders.service";
import { RoutesService } from "../../core/routes.service";

/**
 * R5: empieza las lecturas de la primera lista de Pedidos en cuanto la ruta está autorizada
 * (lo llama el resolver de `main/pedidos`, que corre después de todos los guards), en paralelo
 * con la descarga y creación del componente.
 *
 * Son exactamente las lecturas que PedidosPage hace al iniciar, que las reutiliza en vez de
 * repetirlas: el listener de pedidos comparte su primer snapshot, las clientas básicas comparten
 * la lectura en curso y las rutas también. Los errores los muestra la página, no este arranque.
 */
export function startPedidosDataWarmup(injector: Injector): void {
  void injector.get(OrdersService).loadFromFirestore();
  injector.get(CustomersService).loadCustomers().catch(() => undefined);
  injector.get(RoutesService).loadFromFirestore().catch(() => undefined);
}
