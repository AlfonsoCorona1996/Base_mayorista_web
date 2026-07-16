import { Injectable, computed, inject, signal } from "@angular/core";
import { collection, doc, getDocs, query, serverTimestamp, setDoc, updateDoc, where } from "firebase/firestore";
import { ulid } from "ulid";
import { FIREBASE_AUTH, FIRESTORE } from "./firebase.providers";
import { BusinessId, normalizeBusinessId } from "./rbac.constants";
import { FinanceExpenseCategory, FinanceService } from "./finance.service";
import { BusinessScopeService } from "./business-scope.service";

export type OperationalExpenseCategory = "taxi" | "paqueteria" | "gasolina" | "entrega" | "otro";
export type OperationalExpenseApprovalStatus = "pending" | "approved" | "rejected";

export interface OperationalExpenseReport {
  report_id: string;
  business_id: BusinessId;
  category: OperationalExpenseCategory;
  amount: number;
  occurred_at: string;
  route_id: string | null;
  shipment_id: string | null;
  order_id: string | null;
  note: string | null;
  reported_by: { uid: string; name: string } | null;
  approval_status: OperationalExpenseApprovalStatus;
  approved_expense_id: string | null;
  approved_by?: { uid: string; name: string } | null;
  approved_at?: string | null;
  rejected_reason?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
}

export type SaveOperationalExpenseReportInput = {
  business_id?: BusinessId;
  category: OperationalExpenseCategory;
  amount: number;
  occurred_at?: string | null;
  route_id?: string | null;
  shipment_id?: string | null;
  order_id?: string | null;
  note?: string | null;
  reported_by_name?: string | null;
};

@Injectable({ providedIn: "root" })
export class OperationalExpenseReportsService {
  private reportsCol = collection(FIRESTORE, "operational_expense_reports");
  private finance = inject(FinanceService);
  private businessScope = inject(BusinessScopeService);
  private rowsState = signal<OperationalExpenseReport[]>([]);

  readonly rows = computed(() => {
    const allowed = new Set(this.businessScope.availableBusinessIds());
    return this.rowsState().filter((row) => allowed.has(row.business_id));
  });
  readonly pending = computed(() => this.rows().filter((row) => row.approval_status === "pending"));

  async loadAll(): Promise<void> {
    const snap = await getDocs(query(this.reportsCol, where("business_id", "in", this.businessScope.availableBusinessIds())));
    const rows = snap.docs
      .map((entry) => this.normalize(entry.id, entry.data() as Record<string, any>))
      .sort((a, b) => String(b.created_at || b.occurred_at).localeCompare(String(a.created_at || a.occurred_at)));
    this.rowsState.set(rows);
  }

  async createReport(input: SaveOperationalExpenseReportInput): Promise<string> {
    const reportId = ulid();
    const payload: OperationalExpenseReport = {
      report_id: reportId,
      business_id: normalizeBusinessId(input.business_id || this.businessScope.writeBusinessId()),
      category: this.normalizeCategory(input.category),
      amount: this.toAmount(input.amount),
      occurred_at: this.normalizeDate(input.occurred_at),
      route_id: this.optionalText(input.route_id),
      shipment_id: this.optionalText(input.shipment_id),
      order_id: this.optionalText(input.order_id),
      note: this.optionalText(input.note),
      reported_by: this.actor(input.reported_by_name || undefined),
      approval_status: "pending",
      approved_expense_id: null,
      approved_by: null,
      approved_at: null,
      rejected_reason: null,
    };
    await setDoc(doc(this.reportsCol, reportId), {
      ...payload,
      created_at: serverTimestamp(),
      updated_at: serverTimestamp(),
    });
    await this.loadAll().catch(() => null);
    return reportId;
  }

