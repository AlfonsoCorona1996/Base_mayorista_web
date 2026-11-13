import { businessDateKey, ledgerEntryPayload, monthIdFromDateInput, periodCanReceiveMovements, sumLedgerCash } from "./finance-ledger";

describe("finance ledger", () => {
  it("conserva el signo y deriva monto y periodo", () => {
    const entry = ledgerEntryPayload({
      entry_id: "refund_1",
      business_id: "bm",
      account_id: "general",
      kind: "refund",
      cash_effect: -502.5,
      occurred_at: "2026-08-26",
      source: "finance_refund",
      source_id: "refund_1",
      order_id: "P-1",
      return_id: "R-1",
      reverses_entry_id: null,
      data_quality: "native",
      notes: null,
      created_by: null,
    });

    expect(entry.amount).toBe(502.5);
    expect(entry.cash_effect).toBe(-502.5);
    expect(entry.period_id).toBe("2026-08");
  });

  it("cuadra entradas, gastos y reembolsos sin perder dinero", () => {
    const base = {
      business_id: "bm" as const,
      account_id: "general",
      occurred_at: "2026-08-01",
      period_id: "2026-08",
      order_id: null,
      return_id: null,
      reverses_entry_id: null,
      data_quality: "native" as const,
      notes: null,
      created_by: null,
    };
    expect(sumLedgerCash([
      { ...base, entry_id: "1", kind: "collection", cash_effect: 1_000, amount: 1_000, source: "order_collection", source_id: "c1" },
      { ...base, entry_id: "2", kind: "operating_expense", cash_effect: -200, amount: 200, source: "finance_expense", source_id: "e1" },
      { ...base, entry_id: "3", kind: "refund", cash_effect: -100, amount: 100, source: "finance_refund", source_id: "r1" },
    ])).toBe(700);
  });

  it("no permite mutar un periodo cerrado", () => {
    expect(periodCanReceiveMovements("open")).toBeTrue();
    expect(periodCanReceiveMovements("reopened")).toBeTrue();
    expect(periodCanReceiveMovements("closed")).toBeFalse();
  });
  describe("businessDateKey (FIX 03A-2, fechas en hora de CDMX)", () => {
    it("asigna al día de CDMX un cobro real de las 20:27 (producción: quedó como 22-oct)", () => {
      // Cobro de P-261019-4YQKP2JQ28: created_at 2026-10-22T02:27:59Z = 21-oct 20:27 CDMX.
      expect(businessDateKey(new Date("2026-10-22T02:27:59.311Z"))).toBe("2026-10-21");
    });

    it("asigna al día de CDMX una devolución real de las 20:46 (producción: quedó como 22-oct)", () => {
      expect(businessDateKey("2026-10-22T02:46:21.466Z")).toBe("2026-10-21");
    });

    it("no pasa al mes siguiente un movimiento de la noche del último día", () => {
      const lastNightOfSeptember = new Date("2026-10-01T03:30:00.000Z"); // 30-sep 21:30 CDMX
      expect(new Date(lastNightOfSeptember).toISOString().slice(0, 10)).toBe("2026-10-01");
      expect(monthIdFromDateInput(businessDateKey(lastNightOfSeptember))).toBe("2026-09");
    });

    it("conserva el mismo día por la mañana", () => {
      expect(businessDateKey(new Date("2026-10-21T18:10:37.708Z"))).toBe("2026-10-21");
    });

    it("rechaza fechas inválidas en lugar de inventar una", () => {
      expect(() => businessDateKey("no-es-fecha")).toThrowError(/no es válida/);
    });
  });
});
