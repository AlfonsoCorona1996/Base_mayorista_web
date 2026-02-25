import { Component, computed, inject, signal } from "@angular/core";
import { Router } from "@angular/router";
import { CustomersService } from "../../core/customers.service";
import { OrdersService } from "../../core/orders.service";
import {
  SupplierOperationRow,
  SupplierOperationStatus,
  SupplierOperationsService,
} from "../../core/supplier-operations.service";
import { SuppliersService } from "../../core/suppliers.service";

type StatusFilter = "all" | SupplierOperationStatus;
type PartialActionType = "levantar" | "enviar" | "recibir";
type GroupBadge = SupplierOperationStatus | "mixto";
type ProgressSegmentStatus = SupplierOperationStatus | "empty";
type OrdersListStatus = SupplierOperationStatus;

interface SupplierProductGroup {
  key: string;
  supplierId: string;
  supplierName: string;
  productName: string;
  imageUrl: string | null;
  size: string;
  color: string;
  variant: string;
  totalQty: number;
  doneQty: number;
  progressPct: number;
  countsByStatus: Record<SupplierOperationStatus, number>;
  linesByStatus: Record<SupplierOperationStatus, SupplierOperationRow[]>;
  lines: SupplierOperationRow[];
  badge: GroupBadge;
}

interface SupplierAccordionGroup {
  supplierId: string;
  supplierName: string;
  counts: Record<SupplierOperationStatus, number>;
  groups: SupplierProductGroup[];
}

interface PartialProcessCandidate {
  lineId: string;
  orderId: string;
  qty: number;
  status: SupplierOperationStatus;
  row: SupplierOperationRow;
}

interface SelectionModalState {
  actionType: PartialActionType;
  fromStatus: SupplierOperationStatus;
  targetStatus: SupplierOperationStatus;
  groupKey: string;
  productName: string;
  size: string;
  color: string;
  variant: string;
  availableQty: number;
  selectedQty: number;
  selectedMap: Record<string, boolean>;
  candidates: PartialProcessCandidate[];
  saving: boolean;
}

@Component({
  standalone: true,
  selector: "app-proveedores-operaciones",
  templateUrl: "./proveedores-operaciones.html",
  styleUrl: "./proveedores-operaciones.css",
})
export default class ProveedoresOperacionesPage {
  private supplierOps = inject(SupplierOperationsService);
  private suppliers = inject(SuppliersService);
  private customers = inject(CustomersService);
  private orders = inject(OrdersService);
  private router = inject(Router);

  loading = signal(false);
  savingById = signal<Record<string, boolean>>({});
  savingByGroup = signal<Record<string, boolean>>({});
  expandedSuppliers = signal<Record<string, boolean>>({});
  expandedGroups = signal<Record<string, boolean>>({});
  partialModal = signal<SelectionModalState | null>(null);
  error = signal<string | null>(null);
  success = signal<string | null>(null);
  statusFilter = signal<StatusFilter>("all");

  constructor() {
    this.reload();
  }

  rows = computed(() => this.supplierOps.rows());

  supplierSections = computed(() => {
    const groupedAllRows = this.buildGroupsBySupplier(this.rows());
    const filter = this.statusFilter();

    const sections = Array.from(groupedAllRows.entries())
      .map(([supplierId, groups]) => {
        const supplierName = groups[0]?.supplierName || this.suppliers.getById(supplierId)?.display_name || supplierId;
        const counts = this.sumSupplierCounts(groups);
        const visibleGroups =
          filter === "all" ? groups : groups.filter((group) => this.sumQtyByStatus(group.lines, filter) > 0);

        return {
          supplierId,
          supplierName,
          counts,
          groups: visibleGroups,
        };
      })
      .filter((section) => section.groups.length > 0)
      .sort((a, b) => a.supplierName.localeCompare(b.supplierName, "es", { sensitivity: "base" }));

    return sections;
  });