  async approveReport(report: OperationalExpenseReport): Promise<string> {
    const expenseId = await this.finance.saveExpense({
      business_id: report.business_id,
      category: this.financeCategoryFor(report.category),
      amount: report.amount,
      occurred_at: report.occurred_at,
      route_id: report.route_id,
      route_run_id: null,
      order_id: report.order_id,
      shipment_id: report.shipment_id,
      shared_expense_group_id: null,
      allocation_method: "direct",
      allocated_from_total: report.amount,
      account_id: null,
      installment_total: null,
      installment_index: null,
      notes: this.expenseNoteFor(report),
    });
    await updateDoc(doc(this.reportsCol, report.report_id), {
      approval_status: "approved",
      approved_expense_id: expenseId,
      approved_by: this.actor(),
      approved_at: serverTimestamp(),
      updated_at: serverTimestamp(),
    });
    await this.loadAll().catch(() => null);
    return expenseId;
  }

  async rejectReport(reportId: string, reason: string): Promise<void> {
    await updateDoc(doc(this.reportsCol, reportId), {
      approval_status: "rejected",
      rejected_reason: reason || "Rechazado por GDL",
      approved_by: this.actor(),
      approved_at: serverTimestamp(),
      updated_at: serverTimestamp(),
    });
    await this.loadAll().catch(() => null);
  }

  reportsForOrder(orderId: string | null | undefined): OperationalExpenseReport[] {
    const target = String(orderId || "").trim();
    if (!target) return [];
    return this.rows().filter((row) => row.order_id === target);
  }

  private expenseNoteFor(report: OperationalExpenseReport): string {
    const label = this.categoryLabel(report.category);
    const note = report.note ? ` · ${report.note}` : "";
    return `Gasto Durango aprobado: ${label}${note}`;
  }

  categoryLabel(category: OperationalExpenseCategory): string {
    const labels: Record<OperationalExpenseCategory, string> = {
      taxi: "Taxi",
      paqueteria: "Paquetería",
      gasolina: "Gasolina",
      entrega: "Entrega",
      otro: "Otro",
    };
    return labels[category];
  }

  private financeCategoryFor(category: OperationalExpenseCategory): FinanceExpenseCategory {
    if (category === "gasolina" || category === "otro") return "consumibles";
    return "paqueteria";
  }

  private normalize(id: string, data: Record<string, any>): OperationalExpenseReport {
    const toIso = (value: any) => {
      if (!value) return null;
      if (typeof value?.toDate === "function") return value.toDate().toISOString();
      return String(value);
    };
    const status = data["approval_status"];
    return {
      report_id: String(data["report_id"] || id),
      business_id: normalizeBusinessId(data["business_id"]),
      category: this.normalizeCategory(data["category"]),
      amount: this.toAmount(data["amount"]),
      occurred_at: this.normalizeDate(data["occurred_at"]),
      route_id: this.optionalText(data["route_id"]),
      shipment_id: this.optionalText(data["shipment_id"]),
      order_id: this.optionalText(data["order_id"]),
      note: this.optionalText(data["note"]),
      reported_by: data["reported_by"] || null,
      approval_status: status === "approved" || status === "rejected" ? status : "pending",
      approved_expense_id: this.optionalText(data["approved_expense_id"]),
      approved_by: data["approved_by"] || null,
      approved_at: toIso(data["approved_at"]),
      rejected_reason: this.optionalText(data["rejected_reason"]),
      created_at: toIso(data["created_at"]),
      updated_at: toIso(data["updated_at"]),
    };
  }

  private normalizeCategory(value: unknown): OperationalExpenseCategory {
    if (value === "taxi" || value === "paqueteria" || value === "gasolina" || value === "entrega" || value === "otro") return value;
    return "otro";
  }

  private toAmount(value: unknown): number {
    const amount = Number(value || 0);
    return Number.isFinite(amount) ? Number(Math.max(0, amount).toFixed(2)) : 0;
  }

  private normalizeDate(value: unknown): string {
    const raw = String(value || "").trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
    return new Date().toISOString().slice(0, 10);
  }

  private optionalText(value: unknown): string | null {
    const text = String(value || "").trim();
    return text || null;
  }

  private actor(nameOverride?: string): { uid: string; name: string } {
    const user = FIREBASE_AUTH.currentUser;
    if (nameOverride) return { uid: user?.uid || "manual", name: nameOverride };
    return user ? { uid: user.uid, name: user.displayName || user.email || "Usuario" } : { uid: "system", name: "Sistema" };
  }
}
