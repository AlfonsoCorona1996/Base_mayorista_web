import { Injectable, computed, inject, signal } from "@angular/core";
import { collection, deleteDoc, doc, getDocs, query, serverTimestamp, setDoc, updateDoc, where } from "firebase/firestore";
import { FIRESTORE } from "./firebase.providers";
import { BusinessScopeService } from "./business-scope.service";
import { BusinessId, normalizeBusinessId } from "./rbac.constants";

export type FinanceExpenseCategory =
  | "compra_inversion"
  | "perdida"
  | "paqueteria"
  | "consumibles"
  | "deuda_fija"
  | "deuda_meses";

export interface FinanceAccount {
  account_id: string;
  business_id: BusinessId;
  name: string;
  balance: number;
  notes: string | null;
  created_at?: unknown;
  updated_at?: unknown;
}

export interface FinanceExpense {
  expense_id: string;
  business_id: BusinessId;
  category: FinanceExpenseCategory;
  amount: number;
  occurred_at: string;
  route_id: string | null;
  route_run_id?: string | null;
  account_id: string | null;
  installment_total: number | null;
  installment_index: number | null;
  notes: string | null;
  created_at?: unknown;
  updated_at?: unknown;
}

export type FinanceWithdrawalPurpose =
  | "persona"
  | "sueldo"
  | "gasto"
  | "inversion"
  | "ahorro"
  | "otro"
  | "socio_blanca"
  | "socio_andrea_pepe";

export interface FinanceWithdrawal {
  withdrawal_id: string;
  business_id: BusinessId;
  amount: number;
  occurred_at: string;
  purpose: FinanceWithdrawalPurpose;
  recipient: string | null;
  route_id: string | null;
  account_id: string | null;
  notes: string | null;
  created_at?: unknown;
  updated_at?: unknown;
}

export interface FinanceRefund {
  refund_id: string;
  business_id: BusinessId;
  customer_id: string;
  order_id: string;
  return_id: string;
  amount: number;
  account_id: string;
  method: string | null;
  reference: string | null;
  occurred_at: string;
  created_by: string | null;
  created_at?: unknown;
}

export interface FinanceCutSnapshot {
  ingresos: number;
  egresos: number;
  utilidad_bruta: number;
  utilidad_neta: number;
  por_cobrar: number;
  caja: number;
  mercancia_transito: number;
  inventario: number;
}

export interface FinanceCut {
  cut_id: string;
  business_id: BusinessId;
  label: string;
  route_id: string | null;
  start_at: string;
  end_at: string;
  snapshot: FinanceCutSnapshot;
  created_at?: unknown;
  updated_at?: unknown;
}

export type SaveFinanceAccountInput = Omit<FinanceAccount, "account_id" | "business_id"> & {
  account_id?: string;
  business_id?: BusinessId;
};
export type SaveFinanceExpenseInput = Omit<FinanceExpense, "expense_id" | "business_id"> & {
  expense_id?: string;
  business_id?: BusinessId;
};
export type SaveFinanceWithdrawalInput = Omit<FinanceWithdrawal, "withdrawal_id" | "business_id"> & {
  withdrawal_id?: string;
  business_id?: BusinessId;
};
export type SaveFinanceCutInput = Omit<FinanceCut, "cut_id" | "business_id" | "created_at" | "updated_at"> & {
  business_id?: BusinessId;
};

@Injectable({ providedIn: "root" })
export class FinanceService {
  private accountsCol = collection(FIRESTORE, "finance_accounts");
  private expensesCol = collection(FIRESTORE, "finance_expenses");
  private withdrawalsCol = collection(FIRESTORE, "finance_withdrawals");
  private cutsCol = collection(FIRESTORE, "finance_cuts");
  private refundsCol = collection(FIRESTORE, "finance_refunds");
  private businessScope = inject(BusinessScopeService);

  private accountRows = signal<FinanceAccount[]>([]);
  private expenseRows = signal<FinanceExpense[]>([]);
  private withdrawalRows = signal<FinanceWithdrawal[]>([]);
  private cutRows = signal<FinanceCut[]>([]);
  private refundRows = signal<FinanceRefund[]>([]);
  accounts = computed(() => this.filterByBusiness(this.accountRows()));
  expenses = computed(() => this.filterByBusiness(this.expenseRows()));
  withdrawals = computed(() => this.filterByBusiness(this.withdrawalRows()));
  cuts = computed(() => this.filterByBusiness(this.cutRows()));
  refunds = computed(() => this.filterByBusiness(this.refundRows()));
  loading = signal(false);

  async loadAll(): Promise<void> {
    this.loading.set(true);
    try {
      await Promise.all([this.loadAccounts(), this.loadExpenses(), this.loadWithdrawals(), this.loadCuts(), this.loadRefunds()]);
    } finally {
      this.loading.set(false);
    }
  }

