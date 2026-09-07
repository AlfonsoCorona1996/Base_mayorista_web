import { BusinessId } from "./rbac.constants";
import { AccountingPeriodStatus, FinanceDataQuality } from "./accounting-period";
import { money } from "./order-financials";

export type FinanceLedgerKind =
  | "opening_balance"
  | "collection"
  | "refund"
  | "operating_expense"
  | "inventory_purchase"
  | "partner_distribution"
  | "other_withdrawal"
  | "cash_adjustment";

export type FinanceLedgerSource =
  | "account"
  | "order_collection"
  | "finance_refund"
  | "finance_expense"
  | "finance_withdrawal"
  | "migration"
  | "manual_adjustment";

export interface FinanceLedgerEntry {
  entry_id: string;
  business_id: BusinessId;
  account_id: string | null;
  kind: FinanceLedgerKind;
  /** Positivo entra a caja; negativo sale. */
  cash_effect: number;
  amount: number;
  occurred_at: string;
  period_id: string;
  source: FinanceLedgerSource;
  source_id: string;
  order_id: string | null;
  return_id: string | null;
  reverses_entry_id: string | null;
  data_quality: FinanceDataQuality;
  notes: string | null;
  created_by: string | null;
  created_at?: unknown;
}

export interface FinancePeriodReconciliation {
  ledger_cash_change: number;
  accounts_balance: number;
  receivables_closing: number;
  inventory_closing: number;
  unexplained_difference: number;
  unassigned_movements: number;
  estimated_movements: number;
}

export interface FinancePeriod {
  period_id: string;
  business_id: BusinessId;
  month_id: string;
  status: AccountingPeriodStatus;
  start_at: string;
  end_at: string;
  snapshot: Record<string, number>;
  reconciliation: FinancePeriodReconciliation;
  closed_by: string | null;
  closed_at?: unknown;
  reopened_by?: string | null;
  reopened_at?: unknown;
  reopen_reason?: string | null;
  created_at?: unknown;
  updated_at?: unknown;
}

export function financePeriodDocumentId(businessId: BusinessId, monthId: string): string {
  return `${businessId}_${monthId}`;
}

export function monthIdFromDateInput(value: string): string {
  const match = /^(\d{4})-(\d{2})/.exec(String(value || ""));
  if (!match) throw new Error("La fecha del movimiento no es válida.");
  return `${match[1]}-${match[2]}`;
}

export function sumLedgerCash(entries: FinanceLedgerEntry[], accountId?: string): number {
  return money(entries
    .filter((entry) => !accountId || entry.account_id === accountId)
    .reduce((sum, entry) => sum + money(entry.cash_effect), 0));
}

export function periodCanReceiveMovements(status: AccountingPeriodStatus | null | undefined): boolean {
  return status !== "closed";
}

export function ledgerEntryPayload(input: Omit<FinanceLedgerEntry, "amount" | "period_id">): FinanceLedgerEntry {
  const cashEffect = money(input.cash_effect);
  return {
    ...input,
    cash_effect: cashEffect,
    amount: Math.abs(cashEffect),
    period_id: monthIdFromDateInput(input.occurred_at),
  };
}

