import { Injectable, signal } from "@angular/core";
import { collection, deleteDoc, doc, getDocs, serverTimestamp, setDoc, updateDoc } from "firebase/firestore";
import { FIRESTORE } from "./firebase.providers";

export type FinanceExpenseCategory =
  | "compra_inversion"
  | "perdida"
  | "paqueteria"
  | "consumibles"
  | "deuda_fija"
  | "deuda_meses";

export interface FinanceAccount {
  account_id: string;
  name: string;
  balance: number;
  notes: string | null;
  created_at?: unknown;
  updated_at?: unknown;
}

export interface FinanceExpense {
  expense_id: string;
  category: FinanceExpenseCategory;
  amount: number;
  occurred_at: string;
  route_id: string | null;
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
  label: string;
  route_id: string | null;
  start_at: string;
  end_at: string;
  snapshot: FinanceCutSnapshot;
  created_at?: unknown;
  updated_at?: unknown;
}

export type SaveFinanceAccountInput = Omit<FinanceAccount, "account_id"> & { account_id?: string };
export type SaveFinanceExpenseInput = Omit<FinanceExpense, "expense_id"> & { expense_id?: string };
export type SaveFinanceWithdrawalInput = Omit<FinanceWithdrawal, "withdrawal_id"> & { withdrawal_id?: string };
export type SaveFinanceCutInput = Omit<FinanceCut, "cut_id" | "created_at" | "updated_at">;

@Injectable({ providedIn: "root" })
export class FinanceService {
  private accountsCol = collection(FIRESTORE, "finance_accounts");
  private expensesCol = collection(FIRESTORE, "finance_expenses");
  private withdrawalsCol = collection(FIRESTORE, "finance_withdrawals");
  private cutsCol = collection(FIRESTORE, "finance_cuts");

  accounts = signal<FinanceAccount[]>([]);
  expenses = signal<FinanceExpense[]>([]);
  withdrawals = signal<FinanceWithdrawal[]>([]);
  cuts = signal<FinanceCut[]>([]);
  loading = signal(false);

  async loadAll(): Promise<void> {
    this.loading.set(true);
    try {
      await Promise.all([this.loadAccounts(), this.loadExpenses(), this.loadWithdrawals(), this.loadCuts()]);
    } finally {
      this.loading.set(false);
    }
  }

  async loadAccounts(): Promise<void> {
    const snap = await getDocs(this.accountsCol);
    const rows = snap.docs
      .map((entry) => this.normalizeAccount(entry.id, entry.data() as Record<string, unknown>))
      .sort((a, b) => a.name.localeCompare(b.name, "es"));
    this.accounts.set(rows);
  }

  async loadExpenses(): Promise<void> {
    const snap = await getDocs(this.expensesCol);
    const rows = snap.docs
      .map((entry) => this.normalizeExpense(entry.id, entry.data() as Record<string, unknown>))
      .sort((a, b) => (a.occurred_at > b.occurred_at ? -1 : 1));
    this.expenses.set(rows);
  }

  async loadWithdrawals(): Promise<void> {
    const snap = await getDocs(this.withdrawalsCol);
    const rows = snap.docs
      .map((entry) => this.normalizeWithdrawal(entry.id, entry.data() as Record<string, unknown>))
      .sort((a, b) => (a.occurred_at > b.occurred_at ? -1 : 1));
    this.withdrawals.set(rows);
  }

  async loadCuts(): Promise<void> {
    const snap = await getDocs(this.cutsCol);
    const rows = snap.docs
      .map((entry) => this.normalizeCut(entry.id, entry.data() as Record<string, unknown>))
      .sort((a, b) => (a.end_at > b.end_at ? -1 : 1));
    this.cuts.set(rows);
  }

  async saveAccount(input: SaveFinanceAccountInput): Promise<string> {
    const accountId = (input.account_id || "").trim() || this.createId("acc");
    const payload: FinanceAccount = {
      account_id: accountId,
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
      category: this.normalizeExpenseCategory(input.category),
      amount: this.toSafeAmount(input.amount),
      occurred_at: this.normalizeDateInput(input.occurred_at),
      route_id: this.toOptionalText(input.route_id),
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

  private normalizeAccount(id: string, data: Record<string, unknown>): FinanceAccount {
    return {
      account_id: String(data["account_id"] || id),
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
      category: this.normalizeExpenseCategory(data["category"]),
      amount: this.toSafeAmount(data["amount"]),
      occurred_at: this.normalizeDateInput(data["occurred_at"]),
      route_id: this.toOptionalText(data["route_id"]),
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