  async loadAccounts(): Promise<void> {
    const snap = await getDocs(query(this.accountsCol, where("business_id", "in", this.businessScope.availableBusinessIds())));
    const rows = snap.docs
      .map((entry) => this.normalizeAccount(entry.id, entry.data() as Record<string, unknown>))
      .sort((a, b) => a.name.localeCompare(b.name, "es"));
    this.accountRows.set(rows);
  }

  async loadExpenses(): Promise<void> {
    const snap = await getDocs(query(this.expensesCol, where("business_id", "in", this.businessScope.availableBusinessIds())));
    const rows = snap.docs
      .map((entry) => this.normalizeExpense(entry.id, entry.data() as Record<string, unknown>))
      .sort((a, b) => (a.occurred_at > b.occurred_at ? -1 : 1));
    this.expenseRows.set(rows);
  }

  async loadWithdrawals(): Promise<void> {
    const snap = await getDocs(query(this.withdrawalsCol, where("business_id", "in", this.businessScope.availableBusinessIds())));
    const rows = snap.docs
      .map((entry) => this.normalizeWithdrawal(entry.id, entry.data() as Record<string, unknown>))
      .sort((a, b) => (a.occurred_at > b.occurred_at ? -1 : 1));
    this.withdrawalRows.set(rows);
  }

  async loadCuts(): Promise<void> {
    const snap = await getDocs(query(this.cutsCol, where("business_id", "in", this.businessScope.availableBusinessIds())));
    const rows = snap.docs
      .map((entry) => this.normalizeCut(entry.id, entry.data() as Record<string, unknown>))
      .sort((a, b) => (a.end_at > b.end_at ? -1 : 1));
    this.cutRows.set(rows);
  }

  async saveAccount(input: SaveFinanceAccountInput): Promise<string> {
    const accountId = (input.account_id || "").trim() || this.createId("acc");
    const payload: FinanceAccount = {
      account_id: accountId,
      business_id: normalizeBusinessId(input.business_id || this.businessScope.writeBusinessId()),
      name: (input.name || "").trim() || "Cuenta sin nombre",
      balance: this.toSafeAmount(input.balance),
      notes: this.toOptionalText(input.notes),
      created_at: input.created_at ?? null,
      updated_at: input.updated_at ?? null,
    };
    await setDoc(
      doc(this.accountsCol, accountId),
      {
        ...payload,
        created_at: input.account_id ? payload.created_at ?? null : serverTimestamp(),
        updated_at: serverTimestamp(),
      },
      { merge: true },
    );
    await this.loadAccounts();
    return accountId;
  }

  async deleteAccount(accountId: string): Promise<void> {
    const target = (accountId || "").trim();
    if (!target) return;
    await deleteDoc(doc(this.accountsCol, target));
    await this.loadAccounts();
  }

  async saveExpense(input: SaveFinanceExpenseInput): Promise<string> {
    const expenseId = (input.expense_id || "").trim() || this.createId("exp");
    const payload: FinanceExpense = {
      expense_id: expenseId,
      business_id: normalizeBusinessId(input.business_id || this.businessScope.writeBusinessId()),
      category: this.normalizeExpenseCategory(input.category),
      amount: this.toSafeAmount(input.amount),
      occurred_at: this.normalizeDateInput(input.occurred_at),
      route_id: this.toOptionalText(input.route_id),
      route_run_id: this.toOptionalText(input.route_run_id),
      account_id: this.toOptionalText(input.account_id),
      installment_total: this.toNullablePositiveInt(input.installment_total),
      installment_index: this.toNullablePositiveInt(input.installment_index),
      notes: this.toOptionalText(input.notes),
      created_at: input.created_at ?? null,
      updated_at: input.updated_at ?? null,
    };
    await setDoc(
      doc(this.expensesCol, expenseId),
      {
        ...payload,
        created_at: input.expense_id ? payload.created_at ?? null : serverTimestamp(),
        updated_at: serverTimestamp(),
      },
      { merge: true },
    );
    await this.loadExpenses();
    return expenseId;
  }

  async deleteExpense(expenseId: string): Promise<void> {
    const target = (expenseId || "").trim();
    if (!target) return;
    await deleteDoc(doc(this.expensesCol, target));
    await this.loadExpenses();
  }