  statusOptions: Array<{ id: StatusFilter; label: string }> = [
    { id: "all", label: "Todos" },
    { id: "por_levantar", label: "Por levantar" },
    { id: "levantado", label: "Levantado" },
    { id: "en_camino", label: "En camino" },
    { id: "recibido", label: "Recibido" },
  ];

  async reload() {
    this.loading.set(true);
    this.error.set(null);

    try {
      await Promise.all([
        this.supplierOps.loadFromFirestore(),
        this.suppliers.loadFromFirestore().catch(() => null),
        this.customers.loadFromFirestore().catch(() => null),
        this.orders.loadFromFirestore().catch(() => null),
      ]);
      this.expandAllVisibleSuppliers();
    } catch (error: any) {
      this.error.set(error?.message || "No se pudo cargar operaciones de proveedores");
    } finally {
      this.loading.set(false);
    }
  }

  buildGroupKey(row: SupplierOperationRow): string {
    const supplierId = (row.supplier_id || "sin_proveedor").trim().toLowerCase();
    const productSeed = (row.product_id || row.title || "sin_producto").trim().toLowerCase();
    const size = (row.variant || "sin_talla").trim().toLowerCase();
    const color = (row.color || "sin_color").trim().toLowerCase();
    const variant = (row.variant || "sin_variante").trim().toLowerCase();
    return [supplierId, productSeed, size, color, variant].join("::");
  }

  computeDerivedStatus(lines: SupplierOperationRow[]): SupplierOperationStatus {
    if (lines.some((line) => line.status === "por_levantar")) return "por_levantar";
    if (lines.some((line) => line.status === "levantado")) return "levantado";
    if (lines.some((line) => line.status === "en_camino")) return "en_camino";
    return "recibido";
  }

  sumQtyByStatus(lines: SupplierOperationRow[], status: SupplierOperationStatus): number {
    return lines.filter((line) => line.status === status).reduce((sum, line) => sum + line.quantity, 0);
  }

  openPartialProcessModal(actionType: PartialActionType, group: SupplierProductGroup) {
    const fromStatus = this.fromStatusForAction(actionType);
    const targetStatus = this.targetStatusForAction(actionType);
    const candidates = group.linesByStatus[fromStatus].map((line) => ({
      lineId: line.op_id,
      orderId: line.order_id,
      qty: line.quantity,
      status: line.status,
      row: line,
    }));

    const availableQty = candidates.reduce((sum, item) => sum + item.qty, 0);
    if (availableQty <= 0) return;

    const selectedMap = this.autoSelectMap(candidates);
    const selectedQty = this.computeSelectedQty(candidates, selectedMap);

    this.partialModal.set({
      actionType,
      fromStatus,
      targetStatus,
      groupKey: group.key,
      productName: group.productName,
      size: group.size,
      color: group.color,
      variant: group.variant,
      availableQty,
      selectedQty,
      selectedMap,
      candidates,
      saving: false,
    });
  }

  closePartialProcessModal() {
    if (this.partialModal()?.saving) return;
    this.partialModal.set(null);
  }

  toggleSelection(lineId: string) {
    const modal = this.partialModal();
    if (!modal || modal.saving) return;

    const candidate = modal.candidates.find((item) => item.lineId === lineId);
    if (!candidate) return;

    const nextSelected = !modal.selectedMap[lineId];
    const selectedMap = { ...modal.selectedMap };

    if (nextSelected) {
      selectedMap[lineId] = true;
    } else {
      selectedMap[lineId] = false;
    }

    const selectedQty = this.computeSelectedQty(modal.candidates, selectedMap);
    this.partialModal.set({
      ...modal,
      selectedMap,
      selectedQty,
    });
  }

  canConfirm(): boolean {
    const modal = this.partialModal();
    if (!modal) return false;
    return !modal.saving && modal.selectedQty > 0;
  }

