import { BusinessPositionInput, calculateBusinessPosition } from "./business-position";

// Cifras reales de BM al corte del 25 de agosto de 2026, con los tres retiros
// del 4 de mayo ya reclasificados como gasto.
const BM: BusinessPositionInput = {
  collectedRevenue: 226_455.73,
  pendingCollection: 50_696.2,
  deliveredNetCost: 184_403.12,
  inventoryReservedAtCost: 35_457.28,
  inventoryAvailableAtCost: 16_513,
  merchandiseInTransitAtCost: 36_675.28,
  expensesTotal: 10_273.3,
  partnerWithdrawals: 21_689.3,
  unclassifiedWithdrawals: 0,
  accruedNetProfit: 82_475.51,
  declaredAccountsBalance: 0,
  accountCount: 0,
};

describe("posicion del negocio", () => {
  it("cuadra las dos columnas al centavo", () => {
    const position = calculateBusinessPosition(BM);

    expect(position.totalAssets).toBeCloseTo(139_341.76, 2);
    expect(position.partnerEquity).toBeCloseTo(60_786.21, 2);
    expect(position.unregisteredFunding).toBeCloseTo(78_555.55, 2);
    expect(position.balanceCheck).toBe(0);
  });

  it("deriva la mercancia comprada y la caja teorica", () => {
    const position = calculateBusinessPosition(BM);

    expect(position.merchandisePurchased).toBeCloseTo(273_048.68, 2);
    expect(position.theoreticalCash).toBeCloseTo(-78_555.55, 2);
    expect(position.hasRegisteredAccounts).toBeFalse();
    expect(position.effectiveCash).toBe(0);
  });

  it("separa la mercancia que ya tiene comprador de la que no", () => {
    const position = calculateBusinessPosition(BM);

    expect(position.committedToCash).toBeCloseTo(122_828.76, 2);
    expect(position.awaitingSale).toBe(16_513);
    expect(position.rungs.map((rung) => rung.id)).toEqual([
      "cash",
      "receivable",
      "transit",
      "reserved",
      "available",
    ]);
    expect(position.rungs.reduce((sum, rung) => sum + rung.amount, 0)).toBeCloseTo(position.totalAssets, 2);
  });

  it("reclasificar un retiro como gasto no mueve el balance, solo a quien pertenece", () => {
    const antes = calculateBusinessPosition({
      ...BM,
      expensesTotal: 1_500,
      partnerWithdrawals: 21_689.3,
      unclassifiedWithdrawals: 8_773.3,
      accruedNetProfit: 91_248.81,
    });
    const despues = calculateBusinessPosition(BM);

    expect(antes.totalAssets).toBeCloseTo(despues.totalAssets, 2);
    expect(antes.theoreticalCash).toBeCloseTo(despues.theoreticalCash, 2);
    expect(antes.partnerEquity).toBeCloseTo(despues.partnerEquity, 2);
  });

  it("registrar bodega que faltaba sube el financiamiento no registrado", () => {
    const base = calculateBusinessPosition(BM);
    const conBodega = calculateBusinessPosition({
      ...BM,
      inventoryAvailableAtCost: BM.inventoryAvailableAtCost + 20_000,
    });

    // Esa mercancia se compro con dinero que tampoco esta capturado, asi que
    // registrarla revela mas aportacion, no mas utilidad.
    expect(conBodega.unregisteredFunding).toBeCloseTo(base.unregisteredFunding + 20_000, 2);
    expect(conBodega.partnerEquity).toBeCloseTo(base.partnerEquity, 2);
    expect(conBodega.balanceCheck).toBe(0);
  });

  it("usa el saldo capturado cuando si hay cuentas registradas", () => {
    const position = calculateBusinessPosition({ ...BM, declaredAccountsBalance: 12_000, accountCount: 2 });

    expect(position.effectiveCash).toBe(12_000);
    expect(position.totalAssets).toBeCloseTo(151_341.76, 2);
    expect(position.unregisteredFunding).toBeCloseTo(90_555.55, 2);
    expect(position.balanceCheck).toBe(0);
  });
});
