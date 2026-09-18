import { Injectable, computed, inject, signal } from "@angular/core";
import { collection, deleteDoc, doc, DocumentData, DocumentSnapshot, getDoc, getDocs, query, runTransaction, serverTimestamp, setDoc, Transaction, updateDoc, where, writeBatch } from "firebase/firestore";
import { FIRESTORE } from "./firebase.providers";
import { BusinessScopeService } from "./business-scope.service";
import { BusinessId, normalizeBusinessId } from "./rbac.constants";
import {
  FinanceLedgerEntry,
  FinanceLedgerKind,
  FinanceLedgerSource,
  FinancePeriod,
  financePeriodDocumentId,
  ledgerEntryPayload,
  monthIdFromDateInput,
  sumLedgerCash,
} from "./finance-ledger";
import { FIREBASE_AUTH } from "./firebase.providers";
import { auditDate } from "./profit-audit";

export type FinanceExpenseCategory =
  | "compra_inversion"
  | "perdida"
  | "paqueteria"
  | "viaticos"
  | "sueldos"
  | "equipo"
  | "consumibles"
  | "servicios"
  | "comisiones"
  | "ajuste"
  | "deuda_fija"
  | "deuda_meses";

/**
 * La compra de mercancia no resta utilidad: regresa como inventario y se cobra
 * como costo hasta que se vende. Todo lo demas si baja lo que se reparte.
 */
export const CAPITAL_EXPENSE_CATEGORIES: ReadonlySet<FinanceExpenseCategory> = new Set<FinanceExpenseCategory>([
  "compra_inversion",
]);

export function isOperatingExpense(category: FinanceExpenseCategory): boolean {
  return !CAPITAL_EXPENSE_CATEGORIES.has(category);
}

export const EXPENSE_CATEGORY_LABEL: Record<FinanceExpenseCategory, string> = {
  compra_inversion: "Compra de mercancia",
  paqueteria: "Paqueteria y envios",
  viaticos: "Viaticos y viajes",
  sueldos: "Sueldos y nomina",
  equipo: "Equipo y herramienta",
  consumibles: "Consumibles",
  servicios: "Servicios y renta",
  comisiones: "Comisiones y penalizaciones",
  perdida: "Perdida",
  ajuste: "Ajuste de cuadre (estimado)",
  deuda_fija: "Deuda fija",
  deuda_meses: "Deuda a meses",
};

export const EXPENSE_CATEGORY_HINT: Record<FinanceExpenseCategory, string> = {
  compra_inversion: "Mercancia para vender. No resta utilidad: regresa como inventario.",
  paqueteria: "Guias, mensajeria, fletes de entrega.",
  viaticos: "Gasolina, casetas, hospedaje y comidas de viaje.",
  sueldos: "Pagos a personal que no son reparto de socios.",
  equipo: "Impresora, herramienta, mobiliario y equipo de trabajo.",
  consumibles: "Bolsas, etiquetas, papeleria y utensilios.",
  servicios: "Renta, luz, internet, telefono.",
  comisiones: "Comisiones de cobro, plataformas y penalizaciones de proveedor.",
  perdida: "Mercancia o dinero perdido sin recuperacion.",
  ajuste: "Estimado para cuadrar algo que no se registro a tiempo.",
  deuda_fija: "Pago fijo de una deuda del negocio.",
  deuda_meses: "Parcialidad de una compra a meses.",
};

export const EXPENSE_CATEGORY_ORDER: FinanceExpenseCategory[] = [
  "compra_inversion",
  "paqueteria",
  "viaticos",
  "sueldos",
  "equipo",
  "consumibles",
  "servicios",
  "comisiones",
  "perdida",
  "ajuste",
  "deuda_fija",
  "deuda_meses",
];