  async confirmPartialProcess() {
    const modal = this.partialModal();
    if (!modal || !this.canConfirm()) return;

    const selected = modal.candidates.filter((item) => modal.selectedMap[item.lineId]);
    if (selected.length === 0) return;

    this.error.set(null);
    this.success.set(null);
    this.partialModal.set({ ...modal, saving: true });
    this.setGroupSaving(modal.groupKey, true);

    try {
      const tasks = selected.map((candidate) => async () => {
        this.setSaving(candidate.lineId, true);
        try {
          await this.supplierOps.updateLineState(
            candidate.lineId,
            modal.targetStatus,
            `${candidate.lineId}:${modal.targetStatus}`,
            { reload: false },
          );
        } finally {
          this.setSaving(candidate.lineId, false);
        }
      });

      await this.runWithConcurrency(tasks, 4);
      await this.supplierOps.loadFromFirestore();
      this.success.set("Actualizado.");
      this.partialModal.set(null);
    } catch (error: any) {
      this.error.set(error?.message || "No se pudo actualizar el estado");
      await this.supplierOps.loadFromFirestore();
      const current = this.partialModal();
      if (current) {
        this.partialModal.set({ ...current, saving: false });
      }
    } finally {
      this.setGroupSaving(modal.groupKey, false);
    }
  }

  onOrderChipClick(orderId: string) {
    this.router.navigate(["/main/pedidos", orderId]);
  }

  orderDetailHref(orderId: string): string {
    const tree = this.router.createUrlTree(["/main/pedidos", orderId]);
    return this.router.serializeUrl(tree);
  }

  isGroupSaving(groupKey: string): boolean {
    return Boolean(this.savingByGroup()[groupKey]);
  }

  isSupplierExpanded(supplierId: string): boolean {
    return this.expandedSuppliers()[supplierId] !== false;
  }

  toggleSupplier(supplierId: string) {
    this.expandedSuppliers.update((current) => ({
      ...current,
      [supplierId]: !this.isSupplierExpanded(supplierId),
    }));
  }

  isGroupExpanded(groupKey: string): boolean {
    return this.expandedGroups()[groupKey] === true;
  }

  onTotalQtyBlockClick(groupKey: string) {
    this.expandedGroups.update((current) => ({
      ...current,
      [groupKey]: !this.isGroupExpanded(groupKey),
    }));
  }

  statusLabel(status: SupplierOperationStatus): string {
    switch (status) {
      case "por_levantar":
        return "Por levantar";
      case "levantado":
        return "Levantado";
      case "en_camino":
        return "En camino";
      case "recibido":
        return "Recibido";
      default:
        return status;
    }
  }

  groupBadgeLabel(group: SupplierProductGroup): string {
    if (group.badge === "mixto") return "Mixto";
    return this.statusLabel(group.badge);
  }

  statusClass(status: SupplierOperationStatus | "mixto"): string {
    switch (status) {
      case "por_levantar":
        return "chip chip-neutral";
      case "levantado":
        return "chip chip-info";
      case "en_camino":
        return "chip chip-warn";
      case "recibido":
        return "chip chip-ok";
      case "mixto":
        return "chip chip-mixed";
      default:
        return "chip chip-neutral";
    }
  }

  actionCount(group: SupplierProductGroup, action: PartialActionType): number {
    const fromStatus = this.fromStatusForAction(action);
    return group.countsByStatus[fromStatus];
  }

  getTotalQty(group: SupplierProductGroup): number {
    return group.totalQty;
  }

  getDoneQty(group: SupplierProductGroup): number {
    return group.doneQty;
  }

  getProgressPct(group: SupplierProductGroup): number {
    return group.progressPct;
  }