  async saveWithdrawal(input: SaveFinanceWithdrawalInput): Promise<string> {
    const withdrawalId = (input.withdrawal_id || "").trim() || this.createId("wdr");
    const payload: FinanceWithdrawal = {
      withdrawal_id: withdrawalId,
      business_id: normalizeBusinessId(input.business_id || this.businessScope.writeBusinessId()),
      amount: this.toSafeAmount(input.amount),
      occurred_at: this.normalizeDateInput(input.occurred_at),
      purpose: this.normalizeWithdrawalPurpose(input.purpose),
      recipient: this.toOptionalText(input.recipient),
      route_id: this.toOptionalText(input.route_id),
      account_id: this.toOptionalText(input.account_id),
      notes: this.toOptionalText(input.notes),
      created_at: input.created_at ?? null,
      updated_at: input.updated_at ?? null,
    };
    await setDoc(
      doc(this.withdrawalsCol, withdrawalId),
      {
        ...payload,
        created_at: input.withdrawal_id ? payload.created_at ?? null : serverTimestamp(),
        updated_at: serverTimestamp(),
      },
      { merge: true },
    );
    await this.loadWithdrawals();
    return withdrawalId;
  }

  async deleteWithdrawal(withdrawalId: string): Promise<void> {
    const target = (withdrawalId || "").trim();
    if (!target) return;
    await deleteDoc(doc(this.withdrawalsCol, target));
    await this.loadWithdrawals();
  }

  async saveCut(input: SaveFinanceCutInput): Promise<string> {
    const cutId = this.createId("cut");
    const payload: FinanceCut = {
      cut_id: cutId,
      business_id: normalizeBusinessId(input.business_id || this.businessScope.writeBusinessId()),
      label: (input.label || "").trim() || "Corte",
      route_id: this.toOptionalText(input.route_id),
      start_at: this.normalizeDateInput(input.start_at),
      end_at: this.normalizeDateInput(input.end_at),
      snapshot: {
        ingresos: this.toSafeAmount(input.snapshot.ingresos),
        egresos: this.toSafeAmount(input.snapshot.egresos),
        utilidad_bruta: this.toSafeAmount(input.snapshot.utilidad_bruta),
        utilidad_neta: this.toSafeAmount(input.snapshot.utilidad_neta),
        por_cobrar: this.toSafeAmount(input.snapshot.por_cobrar),
        caja: this.toSafeAmount(input.snapshot.caja),
        mercancia_transito: this.toSafeAmount(input.snapshot.mercancia_transito),
        inventario: this.toSafeAmount(input.snapshot.inventario),
      },
    };
    await setDoc(doc(this.cutsCol, cutId), {
      ...payload,
      created_at: serverTimestamp(),
      updated_at: serverTimestamp(),
    });
    await this.loadCuts();
    return cutId;
  }

  async renameCut(cutId: string, label: string): Promise<void> {
    const target = (cutId || "").trim();
    if (!target) return;
    await updateDoc(doc(this.cutsCol, target), {
      label: (label || "").trim() || "Corte",
      updated_at: serverTimestamp(),
    });
    await this.loadCuts();
  }

  async loadRefunds(): Promise<void> {
    const snap = await getDocs(query(this.refundsCol, where("business_id", "in", this.businessScope.availableBusinessIds())));
    this.refundRows.set(snap.docs.map((entry) => this.normalizeRefund(entry.id, entry.data() as Record<string, unknown>)).sort((a, b) => b.occurred_at.localeCompare(a.occurred_at)));
  }

  private filterByBusiness<T extends { business_id: BusinessId }>(rows: T[]): T[] {
    const active = this.businessScope.activeBusinessIds();
    return rows.filter((row) => active.includes(row.business_id || "bm"));
  }

  private normalizeAccount(id: string, data: Record<string, unknown>): FinanceAccount {
    return {
      account_id: String(data["account_id"] || id),
      business_id: normalizeBusinessId(data["business_id"]),
      name: String(data["name"] || "Cuenta"),
      balance: this.toSafeAmount(data["balance"]),
      notes: this.toOptionalText(data["notes"]),
      created_at: data["created_at"] ?? null,
      updated_at: data["updated_at"] ?? null,
    };
  }

  private normalizeExpense(id: string, data: Record<string, unknown>): FinanceExpense {
    return {
      expense_id: String(data["expense_id"] || id),
      business_id: normalizeBusinessId(data["business_id"]),
      category: this.normalizeExpenseCategory(data["category"]),
      amount: this.toSafeAmount(data["amount"]),
      occurred_at: this.normalizeDateInput(data["occurred_at"]),
      route_id: this.toOptionalText(data["route_id"]),
      route_run_id: this.toOptionalText(data["route_run_id"]),
      account_id: this.toOptionalText(data["account_id"]),
      installment_total: this.toNullablePositiveInt(data["installment_total"]),
      installment_index: this.toNullablePositiveInt(data["installment_index"]),
      notes: this.toOptionalText(data["notes"]),
      created_at: data["created_at"] ?? null,
      updated_at: data["updated_at"] ?? null,
    };
  }