/** Color del chip por categoria: fondo y tinta, en el mismo orden. */
export const EXPENSE_CATEGORY_TINT: Record<FinanceExpenseCategory, [string, string]> = {
  compra_inversion: ["#eef4ff", "#2458c5"],
  paqueteria: ["#ecfdf5", "#067647"],
  viaticos: ["#eef2ff", "#4338ca"],
  sueldos: ["#f0f9ff", "#0369a1"],
  equipo: ["#f5f3ff", "#6d28d9"],
  consumibles: ["#f1f5f9", "#475467"],
  servicios: ["#ecfeff", "#0e7490"],
  comisiones: ["#fef3e2", "#b54708"],
  perdida: ["#fee4e2", "#b42318"],
  ajuste: ["#fef3e2", "#b54708"],
  deuda_fija: ["#fdf2f8", "#a21caf"],
  deuda_meses: ["#fdf2f8", "#a21caf"],
};

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
  audit_occurred_at?: string | null;
  route_id: string | null;
  route_run_id?: string | null;
  order_id?: string | null;
  shipment_id?: string | null;
  shared_expense_group_id?: string | null;
  allocation_method?: "direct" | "by_orders" | "by_packages" | "by_sale" | "manual" | null;
  allocated_from_total?: number | null;
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
  audit_occurred_at?: string | null;
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
  private ledgerCol = collection(FIRESTORE, "finance_ledger_entries");
  private periodsCol = collection(FIRESTORE, "finance_periods");
  private businessScope = inject(BusinessScopeService);

  private accountRows = signal<FinanceAccount[]>([]);
  private expenseRows = signal<FinanceExpense[]>([]);
  private withdrawalRows = signal<FinanceWithdrawal[]>([]);
  private cutRows = signal<FinanceCut[]>([]);
  private refundRows = signal<FinanceRefund[]>([]);
  private ledgerRows = signal<FinanceLedgerEntry[]>([]);
  private periodRows = signal<FinancePeriod[]>([]);
  accounts = computed(() => this.filterByBusiness(this.accountRows()));
  expenses = computed(() => this.filterByBusiness(this.expenseRows()));
  withdrawals = computed(() => this.filterByBusiness(this.withdrawalRows()));
  cuts = computed(() => this.filterByBusiness(this.cutRows()));
  refunds = computed(() => this.filterByBusiness(this.refundRows()));
  ledgerEntries = computed(() => this.filterByBusiness(this.ledgerRows()));
  periods = computed(() => this.filterByBusiness(this.periodRows()));
  loading = signal(false);

  async loadAll(): Promise<void> {
    this.loading.set(true);
    try {
      await Promise.all([
        this.loadAccounts(),
        this.loadExpenses(),
        this.loadWithdrawals(),
        this.loadCuts(),
        this.loadRefunds(),
        this.loadLedgerEntries(),
        this.loadPeriods(),
      ]);
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
      .filter((entry) => !entry.data()["voided_at"])
      .map((entry) => this.normalizeExpense(entry.id, entry.data() as Record<string, unknown>))
      .sort((a, b) => (a.occurred_at > b.occurred_at ? -1 : 1));
    this.expenseRows.set(rows);
  }

  async loadWithdrawals(): Promise<void> {
    const snap = await getDocs(query(this.withdrawalsCol, where("business_id", "in", this.businessScope.availableBusinessIds())));
    const rows = snap.docs
      .filter((entry) => !entry.data()["voided_at"])
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

  async loadLedgerEntries(): Promise<void> {
    const snap = await getDocs(query(this.ledgerCol, where("business_id", "in", this.businessScope.availableBusinessIds())));
    this.ledgerRows.set(snap.docs
      .map((entry) => this.normalizeLedgerEntry(entry.id, entry.data() as Record<string, unknown>))
      .sort((a, b) => b.occurred_at.localeCompare(a.occurred_at)));
  }

  async loadPeriods(): Promise<void> {
    const snap = await getDocs(query(this.periodsCol, where("business_id", "in", this.businessScope.availableBusinessIds())));
    this.periodRows.set(snap.docs
      .map((entry) => this.normalizePeriod(entry.id, entry.data() as Record<string, unknown>))
      .sort((a, b) => b.month_id.localeCompare(a.month_id)));
  }

  async saveAccount(input: SaveFinanceAccountInput): Promise<string> {
    const accountId = (input.account_id || "").trim() || this.createId("acc");
    const businessId = normalizeBusinessId(input.business_id || this.businessScope.writeBusinessId());
    const occurredAt = new Date().toISOString().slice(0, 10);
    const periodId = monthIdFromDateInput(occurredAt);
    const accountRef = doc(this.accountsCol, accountId);
    const payload: FinanceAccount = {
      account_id: accountId,
      business_id: businessId,
      name: (input.name || "").trim() || "Cuenta sin nombre",
      balance: this.toSafeAmount(input.balance),
      notes: this.toOptionalText(input.notes),
      created_at: input.created_at ?? null,
      updated_at: input.updated_at ?? null,
    };
    await runTransaction(FIRESTORE, async (tx) => {
      const [accountSnap, periodSnap] = await Promise.all([
        tx.get(accountRef),
        tx.get(doc(this.periodsCol, financePeriodDocumentId(businessId, periodId))),
      ]);
      this.assertOpenPeriod(periodSnap.data() as Record<string, unknown> | undefined, occurredAt);
      if (accountSnap.exists() && normalizeBusinessId(accountSnap.data()["business_id"]) !== businessId) {
        throw new Error("La cuenta pertenece a otro negocio.");
      }
      const previousBalance = accountSnap.exists() ? this.toSafeAmount(accountSnap.data()["balance"]) : 0;
      const balanceDelta = this.toSafeAmount(payload.balance - previousBalance);
      tx.set(accountRef, {
        ...payload,
        created_at: accountSnap.exists() ? accountSnap.data()["created_at"] || serverTimestamp() : serverTimestamp(),
        updated_at: serverTimestamp(),
      }, { merge: true });
      if (balanceDelta !== 0) {
        const entryId = `${accountSnap.exists() ? "adjustment" : "opening"}_${accountId}_${Date.now()}`;
        const entry = ledgerEntryPayload({
          entry_id: entryId,
          business_id: businessId,
          account_id: accountId,
          kind: accountSnap.exists() ? "cash_adjustment" : "opening_balance",
          cash_effect: balanceDelta,
          occurred_at: occurredAt,
          source: accountSnap.exists() ? "manual_adjustment" : "account",
          source_id: accountId,
          order_id: null,
          return_id: null,
          reverses_entry_id: null,
          data_quality: "confirmed",
          notes: accountSnap.exists() ? "Ajuste de saldo conciliado" : "Saldo inicial de la cuenta",
          created_by: this.currentActorId(),
        });
        tx.set(doc(this.ledgerCol, entryId), { ...entry, created_at: serverTimestamp() });
      }
    });
    await Promise.all([this.loadAccounts(), this.loadLedgerEntries()]);
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
    const businessId = normalizeBusinessId(input.business_id || this.businessScope.writeBusinessId());
    const payload: FinanceExpense = {
      expense_id: expenseId,
      business_id: businessId,
      category: this.normalizeExpenseCategory(input.category),
      amount: this.toSafeAmount(input.amount),
      occurred_at: this.normalizeDateInput(input.occurred_at),
      route_id: this.toOptionalText(input.route_id),
      route_run_id: this.toOptionalText(input.route_run_id),
      order_id: this.toOptionalText(input.order_id),
      shipment_id: this.toOptionalText(input.shipment_id),
      shared_expense_group_id: this.toOptionalText(input.shared_expense_group_id),
      allocation_method: this.normalizeAllocationMethod(input.allocation_method),
      allocated_from_total: input.allocated_from_total == null ? null : this.toSafeAmount(input.allocated_from_total),
      account_id: this.toOptionalText(input.account_id),
      installment_total: this.toNullablePositiveInt(input.installment_total),
      installment_index: this.toNullablePositiveInt(input.installment_index),
      notes: this.toOptionalText(input.notes),
      created_at: input.created_at ?? null,
      updated_at: input.updated_at ?? null,
    };
    const expenseRef = doc(this.expensesCol, expenseId);
    await runTransaction(FIRESTORE, async (tx) => {
      const periodRef = doc(this.periodsCol, financePeriodDocumentId(businessId, monthIdFromDateInput(payload.occurred_at)));
      const [expenseSnap, periodSnap] = await Promise.all([tx.get(expenseRef), tx.get(periodRef)]);
      this.assertOpenPeriod(periodSnap.data() as Record<string, unknown> | undefined, payload.occurred_at);
      const previous = expenseSnap.exists() ? this.normalizeExpense(expenseSnap.id, expenseSnap.data() as Record<string, unknown>) : null;
      if (previous && previous.business_id !== businessId) throw new Error("El egreso pertenece a otro negocio.");
      if (previous && previous.occurred_at !== payload.occurred_at) {
        const previousPeriod = await tx.get(doc(this.periodsCol, financePeriodDocumentId(businessId, monthIdFromDateInput(previous.occurred_at))));
        this.assertOpenPeriod(previousPeriod.data() as Record<string, unknown> | undefined, previous.occurred_at);
      }
      const accountIds = Array.from(new Set([previous?.account_id, payload.account_id].filter((value): value is string => Boolean(value))));
      const accountSnaps = new Map<string, DocumentSnapshot<DocumentData>>();
      for (const accountId of accountIds) accountSnaps.set(accountId, await tx.get(doc(this.accountsCol, accountId)));
      this.validateLedgerAccounts(accountSnaps, businessId);

      tx.set(expenseRef, {
        ...payload,
        ledger_revision: Number(expenseSnap.data()?.["ledger_revision"] || 0) + 1,
        created_at: expenseSnap.exists() ? expenseSnap.data()["created_at"] || serverTimestamp() : serverTimestamp(),
        updated_at: serverTimestamp(),
        voided_at: null,
      }, { merge: true });
      this.writeRevisionLedgerEntries(tx, {
        businessId,
        source: "finance_expense",
        sourceId: expenseId,
        previous: previous ? {
          accountId: previous.account_id,
          amount: previous.amount,
          occurredAt: previous.occurred_at,
          kind: previous.category === "compra_inversion" ? "inventory_purchase" : "operating_expense",
        } : null,
        next: {
          accountId: payload.account_id,
          amount: payload.amount,
          occurredAt: payload.occurred_at,
          kind: payload.category === "compra_inversion" ? "inventory_purchase" : "operating_expense",
        },
        accountSnaps,
        notes: payload.notes,
      });
    });
    await Promise.all([this.loadExpenses(), this.loadAccounts(), this.loadLedgerEntries()]);
    return expenseId;
  }

  async deleteExpense(expenseId: string): Promise<void> {
    const target = (expenseId || "").trim();
    if (!target) return;
    const sourceRef = doc(this.expensesCol, target);
    const occurredAt = new Date().toISOString().slice(0, 10);
    await runTransaction(FIRESTORE, async (tx) => {
      const sourceSnap = await tx.get(sourceRef);
      if (!sourceSnap.exists() || sourceSnap.data()["voided_at"]) return;
      const row = this.normalizeExpense(sourceSnap.id, sourceSnap.data() as Record<string, unknown>);
      const periodSnap = await tx.get(doc(this.periodsCol, financePeriodDocumentId(row.business_id, monthIdFromDateInput(occurredAt))));
      this.assertOpenPeriod(periodSnap.data() as Record<string, unknown> | undefined, occurredAt);
      const accountSnap = row.account_id ? await tx.get(doc(this.accountsCol, row.account_id)) : null;
      if (row.account_id) this.validateLedgerAccounts(new Map([[row.account_id, accountSnap!]]), row.business_id);
      tx.update(sourceRef, { voided_at: serverTimestamp(), voided_by: this.currentActorId(), updated_at: serverTimestamp() });
      const entryId = `ledger_${target}_void_${Date.now()}`;
      const entry = ledgerEntryPayload({
        entry_id: entryId, business_id: row.business_id, account_id: row.account_id,
        kind: row.category === "compra_inversion" ? "inventory_purchase" : "operating_expense",
        cash_effect: row.amount, occurred_at: occurredAt, source: "finance_expense", source_id: target,
        order_id: row.order_id || null, return_id: null, reverses_entry_id: `previous_${target}`,
        data_quality: "native", notes: "Reversión por eliminación", created_by: this.currentActorId(),
      });
      tx.set(doc(this.ledgerCol, entryId), { ...entry, created_at: serverTimestamp() });
      if (row.account_id && accountSnap) tx.update(doc(this.accountsCol, row.account_id), {
        balance: this.toSafeAmount(this.toSafeAmount(accountSnap.data()?.["balance"]) + row.amount), updated_at: serverTimestamp(),
      });
    });
    await Promise.all([this.loadExpenses(), this.loadAccounts(), this.loadLedgerEntries()]);
  }

  async saveWithdrawal(input: SaveFinanceWithdrawalInput): Promise<string> {
    const withdrawalId = (input.withdrawal_id || "").trim() || this.createId("wdr");
    const businessId = normalizeBusinessId(input.business_id || this.businessScope.writeBusinessId());
    const payload: FinanceWithdrawal = {
      withdrawal_id: withdrawalId,
      business_id: businessId,
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
    const withdrawalRef = doc(this.withdrawalsCol, withdrawalId);
    await runTransaction(FIRESTORE, async (tx) => {
      const periodRef = doc(this.periodsCol, financePeriodDocumentId(businessId, monthIdFromDateInput(payload.occurred_at)));
      const [withdrawalSnap, periodSnap] = await Promise.all([tx.get(withdrawalRef), tx.get(periodRef)]);
      this.assertOpenPeriod(periodSnap.data() as Record<string, unknown> | undefined, payload.occurred_at);
      const previous = withdrawalSnap.exists()
        ? this.normalizeWithdrawal(withdrawalSnap.id, withdrawalSnap.data() as Record<string, unknown>)
        : null;
      if (previous && previous.business_id !== businessId) throw new Error("El retiro pertenece a otro negocio.");
      if (previous && previous.occurred_at !== payload.occurred_at) {
        const previousPeriod = await tx.get(doc(this.periodsCol, financePeriodDocumentId(businessId, monthIdFromDateInput(previous.occurred_at))));
        this.assertOpenPeriod(previousPeriod.data() as Record<string, unknown> | undefined, previous.occurred_at);
      }
      const accountIds = Array.from(new Set([previous?.account_id, payload.account_id].filter((value): value is string => Boolean(value))));
      const accountSnaps = new Map<string, DocumentSnapshot<DocumentData>>();
      for (const accountId of accountIds) accountSnaps.set(accountId, await tx.get(doc(this.accountsCol, accountId)));
      this.validateLedgerAccounts(accountSnaps, businessId);

      tx.set(withdrawalRef, {
        ...payload,
        ledger_revision: Number(withdrawalSnap.data()?.["ledger_revision"] || 0) + 1,
        created_at: withdrawalSnap.exists() ? withdrawalSnap.data()["created_at"] || serverTimestamp() : serverTimestamp(),
        updated_at: serverTimestamp(),
        voided_at: null,
      }, { merge: true });
      this.writeRevisionLedgerEntries(tx, {
        businessId,
        source: "finance_withdrawal",
        sourceId: withdrawalId,
        previous: previous ? {
          accountId: previous.account_id,
          amount: previous.amount,
          occurredAt: previous.occurred_at,
          kind: this.isPartnerPurpose(previous.purpose) ? "partner_distribution" : "other_withdrawal",
        } : null,
        next: {
          accountId: payload.account_id,
          amount: payload.amount,
          occurredAt: payload.occurred_at,
          kind: this.isPartnerPurpose(payload.purpose) ? "partner_distribution" : "other_withdrawal",
        },
        accountSnaps,
        notes: payload.notes,
      });
    });
    await Promise.all([this.loadWithdrawals(), this.loadAccounts(), this.loadLedgerEntries()]);
    return withdrawalId;
  }

  async deleteWithdrawal(withdrawalId: string): Promise<void> {
    const target = (withdrawalId || "").trim();
    if (!target) return;
    const sourceRef = doc(this.withdrawalsCol, target);
    const occurredAt = new Date().toISOString().slice(0, 10);
    await runTransaction(FIRESTORE, async (tx) => {
      const sourceSnap = await tx.get(sourceRef);
      if (!sourceSnap.exists() || sourceSnap.data()["voided_at"]) return;
      const row = this.normalizeWithdrawal(sourceSnap.id, sourceSnap.data() as Record<string, unknown>);
      const periodSnap = await tx.get(doc(this.periodsCol, financePeriodDocumentId(row.business_id, monthIdFromDateInput(occurredAt))));
      this.assertOpenPeriod(periodSnap.data() as Record<string, unknown> | undefined, occurredAt);
      const accountSnap = row.account_id ? await tx.get(doc(this.accountsCol, row.account_id)) : null;
      if (row.account_id) this.validateLedgerAccounts(new Map([[row.account_id, accountSnap!]]), row.business_id);
      tx.update(sourceRef, { voided_at: serverTimestamp(), voided_by: this.currentActorId(), updated_at: serverTimestamp() });
      const entryId = `ledger_${target}_void_${Date.now()}`;
      const entry = ledgerEntryPayload({
        entry_id: entryId, business_id: row.business_id, account_id: row.account_id,
        kind: this.isPartnerPurpose(row.purpose) ? "partner_distribution" : "other_withdrawal",
        cash_effect: row.amount, occurred_at: occurredAt, source: "finance_withdrawal", source_id: target,
        order_id: null, return_id: null, reverses_entry_id: `previous_${target}`,
        data_quality: "native", notes: "Reversión por eliminación", created_by: this.currentActorId(),
      });
      tx.set(doc(this.ledgerCol, entryId), { ...entry, created_at: serverTimestamp() });
      if (row.account_id && accountSnap) tx.update(doc(this.accountsCol, row.account_id), {
        balance: this.toSafeAmount(this.toSafeAmount(accountSnap.data()?.["balance"]) + row.amount), updated_at: serverTimestamp(),
      });
    });
    await Promise.all([this.loadWithdrawals(), this.loadAccounts(), this.loadLedgerEntries()]);
  }

  async saveCut(input: SaveFinanceCutInput): Promise<string> {
    const cutId = this.createId("cut");
    const businessId = normalizeBusinessId(input.business_id || this.businessScope.writeBusinessId());
    const monthId = monthIdFromDateInput(input.end_at);
    const periodId = financePeriodDocumentId(businessId, monthId);
    const periodRef = doc(this.periodsCol, periodId);
    const existingPeriod = await getDoc(periodRef);
    if (existingPeriod.exists() && existingPeriod.data()["status"] === "closed") {
      throw new Error("Este periodo ya está cerrado. Reábrelo con motivo antes de modificarlo.");
    }
    const payload: FinanceCut = {
      cut_id: cutId,
      business_id: businessId,
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
    const businessLedger = this.ledgerEntries().filter((entry) => entry.business_id === businessId);
    const monthLedger = businessLedger.filter((entry) => entry.period_id === monthId);
    const accountsBalance = this.accounts()
      .filter((account) => account.business_id === businessId)
      .reduce((sum, account) => sum + this.toSafeAmount(account.balance), 0);
    const reconciliation = {
      ledger_cash_change: sumLedgerCash(monthLedger),
      accounts_balance: this.toSafeAmount(accountsBalance),
      receivables_closing: payload.snapshot.por_cobrar,
      inventory_closing: payload.snapshot.inventario,
      unexplained_difference: this.toSafeAmount(accountsBalance - sumLedgerCash(businessLedger)),
      unassigned_movements: monthLedger.filter((entry) => !entry.account_id).length,
      estimated_movements: monthLedger.filter((entry) => entry.data_quality === "estimated" || entry.data_quality === "unknown").length,
    };
    const batch = writeBatch(FIRESTORE);
    batch.set(doc(this.cutsCol, cutId), {
      ...payload,
      period_id: periodId,
      created_at: serverTimestamp(),
      updated_at: serverTimestamp(),
    });
    batch.set(periodRef, {
      period_id: periodId,
      business_id: businessId,
      month_id: monthId,
      status: "closed",
      start_at: payload.start_at,
      end_at: payload.end_at,
      snapshot: payload.snapshot,
      reconciliation,
      closed_by: this.currentActorId(),
      closed_at: serverTimestamp(),
      created_at: existingPeriod.exists() ? existingPeriod.data()["created_at"] || serverTimestamp() : serverTimestamp(),
      updated_at: serverTimestamp(),
    }, { merge: true });
    await batch.commit();
    await Promise.all([this.loadCuts(), this.loadPeriods()]);
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
      audit_occurred_at: auditDate(data['occurred_at']),
      amount: this.toSafeAmount(data["amount"]),
      occurred_at: this.normalizeDateInput(data["occurred_at"]),
      route_id: this.toOptionalText(data["route_id"]),
      route_run_id: this.toOptionalText(data["route_run_id"]),
      order_id: this.toOptionalText(data["order_id"]),
      shipment_id: this.toOptionalText(data["shipment_id"]),
      shared_expense_group_id: this.toOptionalText(data["shared_expense_group_id"]),
      allocation_method: this.normalizeAllocationMethod(data["allocation_method"]),
      allocated_from_total: data["allocated_from_total"] == null ? null : this.toSafeAmount(data["allocated_from_total"]),
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
      audit_occurred_at: auditDate(data['occurred_at']),
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

  async reopenPeriod(periodId: string, reason: string): Promise<void> {
    const target = this.periods().find((row) => row.period_id === periodId);
    if (!target || target.status !== "closed") throw new Error("El periodo no está cerrado.");
    const cleanReason = String(reason || "").trim();
    if (cleanReason.length < 8) throw new Error("Explica el motivo de la reapertura.");
    await updateDoc(doc(this.periodsCol, periodId), {
      status: "reopened",
      reopened_by: this.currentActorId(),
      reopened_at: serverTimestamp(),
      reopen_reason: cleanReason,
      updated_at: serverTimestamp(),
    });
    await this.loadPeriods();
  }

  private normalizeLedgerEntry(id: string, data: Record<string, unknown>): FinanceLedgerEntry {
    const occurredAt = this.normalizeDateInput(data["occurred_at"]);
    const cashEffect = this.toSafeAmount(data["cash_effect"]);
    return {
      entry_id: String(data["entry_id"] || id),
      business_id: normalizeBusinessId(data["business_id"]),
      account_id: this.toOptionalText(data["account_id"]),
      kind: this.normalizeLedgerKind(data["kind"]),
      cash_effect: cashEffect,
      amount: Math.abs(this.toSafeAmount(data["amount"] ?? cashEffect)),
      occurred_at: occurredAt,
      period_id: String(data["period_id"] || monthIdFromDateInput(occurredAt)),
      source: this.normalizeLedgerSource(data["source"]),
      source_id: String(data["source_id"] || ""),
      order_id: this.toOptionalText(data["order_id"]),
      return_id: this.toOptionalText(data["return_id"]),
      reverses_entry_id: this.toOptionalText(data["reverses_entry_id"]),
      data_quality: data["data_quality"] === "confirmed"
        || data["data_quality"] === "reconstructed"
        || data["data_quality"] === "estimated"
        || data["data_quality"] === "unknown"
        ? data["data_quality"]
        : "native",
      notes: this.toOptionalText(data["notes"]),
      created_by: this.toOptionalText(data["created_by"]),
      created_at: data["created_at"] ?? null,
    };
  }

  private normalizePeriod(id: string, data: Record<string, unknown>): FinancePeriod {
    const snapshot = (data["snapshot"] || {}) as Record<string, unknown>;
    const reconciliation = (data["reconciliation"] || {}) as Record<string, unknown>;
    const status = String(data["status"] || "open");
    return {
      period_id: String(data["period_id"] || id),
      business_id: normalizeBusinessId(data["business_id"]),
      month_id: String(data["month_id"] || ""),
      status: status === "closed" || status === "in_review" || status === "reopened" ? status : "open",
      start_at: this.normalizeDateInput(data["start_at"]),
      end_at: this.normalizeDateInput(data["end_at"]),
      snapshot: Object.fromEntries(Object.entries(snapshot).map(([key, value]) => [key, this.toSafeAmount(value)])),
      reconciliation: {
        ledger_cash_change: this.toSafeAmount(reconciliation["ledger_cash_change"]),
        accounts_balance: this.toSafeAmount(reconciliation["accounts_balance"]),
        receivables_closing: this.toSafeAmount(reconciliation["receivables_closing"]),
        inventory_closing: this.toSafeAmount(reconciliation["inventory_closing"]),
        unexplained_difference: this.toSafeAmount(reconciliation["unexplained_difference"]),
        unassigned_movements: Math.max(0, Math.trunc(Number(reconciliation["unassigned_movements"] || 0))),
        estimated_movements: Math.max(0, Math.trunc(Number(reconciliation["estimated_movements"] || 0))),
      },
      closed_by: this.toOptionalText(data["closed_by"]),
      closed_at: data["closed_at"] ?? null,
      reopened_by: this.toOptionalText(data["reopened_by"]),
      reopened_at: data["reopened_at"] ?? null,
      reopen_reason: this.toOptionalText(data["reopen_reason"]),
      created_at: data["created_at"] ?? null,
      updated_at: data["updated_at"] ?? null,
    };
  }

  private assertOpenPeriod(period: Record<string, unknown> | undefined, occurredAt: string): void {
    if (period?.["status"] === "closed") {
      throw new Error(`El periodo ${monthIdFromDateInput(occurredAt)} está cerrado. Registra el ajuste en el periodo actual o reabre el cierre con motivo.`);
    }
  }

  private validateLedgerAccounts(
    accounts: Map<string, DocumentSnapshot<DocumentData>>,
    businessId: BusinessId,
  ): void {
    for (const [accountId, snap] of accounts) {
      if (!snap.exists()) throw new Error(`La cuenta ${accountId} no existe.`);
      if (normalizeBusinessId(snap.data()["business_id"]) !== businessId) {
        throw new Error("La cuenta del movimiento pertenece a otro negocio.");
      }
    }
  }

  private writeRevisionLedgerEntries(tx: Transaction, input: {
    businessId: BusinessId;
    source: Extract<FinanceLedgerSource, "finance_expense" | "finance_withdrawal">;
    sourceId: string;
    previous: { accountId: string | null; amount: number; occurredAt: string; kind: FinanceLedgerKind } | null;
    next: { accountId: string | null; amount: number; occurredAt: string; kind: FinanceLedgerKind };
    accountSnaps: Map<string, DocumentSnapshot<DocumentData>>;
    notes: string | null;
  }): void {
    const nonce = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const actor = this.currentActorId();
    if (input.previous) {
      const reversalId = `ledger_${input.sourceId}_reversal_${nonce}`;
      const reversal = ledgerEntryPayload({
        entry_id: reversalId,
        business_id: input.businessId,
        account_id: input.previous.accountId,
        kind: input.previous.kind,
        cash_effect: Math.max(0, this.toSafeAmount(input.previous.amount)),
        occurred_at: input.next.occurredAt,
        source: input.source,
        source_id: input.sourceId,
        order_id: null,
        return_id: null,
        reverses_entry_id: `previous_${input.sourceId}`,
        data_quality: "native",
        notes: "Reversión automática por edición",
        created_by: actor,
      });
      tx.set(doc(this.ledgerCol, reversalId), { ...reversal, created_at: serverTimestamp() });
    }
    const entryId = `ledger_${input.sourceId}_${nonce}`;
    const entry = ledgerEntryPayload({
      entry_id: entryId,
      business_id: input.businessId,
      account_id: input.next.accountId,
      kind: input.next.kind,
      cash_effect: -Math.max(0, this.toSafeAmount(input.next.amount)),
      occurred_at: input.next.occurredAt,
      source: input.source,
      source_id: input.sourceId,
      order_id: null,
      return_id: null,
      reverses_entry_id: null,
      data_quality: "native",
      notes: input.notes,
      created_by: actor,
    });
    tx.set(doc(this.ledgerCol, entryId), { ...entry, created_at: serverTimestamp() });

    const deltas = new Map<string, number>();
    if (input.previous?.accountId) {
      deltas.set(input.previous.accountId, this.toSafeAmount(input.previous.amount));
    }
    if (input.next.accountId) {
      deltas.set(input.next.accountId, this.toSafeAmount((deltas.get(input.next.accountId) || 0) - input.next.amount));
    }
    for (const [accountId, delta] of deltas) {
      const snap = input.accountSnaps.get(accountId);
      if (!snap) continue;
      tx.update(doc(this.accountsCol, accountId), {
        balance: this.toSafeAmount(this.toSafeAmount(snap.data()?.["balance"]) + delta),
        updated_at: serverTimestamp(),
      });
    }
  }

  private isPartnerPurpose(purpose: FinanceWithdrawalPurpose): boolean {
    return purpose === "socio_blanca" || purpose === "socio_andrea_pepe";
  }

  private normalizeLedgerKind(value: unknown): FinanceLedgerKind {
    const raw = String(value || "cash_adjustment") as FinanceLedgerKind;
    const valid: FinanceLedgerKind[] = [
      "opening_balance", "collection", "refund", "operating_expense", "inventory_purchase",
      "partner_distribution", "other_withdrawal", "cash_adjustment",
    ];
    return valid.includes(raw) ? raw : "cash_adjustment";
  }

  private normalizeLedgerSource(value: unknown): FinanceLedgerSource {
    const raw = String(value || "manual_adjustment") as FinanceLedgerSource;
    const valid: FinanceLedgerSource[] = [
      "account", "order_collection", "finance_refund", "finance_expense",
      "finance_withdrawal", "migration", "manual_adjustment",
    ];
    return valid.includes(raw) ? raw : "manual_adjustment";
  }

  private currentActorId(): string | null {
    return FIREBASE_AUTH.currentUser?.uid || null;
  }

  private normalizeExpenseCategory(value: unknown): FinanceExpenseCategory {
    const raw = String(value || "").trim();
    if (
      raw === "compra_inversion" ||
      raw === "perdida" ||
      raw === "paqueteria" ||
      raw === "viaticos" ||
      raw === "sueldos" ||
      raw === "equipo" ||
      raw === "consumibles" ||
      raw === "servicios" ||
      raw === "comisiones" ||
      raw === "ajuste" ||
      raw === "deuda_fija" ||
      raw === "deuda_meses"
    ) {
      return raw;
    }
    return "consumibles";
  }

  private normalizeAllocationMethod(value: unknown): FinanceExpense["allocation_method"] {
    const raw = String(value || "").trim();
    if (raw === "direct" || raw === "by_orders" || raw === "by_packages" || raw === "by_sale" || raw === "manual") return raw;
    return null;
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