  getStatusSegments(group: SupplierProductGroup): ProgressSegmentStatus[] {
    const total = Math.max(0, Math.trunc(group.totalQty || 0));
    if (total === 0) return ["empty"];

    const segments: ProgressSegmentStatus[] = [];
    const statuses: SupplierOperationStatus[] = ["por_levantar", "levantado", "en_camino", "recibido"];

    for (const status of statuses) {
      const qty = Math.max(0, Math.trunc(group.countsByStatus[status] || 0));
      for (let i = 0; i < qty; i += 1) {
        segments.push(status);
      }
    }

    if (segments.length < total) {
      const missing = total - segments.length;
      for (let i = 0; i < missing; i += 1) {
        segments.push("por_levantar");
      }
    }

    return segments.slice(0, total);
  }

  progressSegmentClass(status: ProgressSegmentStatus): string {
    if (status === "por_levantar") return "status-progress-segment seg-pending";
    if (status === "levantado") return "status-progress-segment seg-lifted";
    if (status === "en_camino") return "status-progress-segment seg-transit";
    if (status === "recibido") return "status-progress-segment seg-received";
    return "status-progress-segment seg-empty";
  }

  actionLabel(action: PartialActionType): string {
    if (action === "levantar") return "Levantar";
    if (action === "enviar") return "Enviar";
    return "Recibir";
  }

  canShowAction(group: SupplierProductGroup, action: PartialActionType): boolean {
    return this.actionCount(group, action) > 0;
  }

  isCandidateChecked(lineId: string): boolean {
    return Boolean(this.partialModal()?.selectedMap[lineId]);
  }

  isCandidateDisabled(lineId: string): boolean {
    const modal = this.partialModal();
    if (!modal) return true;
    if (modal.saving) return true;
    return !modal.candidates.some((item) => item.lineId === lineId);
  }

  modalTitle(): string {
    const modal = this.partialModal();
    if (!modal) return "";
    if (modal.actionType === "levantar") return "Levantar";
    if (modal.actionType === "enviar") return "Enviar";
    return "Recibir";
  }

  modalConfirmText(): string {
    const modal = this.partialModal();
    if (!modal) return "Confirmar";
    if (modal.actionType === "levantar") return "Confirmar levantado";
    if (modal.actionType === "enviar") return "Confirmar en camino";
    return "Confirmar recibido";
  }

  copyPendingToClipboard(supplierId: string) {
    this.error.set(null);
    this.success.set(null);

    const supplierRows = this.rows().filter((row) => (row.supplier_id || "sin_proveedor") === supplierId);
    const pendingRows = supplierRows.filter((row) => row.status === "por_levantar");

    if (pendingRows.length === 0) {
      this.success.set("No hay pendientes por levantar para copiar.");
      return;
    }

    const grouped = this.buildGroups(pendingRows);
    const supplierName = grouped[0]?.supplierName || "Proveedor";
    const lines: string[] = [`${supplierName}`, "Pendientes por levantar:", ""];

    grouped.forEach((group, index) => {
      lines.push(`${index + 1}) ${group.productName} | ${group.size}/${group.color} | Total: ${group.countsByStatus.por_levantar}`);
      const pedidos = group.lines
        .filter((line) => line.status === "por_levantar")
        .map((line) => `${this.orderChipText(line.order_id)} (${line.quantity})`)
        .join(", ");
      lines.push(`   Pedidos: ${pedidos}`);
      lines.push("");
    });

    const text = lines.join("\n").trim();
    this.writeClipboardText(text)
      .then(() => this.success.set("Pendientes copiados al portapapeles."))
      .catch((err: any) => this.error.set(err?.message || "No se pudo copiar al portapapeles"));
  }

  productImage(row: SupplierOperationRow): string | null {
    const url = (row.image_url || "").trim();
    if (url) return url;
    const order = this.orders.getById(row.order_id);
    const orderItem = (order?.items || []).find((item) => item.item_id === row.order_item_id);
    return (orderItem?.image_url || "").trim() || null;
  }

