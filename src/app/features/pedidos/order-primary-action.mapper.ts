import { Order, OrderStatus } from "../../core/orders.service";

export type PrimaryAction = {
  label: string;
  actionId: string;
  route: string;
  disabled: boolean;
  disabledReason?: string;
};

export type ActionChecklist = {
  items: { ok: boolean; text: string }[];
  blocking: boolean;
};

type OrderSummary = Pick<Order, "order_id" | "status" | "items" | "packages" | "planned_packages">;

const DISABLED_ITEMS_REASON = "Agrega al menos 1 producto";
const DISABLED_PACKAGES_REASON = "Crea y cierra al menos 1 paquete";

export function getPrimaryAction(order: OrderSummary): PrimaryAction {
  const itemsCount = order.items?.length ?? 0;
  const packagesCount = order.packages?.length ?? 0;
  const route = `/main/pedidos/${order.order_id}`;

  const byStatus: Partial<Record<OrderStatus, PrimaryAction>> = {
    borrador: {
      label: "Completar pedido",
      actionId: "complete_order",
      route,
      disabled: itemsCount === 0,
      disabledReason: itemsCount === 0 ? DISABLED_ITEMS_REASON : undefined,
    },
    confirmando_proveedor: {
      label: "Confirmar existencias",
      actionId: "confirm_stock",
      route,
      disabled: itemsCount === 0,
      disabledReason: itemsCount === 0 ? DISABLED_ITEMS_REASON : undefined,
    },
    reservado_inventario: {
      label: "Confirmar existencias",
      actionId: "confirm_stock",
      route,
      disabled: itemsCount === 0,
      disabledReason: itemsCount === 0 ? DISABLED_ITEMS_REASON : undefined,
    },
    solicitado_proveedor: {
      label: "Confirmar existencias",
      actionId: "confirm_stock",
      route,
      disabled: itemsCount === 0,
      disabledReason: itemsCount === 0 ? DISABLED_ITEMS_REASON : undefined,
    },
    en_transito: {
      label: "Confirmar existencias",
      actionId: "confirm_stock",
      route,
      disabled: itemsCount === 0,
      disabledReason: itemsCount === 0 ? DISABLED_ITEMS_REASON : undefined,
    },
    recibido_qa: {
      label: "Preparar salida",
      actionId: "prepare_dispatch",
      route,
      disabled: itemsCount === 0,
      disabledReason: itemsCount === 0 ? DISABLED_ITEMS_REASON : undefined,
    },
    empaque: {
      label: "Empacar",
      actionId: "pack_order",
      route,
      disabled: itemsCount === 0,
      disabledReason: itemsCount === 0 ? DISABLED_ITEMS_REASON : undefined,
    },
    en_ruta: {
      label: "Registrar entrega/cobro",
      actionId: "register_delivery_payment",
      route,
      disabled: packagesCount === 0,
      disabledReason: packagesCount === 0 ? DISABLED_PACKAGES_REASON : undefined,
    },
    entregado: {
      label: "Ver resumen",
      actionId: "view_summary",
      route,
      disabled: false,
    },
    pago_pendiente: {
      label: "Cobranza pendiente",
      actionId: "payment_pending",
      route,
      disabled: false,
    },
    pagado: {
      label: "Ver resumen",
      actionId: "view_summary",
      route,
      disabled: false,
    },
    cancelado: {
      label: "Gestionar devolución",
      actionId: "manage_return",
      route,
      disabled: false,
    },
    devuelto: {
      label: "Gestionar devolución",
      actionId: "manage_return",
      route,
      disabled: false,
    },
  };

  return (
    byStatus[order.status] || {
      label: "Ver detalle",
      actionId: "view_detail",
      route,
      disabled: false,
    }
  );
}

export function getActionChecklist(order: OrderSummary, actionId: string): ActionChecklist {
  const itemsCount = order.items?.length ?? 0;
  const plannedPackages = order.planned_packages ?? null;
  const assignedItemIds = new Set<string>();
  for (const pkg of order.packages || []) {
    for (const id of pkg.item_ids || []) assignedItemIds.add(id);
  }
  const unassignedItems = (order.items || []).filter((item) => {
    const isConfirmed = !["entregado", "pagado", "cancelado", "devuelto"].includes(item.state);
    return isConfirmed && !assignedItemIds.has(item.item_id);
  });
  const closedPackages = (order.packages || []).filter((pkg) =>
    ["armado", "en_ruta", "entregado"].includes(pkg.state)
  ).length;
  const deliveredPackages = (order.packages || []).filter((pkg) => pkg.state === "entregado").length;

  const listByAction: Record<string, { ok: boolean; text: string }[]> = {
    complete_order: [
      { ok: itemsCount > 0, text: "Pedido con al menos 1 producto" },
    ],
    confirm_stock: [
      { ok: itemsCount > 0, text: "Productos cargados para confirmar existencias" },
    ],
    pack_order: [
      { ok: itemsCount > 0, text: "Productos listos para empaque" },
    ],
    prepare_dispatch: [
      { ok: plannedPackages !== null, text: "Paquetes planificados definidos" },
      { ok: plannedPackages !== null && closedPackages >= plannedPackages, text: "Paquetes cerrados completos" },
      { ok: unassignedItems.length === 0, text: "Todos los items asignados a un paquete" },
    ],
    register_delivery_payment: [
      { ok: plannedPackages !== null, text: "Paquetes planificados definidos" },
      { ok: plannedPackages !== null && deliveredPackages >= plannedPackages, text: "Paquetes entregados completos" },
    ],
    payment_pending: [
      { ok: true, text: "Cobranza identificada para el pedido" },
    ],
    manage_return: [
      { ok: true, text: "Incidencia registrada para devolución" },
    ],
    view_summary: [
      { ok: true, text: "Resumen disponible para revisión" },
    ],
    view_detail: [
      { ok: true, text: "Detalle disponible del pedido" },
    ],
  };

  const items = listByAction[actionId] || [{ ok: true, text: "Revisión disponible" }];
  return {
    items,
    blocking: items.some((item) => !item.ok),
  };
}
