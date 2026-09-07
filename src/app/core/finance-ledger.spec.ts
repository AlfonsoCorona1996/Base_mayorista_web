import { ledgerEntryPayload, periodCanReceiveMovements, sumLedgerCash } from "./finance-ledger";

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
});