  supplierName(row: SupplierOperationRow): string {
    if (row.supplier_name) return row.supplier_name;
    return this.suppliers.getById(row.supplier_id)?.display_name || row.supplier_id || "Sin proveedor";
  }

  productTitle(row: SupplierOperationRow): string {
    return (row.title || "Producto sin nombre").trim();
  }

  sizeLabel(row: SupplierOperationRow): string {
    return (row.variant || "").trim() || "Sin talla";
  }

  colorLabel(row: SupplierOperationRow): string {
    return (row.color || "").trim() || "Sin color";
  }

  orderChipText(orderId: string): string {
    const raw = String(orderId || "").trim();
    if (!raw) return "Pedido";
    return /^p-/i.test(raw) ? raw : `P-${raw}`;
  }

  trackSupplier(_: number, section: SupplierAccordionGroup): string {
    return section.supplierId;
  }

  trackGroup(_: number, group: SupplierProductGroup): string {
    return group.key;
  }

  trackLine(_: number, row: SupplierOperationRow): string {
    return row.op_id;
  }

  trackCandidate(_: number, candidate: PartialProcessCandidate): string {
    return candidate.lineId;
  }

  orderListStatuses(): OrdersListStatus[] {
    return ["en_camino", "levantado", "por_levantar", "recibido"];
  }

  hasLinesForStatus(group: SupplierProductGroup, status: OrdersListStatus): boolean {
    return group.linesByStatus[status].length > 0;
  }

  linesForStatus(group: SupplierProductGroup, status: OrdersListStatus): SupplierOperationRow[] {
    return group.linesByStatus[status];
  }

  orderSectionTitle(status: OrdersListStatus): string {
    if (status === "en_camino") return "EN TRANSITO";
    if (status === "levantado") return "LEVANTADOS";
    if (status === "por_levantar") return "PENDIENTES";
    return "RECIBIDOS";
  }

  qtyLabel(qty: number): string {
    return `${qty} ${qty === 1 ? "pza" : "pzas"}`;
  }

  private buildGroupsBySupplier(rows: SupplierOperationRow[]): Map<string, SupplierProductGroup[]> {
    const bySupplier = new Map<string, SupplierOperationRow[]>();

    for (const row of rows) {
      const supplierId = row.supplier_id || "sin_proveedor";
      const bucket = bySupplier.get(supplierId) || [];
      bucket.push(row);
      bySupplier.set(supplierId, bucket);
    }

    const result = new Map<string, SupplierProductGroup[]>();
    for (const [supplierId, supplierRows] of bySupplier.entries()) {
      result.set(supplierId, this.buildGroups(supplierRows));
    }

    return result;
  }

