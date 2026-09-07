import { money } from "./order-financials";

/**
 * Posicion del negocio: donde esta el dinero y de quien es.
 *
 * Se apoya en una identidad contable, no en una cuenta capturada a mano:
 *
 *   caja teorica = cobros - compras de mercancia - gastos - retiros
 *
 * y como  cobros = ventas netas - por cobrar  y  utilidad = ventas netas -
 * costo - gastos, se llega a:
 *
 *   caja + por cobrar + mercancia = utilidad - retiros + dinero sin registrar
 *
 * O sea: todo lo que el negocio tiene siempre es igual a la utilidad que
 * todavia no se reparte, mas el dinero que entro sin registrarse.
 */
export interface BusinessPositionInput {
  /** Dinero cobrado de pedidos entregados. */
  collectedRevenue: number;
  /** Saldo entregado pendiente de liquidar. */
  pendingCollection: number;
  /** Costo neto de la mercancia ya vendida. */
  deliveredNetCost: number;
  /** Costo de la mercancia apartada para pedidos en curso. */
  inventoryReservedAtCost: number;
  /** Costo de la mercancia libre en bodega, sin comprador todavia. */
  inventoryAvailableAtCost: number;
  /** Costo de la mercancia comprada que aun no se entrega. */
  merchandiseInTransitAtCost: number;
  /** Gastos operativos (sin compra de mercancia). */
  expensesTotal: number;
  /** Retiros de socios. */
  partnerWithdrawals: number;
  /** Salidas de dinero que no son ni gasto ni reparto de socio. */
  unclassifiedWithdrawals: number;
  /** Utilidad neta generada. */
  accruedNetProfit: number;
  /** Suma de saldos de las cuentas financieras capturadas. */
  declaredAccountsBalance: number;
  /** Cuantas cuentas financieras existen. */
  accountCount: number;
}

/** Un peldano de la escalera de liquidez: que tan cerca esta de ser efectivo. */
export interface PositionRung {
  id: "cash" | "receivable" | "transit" | "reserved" | "available";
  label: string;
  hint: string;
  amount: number;
  /** 0 ya es dinero, 4 es lo mas lejos de serlo. */
  distance: number;
}

export interface BusinessPosition {
  /** Mercancia comprada desde el inicio, derivada de lo vendido mas lo que queda. */
  merchandisePurchased: number;
  /** Total en mercancia: bodega mas transito. */
  merchandiseTotal: number;
  /** Efectivo que deberia existir segun todos los movimientos. Puede ser negativo. */
  theoreticalCash: number;
  /** Saldo capturado en cuentas. */
  declaredCash: number;
  /** Se usa el saldo capturado si hay cuentas; si no, se asume cero. */
  effectiveCash: number;
  /**
   * Dinero que entro al negocio y nunca se registro: inversion inicial,
   * tarjeta de credito, credito de proveedor o ingresos sin capturar.
   * No es una perdida: es el dato que falta.
   *
   * Es un piso, no un total: cada peso de bodega que se registre lo sube,
   * porque esa mercancia se compro con dinero que tampoco esta capturado.
   */
  unregisteredFunding: number;
  /** Todo lo que el negocio tiene hoy. */
  totalAssets: number;
  /** Utilidad generada que todavia no se reparte. */
  partnerEquity: number;
  /** Diferencia entre las dos columnas. Debe ser cero salvo redondeo. */
  balanceCheck: number;
  hasRegisteredAccounts: boolean;
  /** Lo que se vuelve efectivo pronto: cobranza y mercancia ya vendida. */
  committedToCash: number;
  /** Mercancia sin comprador: solo se vuelve dinero cuando se venda. */
  awaitingSale: number;
  /** Escalera de liquidez, de lo mas liquido a lo menos. */
  rungs: PositionRung[];
}

export function calculateBusinessPosition(input: BusinessPositionInput): BusinessPosition {
  const totalWithdrawals = money(input.partnerWithdrawals + input.unclassifiedWithdrawals);
  const reserved = money(input.inventoryReservedAtCost);
  const available = money(input.inventoryAvailableAtCost);
  const transit = money(input.merchandiseInTransitAtCost);
  const inventoryTotal = money(reserved + available);

  // Todo lo que alguna vez fue mercancia: lo que ya se vendio, lo que queda en
  // bodega y lo que viene en camino. Es el egreso mas grande del negocio y hoy
  // no existe ningun registro directo de el.
  const merchandisePurchased = money(input.deliveredNetCost + inventoryTotal + transit);

  const theoreticalCash = money(
    input.collectedRevenue - merchandisePurchased - input.expensesTotal - totalWithdrawals,
  );

  const declaredCash = money(input.declaredAccountsBalance);
  const hasRegisteredAccounts = input.accountCount > 0;
  const effectiveCash = hasRegisteredAccounts ? declaredCash : 0;

  const unregisteredFunding = money(effectiveCash - theoreticalCash);
  const totalAssets = money(effectiveCash + input.pendingCollection + transit + inventoryTotal);
  const partnerEquity = money(input.accruedNetProfit - totalWithdrawals);

  const rungs: PositionRung[] = [
    // Es el saldo conciliado, no la caja calculada: esta linea suma dentro de
    // los activos y tiene que cuadrar con el balance.
    { id: "cash", label: "Caja", hint: "Saldo conciliado en cuentas", amount: effectiveCash, distance: 0 },
    {
      id: "receivable",
      label: "Por cobrar",
      hint: "Entregado, falta que paguen",
      amount: money(input.pendingCollection),
      distance: 1,
    },
    {
      id: "transit",
      label: "Mercancia en transito",
      hint: "Ya vendida, falta entregar",
      amount: transit,
      distance: 2,
    },
    {
      id: "reserved",
      label: "Inventario apartado",
      hint: "Comprometido a pedidos en curso",
      amount: reserved,
      distance: 3,
    },
    {
      id: "available",
      label: "Inventario disponible",
      hint: "Sin comprador todavia",
      amount: available,
      distance: 4,
    },
  ];

  return {
    merchandisePurchased,
    merchandiseTotal: money(inventoryTotal + transit),
    theoreticalCash,
    declaredCash,
    effectiveCash,
    unregisteredFunding,
    totalAssets,
    partnerEquity,
    balanceCheck: money(totalAssets - partnerEquity - unregisteredFunding),
    hasRegisteredAccounts,
    committedToCash: money(effectiveCash + input.pendingCollection + transit + reserved),
    awaitingSale: available,
    rungs,
  };
}