  private normalizeWithdrawal(id: string, data: Record<string, unknown>): FinanceWithdrawal {
    return {
      withdrawal_id: String(data["withdrawal_id"] || id),
      business_id: normalizeBusinessId(data["business_id"]),
      amount: this.toSafeAmount(data["amount"]),
      occurred_at: this.normalizeDateInput(data["occurred_at"]),
      purpose: this.normalizeWithdrawalPurpose(data["purpose"]),
      recipient: this.toOptionalText(data["recipient"]),
      route_id: this.toOptionalText(data["route_id"]),
      account_id: this.toOptionalText(data["account_id"]),
      notes: this.toOptionalText(data["notes"]),
      created_at: data["created_at"] ?? null,
      updated_at: data["updated_at"] ?? null,
    };
  }

  private normalizeCut(id: string, data: Record<string, unknown>): FinanceCut {
    const snapshot = (data["snapshot"] || {}) as Record<string, unknown>;
    return {
      cut_id: String(data["cut_id"] || id),
      business_id: normalizeBusinessId(data["business_id"]),
      label: String(data["label"] || "Corte"),
      route_id: this.toOptionalText(data["route_id"]),
      start_at: this.normalizeDateInput(data["start_at"]),
      end_at: this.normalizeDateInput(data["end_at"]),
      snapshot: {
        ingresos: this.toSafeAmount(snapshot["ingresos"]),
        egresos: this.toSafeAmount(snapshot["egresos"]),
        utilidad_bruta: this.toSafeAmount(snapshot["utilidad_bruta"]),
        utilidad_neta: this.toSafeAmount(snapshot["utilidad_neta"]),
        por_cobrar: this.toSafeAmount(snapshot["por_cobrar"]),
        caja: this.toSafeAmount(snapshot["caja"]),
        mercancia_transito: this.toSafeAmount(snapshot["mercancia_transito"]),
        inventario: this.toSafeAmount(snapshot["inventario"]),
      },
      created_at: data["created_at"] ?? null,
      updated_at: data["updated_at"] ?? null,
    };
  }

  private normalizeRefund(id: string, data: Record<string, unknown>): FinanceRefund {
    return {
      refund_id: String(data["refund_id"] || id),
      business_id: normalizeBusinessId(data["business_id"]),
      customer_id: String(data["customer_id"] || ""),
      order_id: String(data["order_id"] || ""),
      return_id: String(data["return_id"] || ""),
      amount: this.toSafeAmount(data["amount"]),
      account_id: String(data["account_id"] || ""),
      method: this.toOptionalText(data["method"]),
      reference: this.toOptionalText(data["reference"]),
      occurred_at: this.normalizeDateInput(data["occurred_at"]),
      created_by: this.toOptionalText(data["created_by"]),
      created_at: data["created_at"] ?? null,
    };
  }

  private normalizeExpenseCategory(value: unknown): FinanceExpenseCategory {
    const raw = String(value || "").trim();
    if (raw === "compra_inversion") return raw;
    if (raw === "perdida") return raw;
    if (raw === "paqueteria") return raw;
    if (raw === "consumibles") return raw;
    if (raw === "deuda_fija") return raw;
    if (raw === "deuda_meses") return raw;
    return "consumibles";
  }

  private normalizeWithdrawalPurpose(value: unknown): FinanceWithdrawalPurpose {
    const raw = String(value || "").trim();
    if (raw === "socio_blanca") return raw;
    if (raw === "socio_andrea_pepe") return raw;
    if (raw === "persona") return raw;
    if (raw === "sueldo") return raw;
    if (raw === "gasto") return raw;
    if (raw === "inversion") return raw;
    if (raw === "ahorro") return raw;
    if (raw === "otro") return raw;
    return "persona";
  }

  private toSafeAmount(value: unknown): number {
    const n = typeof value === "number" ? value : Number(value || 0);
    if (!Number.isFinite(n)) return 0;
    return Number(n.toFixed(2));
  }

  private toOptionalText(value: unknown): string | null {
    if (value === null || value === undefined) return null;
    const text = String(value).trim();
    return text ? text : null;
  }

  private toNullablePositiveInt(value: unknown): number | null {
    if (value === null || value === undefined || value === "") return null;
    const n = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(n)) return null;
    const fixed = Math.max(1, Math.trunc(n));
    return fixed;
  }

  private normalizeDateInput(value: unknown): string {
    if (typeof value === "string" && value.trim()) return value;
    if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString().slice(0, 10);
    if (typeof value === "object" && value !== null) {
      const maybe = value as { toDate?: () => Date };
      if (typeof maybe.toDate === "function") {
        const date = maybe.toDate();
        if (date instanceof Date && !Number.isNaN(date.getTime())) {
          return date.toISOString().slice(0, 10);
        }
      }
    }
    return new Date().toISOString().slice(0, 10);
  }

  private createId(prefix: string): string {
    const base = Date.now().toString(36);
    const rand = Math.random().toString(36).slice(2, 8);
    return `${prefix}_${base}_${rand}`;
  }
}