  private buildGroups(rows: SupplierOperationRow[]): SupplierProductGroup[] {
    const map = new Map<string, SupplierProductGroup>();

    for (const row of rows) {
      const key = this.buildGroupKey(row);
      const existing = map.get(key) || {
        key,
        supplierId: row.supplier_id || "sin_proveedor",
        supplierName: this.supplierName(row),
        productName: this.productTitle(row),
        imageUrl: this.productImage(row),
        size: this.sizeLabel(row),
        color: this.colorLabel(row),
        variant: (row.variant || "").trim(),
        totalQty: 0,
        doneQty: 0,
        progressPct: 0,
        countsByStatus: {
          por_levantar: 0,
          levantado: 0,
          en_camino: 0,
          recibido: 0,
        },
        linesByStatus: {
          por_levantar: [],
          levantado: [],
          en_camino: [],
          recibido: [],
        },
        lines: [],
        badge: "recibido" as GroupBadge,
      };

      existing.lines.push(row);
      existing.linesByStatus[row.status].push(row);
      existing.countsByStatus[row.status] += row.quantity;
      const qty = row.quantity ?? 1;
      existing.totalQty += qty;
      if (row.status !== "por_levantar") {
        existing.doneQty += qty;
      }
      if (!existing.imageUrl) {
        existing.imageUrl = this.productImage(row);
      }
      map.set(key, existing);
    }

    return Array.from(map.values())
      .map((group) => {
        group.lines.sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1));
        group.linesByStatus.por_levantar.sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1));
        group.linesByStatus.levantado.sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1));
        group.linesByStatus.en_camino.sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1));
        group.linesByStatus.recibido.sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1));
        group.progressPct = group.totalQty > 0 ? Math.round((group.doneQty / group.totalQty) * 100) : 0;
        group.badge = this.resolveGroupBadge(group.countsByStatus);
        return group;
      })
      .sort((a, b) => a.productName.localeCompare(b.productName, "es", { sensitivity: "base" }));
  }

  private resolveGroupBadge(counts: Record<SupplierOperationStatus, number>): GroupBadge {
    const active = Object.entries(counts)
      .filter(([, qty]) => qty > 0)
      .map(([status]) => status as SupplierOperationStatus);

    if (active.length === 0) return "recibido";
    if (active.length > 1) return "mixto";
    return active[0];
  }

  private sumSupplierCounts(groups: SupplierProductGroup[]): Record<SupplierOperationStatus, number> {
    const counts: Record<SupplierOperationStatus, number> = {
      por_levantar: 0,
      levantado: 0,
      en_camino: 0,
      recibido: 0,
    };

    for (const group of groups) {
      counts.por_levantar += group.countsByStatus.por_levantar;
      counts.levantado += group.countsByStatus.levantado;
      counts.en_camino += group.countsByStatus.en_camino;
      counts.recibido += group.countsByStatus.recibido;
    }

    return counts;
  }

  private expandAllVisibleSuppliers() {
    const map: Record<string, boolean> = {};
    for (const section of this.supplierSections()) {
      map[section.supplierId] = true;
    }
    this.expandedSuppliers.set(map);
  }

  private fromStatusForAction(actionType: PartialActionType): SupplierOperationStatus {
    if (actionType === "levantar") return "por_levantar";
    if (actionType === "enviar") return "levantado";
    return "en_camino";
  }

  private targetStatusForAction(actionType: PartialActionType): SupplierOperationStatus {
    if (actionType === "levantar") return "levantado";
    if (actionType === "enviar") return "en_camino";
    return "recibido";
  }

  private autoSelectMap(candidates: PartialProcessCandidate[]): Record<string, boolean> {
    const map: Record<string, boolean> = {};
    for (const candidate of candidates) {
      map[candidate.lineId] = true;
    }
    return map;
  }

  private computeSelectedQty(candidates: PartialProcessCandidate[], selectedMap: Record<string, boolean>): number {
    return candidates.reduce((sum, item) => sum + (selectedMap[item.lineId] ? item.qty : 0), 0);
  }

  private setSaving(opId: string, value: boolean) {
    this.savingById.update((current) => ({
      ...current,
      [opId]: value,
    }));
  }

  private setGroupSaving(groupKey: string, value: boolean) {
    this.savingByGroup.update((current) => ({
      ...current,
      [groupKey]: value,
    }));
  }

  private async runWithConcurrency(tasks: Array<() => Promise<void>>, concurrency: number): Promise<void> {
    if (tasks.length === 0) return;
    const size = Math.max(1, Math.floor(concurrency));
    let index = 0;

    const workers = new Array(Math.min(size, tasks.length)).fill(null).map(async () => {
      while (index < tasks.length) {
        const current = index;
        index += 1;
        await tasks[current]();
      }
    });

    await Promise.all(workers);
  }

  private async writeClipboardText(text: string): Promise<void> {
    if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return;
    }

    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute("readonly", "true");
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    textarea.style.pointerEvents = "none";
    document.body.appendChild(textarea);
    textarea.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(textarea);

    if (!ok) {
      throw new Error("No se pudo copiar al portapapeles");
    }
  }
}
