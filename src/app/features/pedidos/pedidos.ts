import { AfterViewInit, Component, ElementRef, OnDestroy, OnInit, QueryList, ViewChildren, computed, inject, signal, effect, ChangeDetectionStrategy, DestroyRef, HostListener } from "@angular/core";
import { takeUntilDestroyed } from "@angular/core/rxjs-interop";
import { CurrencyPipe, DatePipe, NgClass } from "@angular/common";
import { FormsModule } from "@angular/forms";
import { Router } from "@angular/router";
import JSZip from "jszip";
import { PDFDocument, StandardFonts, rgb, type PDFFont } from "pdf-lib";
import { CustomersService } from "../../core/customers.service";
import { OrdersService, Order, OrderStatus, IncidentSeverity } from "../../core/orders.service";
import { RoutesService } from "../../core/routes.service";
import { ActionChecklist, PrimaryAction, getActionChecklist, getPrimaryAction } from "./order-primary-action.mapper";
import { SalesNoteRenderRow, SalesNoteRenderService } from "./sales-note-render.service";
import { BusinessScopeService } from "../../core/business-scope.service";
import { BusinessId } from "../../core/rbac.constants";

type IntentFilter =
  | "hoy"
  | "por_confirmar"
  | "en_transito"
  | "en_empaque"
  | "listos_ruta"
  | "en_ruta"
  | "con_incidencias"
  | "cobranza_pendiente"
  | "cerrados";

type OrderAlert = { label: string; tone: "danger" | "warning" };

type OrderCardMeta = {
  customerName: string;
  routeName: string;
  primaryAlert: OrderAlert | null;
  hiddenAlertsCount: number;
  packagesMetaLabel: string;
  updatedAtRelative: string;
  visibleItems: Order["items"];
  hiddenItemsCount: number;
  ariaLabel: string;
};

type SalesNoteRow = SalesNoteRenderRow;
type SalesNoteFile = { fileName: string; blob: Blob };

type TableRangePreset = "today" | "last7" | "last30";
type TableSortColumn = "updated_at" | "created_at" | "status" | "customer" | "route" | "items" | "total";
type TableMenuColumn = "route" | "status";
type TableMenuOption = { value: string; label: string; count: number };
type TableBulkAction = "create_bitacora" | "create_nota" | "mark_pagado" | "mark_recibido" | "mark_listo_ruta";
type BitacoraConfig = {
  includeProductCount: boolean;
  includeProductDetail: boolean;
  includeProductPrices: boolean;
  includeCustomerContact: boolean;
};
type PedidosUiStateSnapshot = {
  viewMode: "cards" | "table";
  search: string;
  intentFilter: IntentFilter;
  routeFilter: string;
  tableSortCol: TableSortColumn;
  tableSortDir: "asc" | "desc";
  tableDateFrom: string;
  tableDateTo: string;
  tableRouteSelections: string[] | null;
  tableStatusSelections: string[] | null;
};

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  standalone: true,
  selector: "app-pedidos",
  imports: [FormsModule, DatePipe, CurrencyPipe, NgClass],
  templateUrl: "./pedidos.html",
  styleUrl: "./pedidos.css",
})
export default class PedidosPage implements OnInit, AfterViewInit, OnDestroy {
  private orders = inject(OrdersService);
  private customers = inject(CustomersService);
  private routes = inject(RoutesService);
  private salesNoteRender = inject(SalesNoteRenderService);
  businessScope = inject(BusinessScopeService);
  private router = inject(Router);
  private destroyRef = inject(DestroyRef);
  private readonly uiStateStorageKey = "pedidos.ui-state.v1";
  private uiStateHydrated = signal(false);

  search = signal("");
  intentFilter = signal<IntentFilter>("por_confirmar");
  routeFilter = signal<string>("todos");
  creating = signal(false);
  newCustomerId = signal<string>("");
  newBusinessId = signal<BusinessId>("bm");
  customerQuery = signal<string>("");
  showCustomerList = signal(false);
  newNotes = signal<string>("");
  error = signal<string | null>(null);
  loading = computed(() => this.orders.loading());
  actionSheetOpen = signal(false);
  sheetOrder = signal<Order | null>(null);
  sheetAction = signal<PrimaryAction | null>(null);
  sheetChecklist = signal<ActionChecklist | null>(null);
  resolveFocus = signal<"incidents" | "packages">("packages");
  plannedModalOpen = signal(false);
  plannedOrder = signal<Order | null>(null);
  plannedPackagesInput = signal(1);
  partialReason = signal("");
  partialReasonError = signal<string | null>(null);
  bulkNoteMode = signal(false);
  bulkNotesLoading = signal(false);
  bulkSelected = signal<Record<string, boolean>>({});
  bulkNotesMessage = signal<string | null>(null);

  // â”€â”€ Vista tabla â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  viewMode = signal<"cards" | "table">("cards");
  tableSortCol = signal<TableSortColumn>("updated_at");
  tableSortDir = signal<"asc" | "desc">("desc");
  tableDateFrom = signal<string>("");
  tableDateTo   = signal<string>("");
  tableMenuOpen = signal<TableMenuColumn | null>(null);
  tableMenuPosition = signal<{ left: number; top: number; width: number } | null>(null);
  tableRouteSelections = signal<string[] | null>(null);
  tableStatusSelections = signal<string[] | null>(null);
  tableSelectionMode = signal(false);
  tableSelected = signal<Record<string, boolean>>({});
  tableBulkMenuOpen = signal(false);
  tableBulkMenuPosition = signal<{ left: number; top: number; width: number } | null>(null);
  tableBulkActionLoading = signal(false);
  tableBulkProgressVisible = signal(false);
  tableBulkProgressLabel = signal("");
  tableBulkProgressCurrent = signal(0);
  tableBulkProgressTotal = signal(0);
  tableBulkResultVisible = signal(false);
  tableBulkResultText = signal("");
  bitacoraConfigOpen = signal(false);
  bitacoraIncludeProductCount = signal(true);
  bitacoraIncludeProductDetail = signal(false);
  bitacoraIncludeProductPrices = signal(false);
  bitacoraIncludeCustomerContact = signal(false);
  bitacoraRouteSelections = signal<string[]>([]);
  bitacoraConfigError = signal<string | null>(null);
  tableBulkProgressPercent = computed(() => {
    const total = this.tableBulkProgressTotal();
    if (total <= 0) return 0;
    return Math.max(0, Math.min(100, Math.round((this.tableBulkProgressCurrent() / total) * 100)));
  });
  private tableBulkProgressHideTimer: ReturnType<typeof setTimeout> | null = null;
  private visiblePillsByOrder = signal<Record<string, number>>({});
  private pillsResizeObserver: ResizeObserver | null = null;
  private pillMeasureEl: HTMLSpanElement | null = null;
  @ViewChildren("pillsRow", { read: ElementRef }) pillsRows!: QueryList<ElementRef<HTMLElement>>;
  private readonly intentsForCount: IntentFilter[] = [
    "hoy",
    "por_confirmar",
    "en_transito",
    "en_empaque",
    "listos_ruta",
    "en_ruta",
    "con_incidencias",
    "cobranza_pendiente",
    "cerrados",
  ];
  private readonly orderMetaCache = new Map<
    string,
    {
      orderRef: Order;
      visibleCount: number;
      customerName: string;
      routeName: string;
      meta: OrderCardMeta;
    }
  >();

  constructor() {
    effect(() => {
      if (!this.uiStateHydrated()) return;
      this.saveUiStateSnapshot(this.captureUiStateSnapshot());
    });
    effect(() => {
      if (this.viewMode() !== "table" && this.tableSelectionMode()) {
        this.disableTableSelectionMode();
      }
    });
    effect(() => {
      const route = this.routeFilter();
      if (route === "todos") return;
      if (this.tableRouteSelections() !== null) {
        this.tableRouteSelections.set(null);
      }
      if (this.tableMenuOpen() === "route") {
        this.tableMenuOpen.set(null);
        this.tableMenuPosition.set(null);
      }
    });
    effect(
      () => {
        const writeBusiness = this.businessScope.writeBusinessId();
        const scope = this.businessScope.scope();
        const current = this.newBusinessId();
        if (scope !== "both" || !this.businessScope.canAccessBusiness(current)) {
          this.newBusinessId.set(writeBusiness);
        }
      },
      { allowSignalWrites: true },
    );
  }

  list = computed(() => this.orders.list());
  intentCounts = computed(() => {
    const term = this.normalizeSearchTerm(this.search());
    const route = this.routeFilter();
    const counts: Record<IntentFilter, number> = {
      hoy: 0,
      por_confirmar: 0,
      en_transito: 0,
      en_empaque: 0,
      listos_ruta: 0,
      en_ruta: 0,
      con_incidencias: 0,
      cobranza_pendiente: 0,
      cerrados: 0,
    };

    for (const order of this.list()) {
      if (route !== "todos" && order.route_id !== route) continue;
      if (!this.matchesSearchTerm(order, term)) continue;

      for (const intent of this.intentsForCount) {
        if (this.matchesIntent(order, intent)) counts[intent] += 1;
      }
    }

    return counts;
  });

  filtered = computed(() => {
    const term = this.normalizeSearchTerm(this.search());
    const intent = this.intentFilter();
    const route = this.routeFilter();

    return this.list()
      .filter((order) => {
        if (!this.matchesIntent(order, intent)) return false;
        if (route !== "todos" && order.route_id !== route) return false;
        return this.matchesSearchTerm(order, term);
      })
      .sort((a, b) => (a.updated_at > b.updated_at ? -1 : 1));
  });
  private filteredById = computed(() => {
    const map = new Map<string, Order>();
    for (const order of this.filtered()) {
      map.set(order.order_id, order);
    }
    return map;
  });

  private tableBaseRows = computed(() => {
    const from = this.tableDateFrom();
    const to = this.tableDateTo();
    const term = this.normalizeSearchTerm(this.search());
    const route = this.routeFilter();

    return this.list().filter((order) => {
      if (route !== "todos" && order.route_id !== route) return false;
      if (!this.matchesSearchTerm(order, term)) return false;
      const createdDate = this.toLocalDateInputValueFromString(order.created_at);
      if (!createdDate) return false;
      if (from && createdDate < from) return false;
      if (to && createdDate > to) return false;
      return true;
    });
  });

  tableRouteMenuOptions = computed<TableMenuOption[]>(() => {
    const rows = this.applyStatusColumnFilter(this.tableBaseRows());
    const map = new Map<string, TableMenuOption>();
    for (const order of rows) {
      const value = this.tableRouteFilterKey(order.route_id);
      const found = map.get(value);
      if (found) {
        found.count += 1;
        continue;
      }
      map.set(value, { value, label: this.routeName(order.route_id), count: 1 });
    }
    return [...map.values()].sort((a, b) => a.label.localeCompare(b.label, "es-MX"));
  });

  tableStatusMenuOptions = computed<TableMenuOption[]>(() => {
    const rows = this.applyRouteColumnFilter(this.tableBaseRows());
    const map = new Map<string, TableMenuOption>();
    for (const order of rows) {
      const value = this.tableStatusFilterKey(order.status);
      const found = map.get(value);
      if (found) {
        found.count += 1;
        continue;
      }
      map.set(value, { value, label: this.tableStatusLabel(order.status), count: 1 });
    }
    return [...map.values()].sort((a, b) => a.label.localeCompare(b.label, "es-MX"));
  });

  tableRouteColumnFilterDisabled = computed(() => this.routeFilter() !== "todos");
  tableHasRouteFilter = computed(() => !this.tableRouteColumnFilterDisabled() && this.tableRouteSelections() !== null);
  tableHasStatusFilter = computed(() => this.tableStatusSelections() !== null);
  tableHasNonDefaultSort = computed(() => this.tableSortCol() !== "updated_at" || this.tableSortDir() !== "desc");
  tableHasPrimaryFilters = computed(() => {
    const search = this.search().trim();
    const route = this.routeFilter();
    return search.length > 0 || route !== "todos";
  });
  tableHasAnyFilters = computed(() =>
    this.tableHasPrimaryFilters()
    || !!this.tableDateFrom()
    || !!this.tableDateTo()
    || this.tableHasRouteFilter()
    || this.tableHasStatusFilter()
    || this.tableHasNonDefaultSort()
  );

  private tableRowsFiltered = computed(() => {
    let rows = this.tableBaseRows();
    rows = this.applyRouteColumnFilter(rows);
    rows = this.applyStatusColumnFilter(rows);
    return rows;
  });

  /** Filas de la vista tabla: aplica filtros de columna y ordenamiento */
  tableRows = computed(() => {
    const col = this.tableSortCol();
    const dir = this.tableSortDir();
    const rows = [...this.tableRowsFiltered()];

    return rows.sort((a, b) => {
      let va: string | number = "";
      let vb: string | number = "";
      switch (col) {
        case "updated_at":
          va = a.updated_at || "";
          vb = b.updated_at || "";
          break;
        case "created_at":
          va = a.created_at || "";
          vb = b.created_at || "";
          break;
        case "status":
          va = a.status || "";
          vb = b.status || "";
          break;
        case "customer":
          va = this.customerName(a.customer_id);
          vb = this.customerName(b.customer_id);
          break;
        case "route":
          va = this.routeName(a.route_id);
          vb = this.routeName(b.route_id);
          break;
        case "items":
          va = (a.items || []).length;
          vb = (b.items || []).length;
          break;
        case "total":
          va = this.tableOrderClientTotal(a);
          vb = this.tableOrderClientTotal(b);
          break;
      }
      if (va < vb) return dir === "asc" ? -1 : 1;
      if (va > vb) return dir === "asc" ? 1 : -1;
      return 0;
    });
  });

  tableRangeCompactSummary = computed(() => {
    const from = this.tableDateFrom();
    const to = this.tableDateTo();
    if (!from && !to) return "";
    if (from && to) return `${this.formatTableDateCompact(from)} -> ${this.formatTableDateCompact(to)}`;
    if (from) return `desde ${this.formatTableDateCompact(from)}`;
    return `hasta ${this.formatTableDateCompact(to)}`;
  });

  tableSelectedRows = computed(() => {
    const selected = this.tableSelected();
    return this.tableRows().filter((order) => !!selected[order.order_id]);
  });

  tableSelectedCount = computed(() => this.tableSelectedRows().length);

  tableAllVisibleSelected = computed(() => {
    const rows = this.tableRows();
    if (rows.length === 0) return false;
    const selected = this.tableSelected();
    return rows.every((order) => !!selected[order.order_id]);
  });

  tableMarkPaidEligibleRows = computed(() =>
    this.tableSelectedRows().filter((order) => order.status === "ready_for_route")
  );

  tableMarkReceivedEligibleRows = computed(() =>
    this.tableSelectedRows().filter((order) => this.canMarkAsReceivedFromBulk(order.status))
  );

  tableMarkReadyForRouteEligibleRows = computed(() =>
    this.tableSelectedRows().filter((order) => this.canMarkAsReadyForRouteFromBulk(order))
  );
  bitacoraRouteOptions = computed<TableMenuOption[]>(() => {
    const map = new Map<string, TableMenuOption>();
    for (const order of this.tableRowsFiltered()) {
      const value = this.tableRouteFilterKey(order.route_id);
      const found = map.get(value);
      if (found) {
        found.count += 1;
      } else {
        map.set(value, { value, label: this.routeName(order.route_id), count: 1 });
      }
    }
    return [...map.values()].sort((a, b) => a.label.localeCompare(b.label, "es-MX"));
  });
  bitacoraSelectionRouteCount = computed(() => {
    const selected = this.tableSelectedRows();
    const routes = new Set(selected.map((order) => this.tableRouteFilterKey(order.route_id)));
    return routes.size;
  });
  bitacoraCanCreate = computed(() => {
    if (this.tableSelectionMode()) return this.tableSelectedCount() > 0;
    const selectedRoutes = new Set(this.bitacoraRouteSelections());
    if (selectedRoutes.size === 0) return false;
    return this.tableRowsFiltered().some((order) => selectedRoutes.has(this.tableRouteFilterKey(order.route_id)));
  });

  toggleTableSort(col: TableSortColumn): void {
    if (this.tableSortCol() === col) {
      this.tableSortDir.update(d => d === "asc" ? "desc" : "asc");
    } else {
      this.tableSortCol.set(col);
      this.tableSortDir.set("desc");
    }
  }

  setTableSortFromMenu(col: TableMenuColumn, dir: "asc" | "desc", event?: Event): void {
    event?.stopPropagation();
    this.tableSortCol.set(col);
    this.tableSortDir.set(dir);
    this.tableMenuOpen.set(null);
    this.tableMenuPosition.set(null);
  }

  toggleTableColumnMenu(col: TableMenuColumn, event?: Event): void {
    event?.stopPropagation();
    this.tableBulkMenuOpen.set(false);
    this.tableBulkMenuPosition.set(null);
    if (this.tableMenuOpen() === col) {
      this.tableMenuOpen.set(null);
      this.tableMenuPosition.set(null);
      return;
    }
    this.tableMenuOpen.set(col);
    this.tableMenuPosition.set(this.computeTableMenuPosition(event));
  }

  isTableColumnMenuOpen(col: TableMenuColumn): boolean {
    return this.tableMenuOpen() === col;
  }

  isTableRouteOptionChecked(value: string): boolean {
    const selected = this.tableRouteSelections();
    if (selected === null) return true;
    return selected.includes(value);
  }

  isTableStatusOptionChecked(value: string): boolean {
    const selected = this.tableStatusSelections();
    if (selected === null) return true;
    return selected.includes(value);
  }

  toggleTableRouteOption(value: string, checked: boolean): void {
    if (this.tableRouteColumnFilterDisabled()) return;
    const options = this.tableRouteMenuOptions().map((option) => option.value);
    this.tableRouteSelections.update((selected) => this.updateColumnSelection(selected, options, value, checked));
  }

  toggleTableStatusOption(value: string, checked: boolean): void {
    const options = this.tableStatusMenuOptions().map((option) => option.value);
    this.tableStatusSelections.update((selected) => this.updateColumnSelection(selected, options, value, checked));
  }

  clearTableRouteColumnFilter(event?: Event): void {
    event?.stopPropagation();
    if (this.tableRouteColumnFilterDisabled()) return;
    this.tableRouteSelections.set(null);
  }

  clearTableStatusColumnFilter(event?: Event): void {
    event?.stopPropagation();
    this.tableStatusSelections.set(null);
  }

  @HostListener("document:keydown.escape")
  onTableMenuEscape(): void {
    if (this.bitacoraConfigOpen()) {
      this.closeBitacoraConfig();
      return;
    }
    this.tableMenuOpen.set(null);
    this.tableMenuPosition.set(null);
    this.tableBulkMenuOpen.set(false);
    this.tableBulkMenuPosition.set(null);
  }

  @HostListener("document:click", ["$event"])
  onTableMenuOutsideClick(event: MouseEvent): void {
    if (!this.tableMenuOpen() && !this.tableBulkMenuOpen()) return;
    const target = event.target as HTMLElement | null;
    if (!target) {
      this.tableMenuOpen.set(null);
      this.tableMenuPosition.set(null);
      this.tableBulkMenuOpen.set(false);
      this.tableBulkMenuPosition.set(null);
      return;
    }
    if (
      target.closest(".th-menu-trigger")
      || target.closest(".th-menu-dropdown")
      || target.closest(".tfilter-bulk-trigger")
      || target.closest(".table-bulk-menu")
      || target.closest(".th-select-trigger")
    ) {
      return;
    }
    this.tableMenuOpen.set(null);
    this.tableMenuPosition.set(null);
    this.tableBulkMenuOpen.set(false);
    this.tableBulkMenuPosition.set(null);
  }

  @HostListener("window:resize")
  onWindowResizeCloseTableMenu(): void {
    if (!this.tableMenuOpen() && !this.tableBulkMenuOpen()) return;
    this.tableMenuOpen.set(null);
    this.tableMenuPosition.set(null);
    this.tableBulkMenuOpen.set(false);
    this.tableBulkMenuPosition.set(null);
  }

  applyTableRangePreset(preset: TableRangePreset): void {
    const today = new Date();
    const to = this.toDateInputValue(today);
    let from = to;
    if (preset === "last7") {
      const start = new Date(today);
      start.setDate(start.getDate() - 6);
      from = this.toDateInputValue(start);
    } else if (preset === "last30") {
      const start = new Date(today);
      start.setDate(start.getDate() - 29);
      from = this.toDateInputValue(start);
    }
    this.tableDateFrom.set(from);
    this.tableDateTo.set(to);
  }

  isTableRangePresetActive(preset: TableRangePreset): boolean {
    const from = this.tableDateFrom();
    const to = this.tableDateTo();
    if (!from || !to) return false;
    const today = new Date();
    const expectedTo = this.toDateInputValue(today);
    let expectedFrom = expectedTo;
    if (preset === "last7") {
      const start = new Date(today);
      start.setDate(start.getDate() - 6);
      expectedFrom = this.toDateInputValue(start);
    } else if (preset === "last30") {
      const start = new Date(today);
      start.setDate(start.getDate() - 29);
      expectedFrom = this.toDateInputValue(start);
    }
    return from === expectedFrom && to === expectedTo;
  }

  clearTableRange(): void {
    this.tableDateFrom.set("");
    this.tableDateTo.set("");
  }

  clearTableFilters(): void {
    this.search.set("");
    this.routeFilter.set("todos");
    this.clearTableRange();
    this.tableRouteSelections.set(null);
    this.tableStatusSelections.set(null);
    this.tableSortCol.set("updated_at");
    this.tableSortDir.set("desc");
    this.tableMenuOpen.set(null);
    this.tableMenuPosition.set(null);
    this.disableTableSelectionMode();
  }

  toggleTableSelectionMode(event?: Event): void {
    event?.stopPropagation();
    this.tableMenuOpen.set(null);
    this.tableMenuPosition.set(null);
    this.tableBulkMenuOpen.set(false);
    this.tableBulkMenuPosition.set(null);
    if (this.tableSelectionMode()) {
      this.disableTableSelectionMode();
      return;
    }
    this.tableSelectionMode.set(true);
    this.tableSelected.set({});
  }

  disableTableSelectionMode(): void {
    this.tableSelectionMode.set(false);
    this.tableSelected.set({});
    this.tableBulkMenuOpen.set(false);
    this.tableBulkMenuPosition.set(null);
  }

  onTableRowActivate(order: Order, event?: Event): void {
    if (!this.tableSelectionMode()) {
      this.open(order.order_id);
      return;
    }
    event?.preventDefault();
    event?.stopPropagation();
    const selected = !!this.tableSelected()[order.order_id];
    this.toggleTableRowSelection(order.order_id, !selected);
  }

  onTableSelectionCheckboxClick(event: Event): void {
    event.stopPropagation();
  }

  toggleTableRowSelection(orderId: string, checked: boolean): void {
    this.tableSelected.update((current) => {
      const next = { ...current };
      if (checked) {
        next[orderId] = true;
      } else {
        delete next[orderId];
      }
      return next;
    });
  }

  toggleTableSelectAllVisible(checked: boolean, event?: Event): void {
    event?.stopPropagation();
    const ids = this.visibleTableRowIds();
    this.tableSelected.update((current) => {
      const next = { ...current };
      for (const id of ids) {
        if (checked) next[id] = true;
        else delete next[id];
      }
      return next;
    });
  }

  toggleTableBulkMenu(event?: Event): void {
    event?.stopPropagation();
    this.tableMenuOpen.set(null);
    this.tableMenuPosition.set(null);
    if (this.tableBulkMenuOpen()) {
      this.tableBulkMenuOpen.set(false);
      this.tableBulkMenuPosition.set(null);
      return;
    }
    this.tableBulkMenuOpen.set(true);
    this.tableBulkMenuPosition.set(this.computeTableBulkMenuPosition(event));
  }

  closeTableBulkResult(event?: Event): void {
    event?.stopPropagation();
    this.tableBulkResultVisible.set(false);
    this.tableBulkResultText.set("");
  }

  openBitacoraConfig(event?: Event): void {
    event?.stopPropagation();
    this.tableBulkMenuOpen.set(false);
    this.tableBulkMenuPosition.set(null);
    this.bitacoraConfigError.set(null);

    this.bitacoraIncludeProductCount.set(true);
    this.bitacoraIncludeProductDetail.set(false);
    this.bitacoraIncludeProductPrices.set(false);
    this.bitacoraIncludeCustomerContact.set(false);

    if (!this.tableSelectionMode()) {
      const defaults = this.bitacoraRouteOptions().map((option) => option.value);
      this.bitacoraRouteSelections.set(defaults);
    } else {
      this.bitacoraRouteSelections.set([]);
    }

    this.bitacoraConfigOpen.set(true);
  }

  closeBitacoraConfig(event?: Event): void {
    event?.stopPropagation();
    this.bitacoraConfigOpen.set(false);
    this.bitacoraConfigError.set(null);
  }

  onBitacoraProductCountToggle(checked: boolean): void {
    this.bitacoraIncludeProductCount.set(checked);
    if (!checked) {
      this.bitacoraIncludeProductDetail.set(false);
      this.bitacoraIncludeProductPrices.set(false);
    }
  }

  onBitacoraProductDetailToggle(checked: boolean): void {
    this.bitacoraIncludeProductDetail.set(checked);
    if (checked) {
      this.bitacoraIncludeProductCount.set(true);
      return;
    }
    this.bitacoraIncludeProductPrices.set(false);
  }

  onBitacoraProductPricesToggle(checked: boolean): void {
    this.bitacoraIncludeProductPrices.set(checked);
    if (!checked) return;
    this.bitacoraIncludeProductCount.set(true);
    this.bitacoraIncludeProductDetail.set(true);
  }

  isBitacoraRouteSelected(value: string): boolean {
    return this.bitacoraRouteSelections().includes(value);
  }

  toggleBitacoraRouteSelection(value: string, checked: boolean): void {
    this.bitacoraRouteSelections.update((current) => {
      if (checked) {
        if (current.includes(value)) return current;
        return [...current, value];
      }
      return current.filter((id) => id !== value);
    });
  }

  bitacoraSelectionSummaryText(): string {
    const clients = this.tableSelectedCount();
    const routes = this.bitacoraSelectionRouteCount();
    return `Se creara una bitacora para ${this.tableBulkCountLabel(clients, "clienta", "clientas")} en ${this.tableBulkCountLabel(routes, "ruta", "rutas")}.`;
  }

  async confirmBitacoraConfig(event?: Event): Promise<void> {
    event?.stopPropagation();
    this.bitacoraConfigError.set(null);

    const orders = this.resolveBitacoraTargetOrders();
    if (orders.length === 0) {
      this.bitacoraConfigError.set("No hay pedidos para generar bitacora con la configuracion actual.");
      return;
    }

    const config: BitacoraConfig = {
      includeProductCount: this.bitacoraIncludeProductCount(),
      includeProductDetail: this.bitacoraIncludeProductDetail(),
      includeProductPrices: this.bitacoraIncludeProductPrices(),
      includeCustomerContact: this.bitacoraIncludeCustomerContact(),
    };

    this.bitacoraConfigOpen.set(false);
    this.tableBulkActionLoading.set(true);
    this.tableBulkResultVisible.set(false);
    this.tableBulkResultText.set("");

    let generated = 0;
    let failed = 0;
    let routes = 0;

    try {
      const result = await this.generateRouteBitacoraPdfs(orders, config);
      generated = result.generated;
      failed = result.failed;
      routes = result.routes;
    } finally {
      this.tableBulkActionLoading.set(false);
      if (generated > 0 && this.tableSelectionMode()) {
        this.tableSelected.set({});
      }
    }

    const generatedLabel = `${generated} PDF${generated === 1 ? "" : "s"} creados`;
    const routesLabel = this.tableBulkCountLabel(routes, "ruta", "rutas");
    const errorLabel = failed > 0 ? ` | ${this.tableBulkCountLabel(failed, "ruta con error", "rutas con error")}` : "";
    this.tableBulkResultText.set(`Bitacora creada, ${generatedLabel} para ${routesLabel}${errorLabel}`);
    this.tableBulkResultVisible.set(true);
    this.bulkNotesMessage.set(null);
  }

  private resolveBitacoraTargetOrders(): Order[] {
    if (this.tableSelectionMode()) return this.tableSelectedRows();
    const selectedRoutes = new Set(this.bitacoraRouteSelections());
    if (selectedRoutes.size === 0) return [];
    return this.tableRowsFiltered().filter((order) => selectedRoutes.has(this.tableRouteFilterKey(order.route_id)));
  }

  canApplyTableBulkAction(action: TableBulkAction): boolean {
    if (this.tableBulkActionLoading()) return false;
    if (action === "create_bitacora") {
      if (this.tableSelectionMode()) return this.tableSelectedCount() > 0;
      return this.bitacoraRouteOptions().length > 0;
    }
    if (!this.tableSelectionMode()) {
      return false;
    }
    if (action === "create_nota") {
      return this.tableSelectedCount() > 0;
    }
    if (action === "mark_pagado") {
      return this.tableMarkPaidEligibleRows().length > 0;
    }
    if (action === "mark_listo_ruta") {
      return this.tableMarkReadyForRouteEligibleRows().length > 0;
    }
    return this.tableMarkReceivedEligibleRows().length > 0;
  }

  async applyTableBulkAction(action: TableBulkAction, event?: Event): Promise<void> {
    event?.stopPropagation();
    if (!this.canApplyTableBulkAction(action)) return;
    if (action === "create_bitacora") {
      this.openBitacoraConfig(event);
      return;
    }

    const selectedRows = this.tableSelectedRows();
    if (selectedRows.length === 0) return;

    this.tableBulkActionLoading.set(true);
    this.tableBulkMenuOpen.set(false);
    this.tableBulkMenuPosition.set(null);
    let updated = 0;
    let skipped = 0;
    let failed = 0;
    const generatedNoteFiles: SalesNoteFile[] = [];
    if (action === "create_nota") {
      this.tableBulkResultVisible.set(false);
      this.tableBulkResultText.set("");
    }
    this.tableBulkProgressVisible.set(false);
    this.tableBulkProgressLabel.set("");
    this.tableBulkProgressCurrent.set(0);
    this.tableBulkProgressTotal.set(0);

    try {
      if (action === "create_nota") {
        for (const order of selectedRows) {
          try {
            const rows = this.salesNoteRows(order);
            if (rows.length === 0) {
              skipped += 1;
              continue;
            }
            const blob = await this.buildSalesNoteImage(order, rows);
            generatedNoteFiles.push({
              fileName: `nota-${order.order_id}-${Date.now()}.png`,
              blob,
            });
            await this.orders.logEvent(
              order.order_id,
              "SALES_NOTE_GENERATED",
              "Nota de venta generada (seleccion de tabla)",
              {
                rows: rows.length,
                total: rows.reduce((sum, row) => sum + row.lineTotal, 0),
                mode: "table_bulk_selection",
              }
            ).catch(() => null);
            updated += 1;
            await this.sleep(120);
          } catch {
            failed += 1;
          }
        }
        await this.downloadSalesNotesBundle(generatedNoteFiles, "notas-tabla");
      } else if (action === "mark_pagado") {
        for (const order of selectedRows) {
          if (order.status !== "ready_for_route") {
            skipped += 1;
            continue;
          }
          try {
            const total = this.tableOrderClientTotal(order);
            if (total > 0) {
              await this.orders.closeWithPayment(order.order_id, total, total);
            } else {
              await this.orders.updateStatus(order.order_id, "pagado");
            }
            await this.orders.logEvent(
              order.order_id,
              "PAYMENT_REGISTERED",
              "Marcado como pagado desde seleccion de tabla",
              { source: "pedidos_table_selection", total_amount: total }
            ).catch(() => null);
            updated += 1;
          } catch {
            failed += 1;
          }
        }
      } else if (action === "mark_recibido") {
        for (const order of selectedRows) {
          if (!this.canMarkAsReceivedFromBulk(order.status)) {
            skipped += 1;
            continue;
          }
          try {
            await this.orders.updateStatus(order.order_id, "recibido_qa");
            await this.orders.logEvent(
              order.order_id,
              "ORDER_RECEIVED_MARKED",
              "Marcado como recibido desde seleccion de tabla",
              { source: "pedidos_table_selection", previous_status: order.status }
            ).catch(() => null);
            updated += 1;
          } catch {
            failed += 1;
          }
        }
      } else if (action === "mark_listo_ruta") {
        for (const order of selectedRows) {
          if (!this.canMarkAsReadyForRouteFromBulk(order)) {
            skipped += 1;
            continue;
          }
          try {
            const packagesCount = this.closedPackagesCount(order);
            await this.orders.markReadyForRoute(order.order_id, packagesCount);
            await this.orders.logEvent(
              order.order_id,
              "DISPATCH_READY",
              "Marcado listo para ruta desde seleccion de tabla",
              {
                source: "pedidos_table_selection",
                previous_status: order.status,
                packages_count: packagesCount,
              }
            ).catch(() => null);
            updated += 1;
          } catch {
            failed += 1;
          }
        }
      }
    } finally {
      this.tableBulkActionLoading.set(false);
      if (updated > 0) {
        this.tableSelected.set({});
      }
    }

    const actionLabel = this.tableBulkActionLabel(action);
    if (action === "create_nota") {
      const notesLabel = this.tableBulkCountLabel(updated, "nota creada", "notas creadas");
      const skippedLabel = this.tableBulkCountLabel(skipped, "omitida", "omitidas");
      const failedLabel = failed > 0
        ? `, ${this.tableBulkCountLabel(failed, "con error", "con errores")}`
        : "";
      this.tableBulkResultText.set(`${notesLabel}, ${skippedLabel}${failedLabel}`);
      this.tableBulkResultVisible.set(true);
      this.bulkNotesMessage.set(null);
      return;
    }

    const summary = [
      `${actionLabel}: ${this.tableBulkCountLabel(updated, "aplicado", "aplicados")}`,
      skipped > 0 ? this.tableBulkCountLabel(skipped, "omitido", "omitidos") : "",
      failed > 0 ? this.tableBulkCountLabel(failed, "con error", "con errores") : "",
    ].filter(Boolean).join(" | ");
    this.bulkNotesMessage.set(summary);
  }

  private updateColumnSelection(
    selected: string[] | null,
    options: string[],
    value: string,
    checked: boolean
  ): string[] | null {
    const available = [...new Set(options)];

    if (checked) {
      if (selected === null) return null;
      const next = [...new Set([...selected, value])];
      if (available.length > 0 && available.every((option) => next.includes(option))) return null;
      return next;
    }

    if (selected === null) {
      return available.filter((option) => option !== value);
    }

    return selected.filter((option) => option !== value);
  }

  private tableRouteFilterKey(routeId: string | null): string {
    return routeId || "sin_ruta";
  }

  private tableStatusFilterKey(status: string): string {
    return status || "sin_estado";
  }

  private computeTableMenuPosition(event?: Event): { left: number; top: number; width: number } {
    const margin = 8;
    const maxAllowedWidth = Math.max(180, window.innerWidth - (margin * 2));
    const menuWidth = Math.min(260, maxAllowedWidth);
    const trigger = this.resolveTableMenuTrigger(event);
    if (!trigger) {
      return {
        left: margin,
        top: 140,
        width: menuWidth,
      };
    }
    const rect = trigger.getBoundingClientRect();
    const centerLeft = rect.left + (rect.width / 2) - (menuWidth / 2);
    const left = Math.min(window.innerWidth - margin - menuWidth, Math.max(margin, centerLeft));
    const top = Math.max(76, rect.bottom + 6);
    return { left, top, width: menuWidth };
  }

  private resolveTableMenuTrigger(event?: Event): HTMLElement | null {
    if (!event) return null;
    const currentTarget = event.currentTarget;
    if (currentTarget instanceof HTMLElement) return currentTarget;
    const target = event.target;
    if (!(target instanceof HTMLElement)) return null;
    return target.closest(".th-menu-trigger");
  }

  private computeTableBulkMenuPosition(event?: Event): { left: number; top: number; width: number } {
    const margin = 8;
    const maxAllowedWidth = Math.max(190, window.innerWidth - (margin * 2));
    const menuWidth = Math.min(280, maxAllowedWidth);
    const trigger = this.resolveTableBulkMenuTrigger(event);
    if (!trigger) {
      return {
        left: Math.max(margin, window.innerWidth - menuWidth - margin),
        top: 140,
        width: menuWidth,
      };
    }
    const rect = trigger.getBoundingClientRect();
    const left = Math.min(window.innerWidth - margin - menuWidth, Math.max(margin, rect.right - menuWidth));
    const top = Math.max(76, rect.bottom + 6);
    return { left, top, width: menuWidth };
  }

  private resolveTableBulkMenuTrigger(event?: Event): HTMLElement | null {
    if (!event) return null;
    const currentTarget = event.currentTarget;
    if (currentTarget instanceof HTMLElement) return currentTarget;
    const target = event.target;
    if (!(target instanceof HTMLElement)) return null;
    return target.closest(".tfilter-bulk-trigger");
  }

  private visibleTableRowIds(): string[] {
    return this.tableRows().map((order) => order.order_id);
  }

  private canMarkAsReceivedFromBulk(status: string): boolean {
    return ["borrador", "en_transito", "inbound_in_transit"].includes(status);
  }

  private canMarkAsReadyForRouteFromBulk(order: Order): boolean {
    return this.isBulkDispatchStage(order.status) && this.canFinishPackingFromBulk(order);
  }

  private isBulkDispatchStage(status: string): boolean {
    return ["inbound_in_transit", "en_transito", "recibido_qa", "packing", "empaque"].includes(status);
  }

  private canFinishPackingFromBulk(order: Order): boolean {
    if (this.closedPackagesCount(order) <= 0) return false;
    if (this.openPackagesCountForBulk(order) > 0) return false;
    if (this.hasEmptyPackagesForBulk(order)) return false;
    if (this.unpackedPiecesForBulk(order) > 0) return false;
    return true;
  }

  private openPackagesCountForBulk(order: Order): number {
    return (order.packages || []).filter((pkg) => this.packageStatusForBulk(pkg) === "open").length;
  }

  private hasEmptyPackagesForBulk(order: Order): boolean {
    return (order.packages || []).some((pkg) => !this.packageHasItemsForBulk(pkg));
  }

  private unpackedPiecesForBulk(order: Order): number {
    const packedByItem = this.packedQtyByItemForBulk(order);
    return (order.items || [])
      .filter((item) => item.confirmation_state === "confirmed")
      .filter((item) => !["cancelado", "devuelto"].includes(item.state))
      .reduce((sum, item) => {
        const confirmed = this.itemConfirmedQty(item);
        const packed = packedByItem.get(item.item_id) || 0;
        return sum + Math.max(0, confirmed - packed);
      }, 0);
  }

  private packedQtyByItemForBulk(order: Order): Map<string, number> {
    const map = new Map<string, number>();
    for (const pkg of order.packages || []) {
      for (const entry of this.packageItemsForBulk(pkg)) {
        map.set(entry.orderItemId, (map.get(entry.orderItemId) || 0) + entry.qty);
      }
    }
    return map;
  }

  private packageHasItemsForBulk(pkg: Order["packages"][number]): boolean {
    return this.packageItemsForBulk(pkg).some((entry) => entry.qty > 0);
  }

  private packageStatusForBulk(pkg: Order["packages"][number]): "open" | "closed" {
    const status = String((pkg as any).status || "").toLowerCase();
    if (status === "open" || status === "closed") return status;
    const state = String((pkg as any).state || "").toLowerCase();
    if (state === "open") return "open";
    if (state === "closed" || state === "en_ruta" || state === "entregado" || state === "armado") return "closed";
    if ((pkg as any).closed_at) return "closed";
    return "closed";
  }

  private packageItemsForBulk(pkg: Order["packages"][number]): Array<{ orderItemId: string; qty: number }> {
    const raw = (pkg as any).items;
    if (Array.isArray(raw) && raw.length > 0) {
      return raw
        .map((entry: any) => ({
          orderItemId: String(entry.orderItemId || entry.order_item_id || ""),
          qty: Math.max(0, Number(entry.qty || 0)),
        }))
        .filter((entry: { orderItemId: string; qty: number }) => entry.orderItemId && entry.qty > 0);
    }
    return Array.isArray(pkg.item_ids)
      ? pkg.item_ids.map((itemId) => ({ orderItemId: String(itemId || ""), qty: 1 }))
      : [];
  }

  private tableBulkActionLabel(action: TableBulkAction): string {
    switch (action) {
      case "create_bitacora":
        return "Crear bitacora";
      case "create_nota":
        return "Crear nota";
      case "mark_pagado":
        return "Marcar como pagados";
      case "mark_recibido":
        return "Marcar como recibidos";
      case "mark_listo_ruta":
        return "Marcar como listos para ruta";
      default:
        return "Accion";
    }
  }

  private tableBulkCountLabel(count: number, singular: string, plural: string): string {
    const safe = Math.max(0, Math.trunc(count));
    return `${safe} ${safe === 1 ? singular : plural}`;
  }

  private applyRouteColumnFilter(rows: Order[]): Order[] {
    if (this.tableRouteColumnFilterDisabled()) return rows;
    const selected = this.tableRouteSelections();
    if (selected === null) return rows;
    if (selected.length === 0) return [];
    const allowed = new Set(selected);
    return rows.filter((order) => allowed.has(this.tableRouteFilterKey(order.route_id)));
  }

  private applyStatusColumnFilter(rows: Order[]): Order[] {
    const selected = this.tableStatusSelections();
    if (selected === null) return rows;
    if (selected.length === 0) return [];
    const allowed = new Set(selected);
    return rows.filter((order) => allowed.has(this.tableStatusFilterKey(order.status)));
  }

  openTableDatePicker(event: Event): void {
    const target = event.target;
    if (!(target instanceof HTMLInputElement) || target.type !== "date") return;
    this.tryOpenDatePicker(target);
  }

  tableStatusLabel(status: string): string {
    const map: Record<string, string> = {
      borrador: "Capturando pedido",
      confirmando_proveedor: "Confirmando",
      supplier_processing: "En transito",
      inbound_in_transit: "En transito",
      en_transito: "En transito",
      en_empaque: "Empaque",
      recibido_qa: "Empaque",
      packing: "Empaque",
      empaque: "Empaque",
      ready_for_route: "Listo ruta",
      assigned_to_run: "Asignado",
      in_transit: "En ruta",
      en_ruta: "En ruta",
      pago_pendiente: "Pago pend.",
      pagado_parcial: "Pago parcial",
      pagado: "Pagado",
      entregado: "Entregado",
      cancelado: "Cancelado",
    };
    return map[status] ?? status;
  }

  tableStatusClass(status: string): string {
    const map: Record<string, string> = {
      borrador: "trow-status--draft",
      supplier_processing: "trow-status--transit",
      inbound_in_transit: "trow-status--transit",
      en_transito: "trow-status--transit",
      en_empaque: "trow-status--packing",
      recibido_qa: "trow-status--packing",
      packing: "trow-status--packing",
      empaque: "trow-status--packing",
      pago_pendiente: "trow-status--pay",
      pagado_parcial: "trow-status--partial",
      pagado: "trow-status--paid",
      cancelado: "trow-status--cancel",
      en_ruta: "trow-status--route",
      in_transit: "trow-status--route",
      ready_for_route: "trow-status--ready",
      assigned_to_run: "trow-status--ready",
    };
    return map[status] ?? "trow-status--default";
  }

  formatTableDateShort(input: string): string {
    const value = new Date(input);
    if (Number.isNaN(value.getTime())) return "--";
    const day = String(value.getDate()).padStart(2, "0");
    const monthAbbr = ["Ene", "Feb", "Mar", "Abr", "May", "Jun", "Jul", "Ago", "Sep", "Oct", "Nov", "Dic"][value.getMonth()];
    return `${day}-${monthAbbr}`;
  }

  tableOrderClientTotal(order: Order): number {
    const persistedTotal = Number(order.totals?.total_amount ?? 0);
    if (Number.isFinite(persistedTotal) && persistedTotal > 0) return persistedTotal;

    let estimated = 0;
    for (const item of order.items || []) {
      const qtyRaw = Number(item.quantity ?? 0);
      const qty = Number.isFinite(qtyRaw) ? Math.max(0, Math.trunc(qtyRaw)) : 0;
      const unitRaw = Number(item.price_clienta ?? item.price_public ?? 0);
      const unit = Number.isFinite(unitRaw) ? Math.max(0, unitRaw) : 0;
      estimated += qty * unit;
    }
    return Number(estimated.toFixed(2));
  }

  isTableOrderPaid(order: Order): boolean {
    const total = this.tableOrderClientTotal(order);
    if (total <= 0) return false;

    const paid = Number(order.totals?.paid_amount ?? 0);
    const hasPaidInTotals = Number.isFinite(paid) && paid >= total - 0.01;
    if (hasPaidInTotals) return true;

    return ["pagado", "closed"].includes(order.status);
  }

  canBulkCreateNotes = computed(() => this.intentFilter() === "listos_ruta");
  bulkReadyOrders = computed(() => this.filtered().filter((order) => this.isReadyForRoute(order)));
  bulkSelectedCount = computed(() => this.bulkReadyOrders().filter((order) => this.bulkSelected()[order.order_id]).length);

  routeOptions = computed(() => [{ id: "todos", name: "Todas las rutas" }, ...this.routes.routes().map((r) => ({ id: r.route_id, name: r.name }))]);
  orderBusinessOptions = computed(() =>
    this.businessScope.availableBusinessIds().map((id) => ({
      id,
      label: this.businessScope.businessShortLabel(id),
    })),
  );
  showOrderBusinessPicker = computed(() => this.businessScope.scope() === "both" && this.orderBusinessOptions().length > 1);
  customerOptions = computed(() => this.customers.getActive());
  customerSuggestions = computed(() => {
    const term = this.normalizeSearchTerm(this.customerQuery());
    if (term.length < 2) return [];
    return this.customerOptions()
      .filter((c) => {
        const blob = this.normalizeSearchTerm(`${c.first_name} ${c.last_name} ${c.whatsapp}`);
        return blob.includes(term);
      })
      .slice(0, 6);
  });
  allRoutes = computed(() => this.routes.routes());
  selectedCustomer = computed(() => this.customers.getById(this.newCustomerId() || ""));
  canCreateOrder = computed(() => !!this.selectedCustomer());
  inferredRouteId = computed(() => this.selectedCustomer()?.route_id || "sin_ruta");
  inferredRouteName = computed(() => {
    const id = this.inferredRouteId();
    if (!id || id === "sin_ruta") return "Sin ruta asignada";
    return this.routes.getById(id)?.name || "Ruta sin nombre";
  });

  private captureUiStateSnapshot(): PedidosUiStateSnapshot {
    return {
      viewMode: this.viewMode(),
      search: this.search(),
      intentFilter: this.intentFilter(),
      routeFilter: this.routeFilter(),
      tableSortCol: this.tableSortCol(),
      tableSortDir: this.tableSortDir(),
      tableDateFrom: this.tableDateFrom(),
      tableDateTo: this.tableDateTo(),
      tableRouteSelections: this.tableRouteSelections(),
      tableStatusSelections: this.tableStatusSelections(),
    };
  }

  private saveUiStateSnapshot(snapshot: PedidosUiStateSnapshot): void {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(this.uiStateStorageKey, JSON.stringify(snapshot));
    } catch {
      // Ignore storage errors (private mode, quota, blocked storage).
    }
  }

  private restoreUiStateSnapshot(): void {
    if (typeof window === "undefined") {
      this.uiStateHydrated.set(true);
      return;
    }

    let parsed: Partial<PedidosUiStateSnapshot> | null = null;
    try {
      const raw = window.localStorage.getItem(this.uiStateStorageKey);
      if (raw) parsed = JSON.parse(raw) as Partial<PedidosUiStateSnapshot>;
    } catch {
      parsed = null;
    }

    const shouldRestorePrimaryFilters = this.shouldRestorePrimaryFilters();

    if (parsed) {
      if (parsed.viewMode === "cards" || parsed.viewMode === "table") {
        this.viewMode.set(parsed.viewMode);
      }
      if (shouldRestorePrimaryFilters && typeof parsed.search === "string") {
        this.search.set(parsed.search);
      }
      if (this.isIntentFilterValue(parsed.intentFilter)) {
        this.intentFilter.set(parsed.intentFilter);
      }
      if (shouldRestorePrimaryFilters && typeof parsed.routeFilter === "string") {
        this.routeFilter.set(parsed.routeFilter);
      }
      if (this.isTableSortColumnValue(parsed.tableSortCol)) {
        this.tableSortCol.set(parsed.tableSortCol);
      }
      if (parsed.tableSortDir === "asc" || parsed.tableSortDir === "desc") {
        this.tableSortDir.set(parsed.tableSortDir);
      }
      if (this.isDateInputValue(parsed.tableDateFrom)) {
        this.tableDateFrom.set(parsed.tableDateFrom);
      }
      if (this.isDateInputValue(parsed.tableDateTo)) {
        this.tableDateTo.set(parsed.tableDateTo);
      }
      const routeSelections = this.parseSelectionList(parsed.tableRouteSelections);
      if (routeSelections !== undefined) {
        this.tableRouteSelections.set(routeSelections);
      }
      const statusSelections = this.parseSelectionList(parsed.tableStatusSelections);
      if (statusSelections !== undefined) {
        this.tableStatusSelections.set(statusSelections);
      }
    }

    this.uiStateHydrated.set(true);
  }

  private shouldRestorePrimaryFilters(): boolean {
    const historyState = (typeof window !== "undefined" ? window.history.state : null) as Record<string, unknown> | null;
    if (historyState?.["preservePrimaryFilters"] === true) return true;

    const nav = this.router.getCurrentNavigation();
    const preserveByState = nav?.extras?.state?.["preservePrimaryFilters"] === true;
    if (preserveByState) return true;
    const prevUrl = nav?.previousNavigation?.finalUrl?.toString()
      || nav?.previousNavigation?.extractedUrl?.toString()
      || "";
    return prevUrl.startsWith("/main/pedidos");
  }

  private isIntentFilterValue(value: unknown): value is IntentFilter {
    return typeof value === "string" && this.intentsForCount.includes(value as IntentFilter);
  }

  private isTableSortColumnValue(value: unknown): value is TableSortColumn {
    return typeof value === "string"
      && (["updated_at", "created_at", "status", "customer", "route", "items", "total"] as TableSortColumn[]).includes(value as TableSortColumn);
  }

  private isDateInputValue(value: unknown): value is string {
    return typeof value === "string" && (value === "" || /^\d{4}-\d{2}-\d{2}$/.test(value));
  }

  private parseSelectionList(value: unknown): string[] | null | undefined {
    if (value === null) return null;
    if (!Array.isArray(value)) return undefined;
    return [...new Set(value.filter((item): item is string => typeof item === "string"))];
  }

  async ngOnInit() {
    this.restoreUiStateSnapshot();
    try {
      await Promise.all([
        this.orders.loadFromFirestore(),
        this.customers.loadFromFirestore().catch(() => null),
        this.routes.loadFromFirestore().catch(() => null),
      ]);
    } catch (error: any) {
      this.error.set(error?.message || "No se pudieron cargar pedidos");
    }
  }

  ngAfterViewInit(): void {
    this.pillsResizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const row = entry.target as HTMLElement;
        const orderId = row.dataset["orderId"];
        if (!orderId) continue;
        this.recomputePillsForRow(row, orderId);
      }
    });

    this.pillsRows.changes
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(() => this.observePillRows());
    this.observePillRows();

    queueMicrotask(() => this.recomputeAllPills());
  }

  ngOnDestroy(): void {
    this.pillsResizeObserver?.disconnect();
    this.pillsResizeObserver = null;
    if (this.tableBulkProgressHideTimer) {
      clearTimeout(this.tableBulkProgressHideTimer);
      this.tableBulkProgressHideTimer = null;
    }
    if (this.pillMeasureEl) {
      this.pillMeasureEl.remove();
      this.pillMeasureEl = null;
    }
  }

  pickCustomer(id: string) {
    this.newCustomerId.set(id);
    this.customerQuery.set(this.customerName(id));
    this.showCustomerList.set(false);
  }

  closeCustomerListSoon() {
    setTimeout(() => this.showCustomerList.set(false), 120);
  }

  async createOrder() {
    const customer = this.selectedCustomer();
    if (!customer) {
      this.error.set("Selecciona una clienta existente para el pedido");
      return;
    }

    this.creating.set(true);
    try {
      const orderId = await this.orders.createDraft(
        customer.customer_id,
        this.inferredRouteId() || null,
        this.newNotes(),
        this.newBusinessId(),
      );
      this.search.set("");
      this.intentFilter.set("por_confirmar");
      this.routeFilter.set("todos");
      this.newNotes.set("");
      this.customerQuery.set("");
      this.newCustomerId.set("");
      this.router.navigate(["/main/pedidos", orderId]);
    } finally {
      this.creating.set(false);
    }
  }

  orderBusinessLabel(order: Order): string {
    return this.businessScope.businessShortLabel(order.business_id || "bm");
  }

  orderBusinessClass(order: Order): string {
    return this.businessScope.businessClass(order.business_id);
  }

  intentOptions = [
    { id: "por_confirmar" as const, label: "Por confirmar" },
    { id: "en_transito" as const, label: "En transito" },
    { id: "en_empaque" as const, label: "En empaque" },
    { id: "listos_ruta" as const, label: "Listos para ruta" },
    { id: "en_ruta" as const, label: "En ruta" },
    { id: "con_incidencias" as const, label: "Con incidencias" },
    { id: "cobranza_pendiente" as const, label: "Cobranza pendiente" },
    { id: "cerrados" as const, label: "Cerrados" },
  ];

  setIntentFilter(id: IntentFilter) {
    this.intentFilter.set(id);
    this.bulkNotesMessage.set(null);
    if (id !== "listos_ruta") {
      this.cancelBulkNoteMode();
    }
  }

  orderMeta(order: Order): OrderCardMeta {
    const orderId = order.order_id;
    const visibleRaw = this.visiblePillsByOrder()[orderId];
    const visibleCount = typeof visibleRaw === "number" ? visibleRaw : Math.min(3, order.items.length);
    const customerName = this.customerName(order.customer_id);
    const routeName = this.routeName(order.route_id);
    const cached = this.orderMetaCache.get(orderId);
    if (
      cached
      && cached.orderRef === order
      && cached.visibleCount === visibleCount
      && cached.customerName === customerName
      && cached.routeName === routeName
    ) {
      return cached.meta;
    }

    const alerts = this.orderAlerts(order);
    const visibleItems = order.items.slice(0, Math.max(0, visibleCount));
    const meta: OrderCardMeta = {
      customerName,
      routeName,
      primaryAlert: alerts[0] ?? null,
      hiddenAlertsCount: Math.max(0, alerts.length - 1),
      packagesMetaLabel: this.packagesMetaLabel(order),
      updatedAtRelative: this.updatedAtRelative(order.updated_at),
      visibleItems,
      hiddenItemsCount: Math.max(0, order.items.length - visibleItems.length),
      ariaLabel: `Abrir pedido ${order.order_id} de ${customerName}`,
    };

    this.orderMetaCache.set(orderId, {
      orderRef: order,
      visibleCount,
      customerName,
      routeName,
      meta,
    });
    return meta;
  }

  isToday(dateInput: string): boolean {
    const value = new Date(dateInput);
    if (Number.isNaN(value.getTime())) return false;
    const today = new Date();
    return value.getFullYear() === today.getFullYear()
      && value.getMonth() === today.getMonth()
      && value.getDate() === today.getDate();
  }

  matchesIntent(order: Order, intent: IntentFilter): boolean {
    switch (intent) {
      case "hoy":
        return this.isToday(order.updated_at);
      case "por_confirmar":
        return ["borrador", "confirmando_proveedor", "reservado_inventario", "solicitado_proveedor"].includes(order.status);
      case "en_transito":
        return ["supplier_processing", "inbound_in_transit", "en_transito"].includes(order.status);
      case "en_empaque":
        return this.isPackingStage(order);
      case "listos_ruta":
        return this.isReadyForRoute(order);
      case "en_ruta":
        return order.status === "en_ruta";
      case "con_incidencias":
        return this.hasIncidents(order);
      case "cobranza_pendiente":
        return order.status === "pago_pendiente";
      case "cerrados":
        return ["pagado", "entregado", "cancelado", "devuelto"].includes(order.status);
      default:
        return true;
    }
  }

  plannedPackagesCount(order: Order): number | null {
    const planned = order.planned_packages;
    if (planned === null || planned === undefined) return null;
    return Math.max(1, Number(planned));
  }

  closedPackagesCount(order: Order): number {
    return (order.packages || []).filter((pkg) => this.isClosedPackage(pkg)).length;
  }

  deliveredPackagesCount(order: Order): number {
    return (order.packages || []).filter((pkg) => pkg.state === "entregado").length;
  }

  packagesSummary(order: Order): string {
    const planned = this.plannedPackagesCount(order);
    const closed = this.closedPackagesCount(order);
    return planned === null ? `${closed}/-` : `${closed}/${planned}`;
  }

  packagesSummarySafe(order: Order | null): string {
    if (!order) return "0/-";
    return this.packagesSummary(order);
  }

  packagesMetaLabel(order: Order): string {
    const summary = this.packagesSummary(order);
    if (summary === "0/-") return "Sin paquetes";
    if (summary.endsWith("/-")) return summary.replace("/-", "");
    return summary;
  }

  hasIncompletePackages(order: Order): boolean {
    const planned = this.plannedPackagesCount(order);
    if (planned === null) return false;
    if (["cancelado", "devuelto"].includes(order.status)) return false;
    const isReady = this.statusRank(order.status) >= this.statusRank("recibido_qa");
    return isReady && this.closedPackagesCount(order) < planned;
  }

  hasPaymentPending(order: Order): boolean {
    return order.status === "pago_pendiente";
  }

  hasIncidents(order: Order): boolean {
    return (order.open_incidents_count ?? 0) > 0;
  }

  private isClosedPackage(pkg: Order["packages"][number]): boolean {
    const status = String((pkg as any).status || "").toLowerCase();
    const state = String(pkg.state || "").toLowerCase();
    if (status === "closed") return true;
    if ((pkg as any).closed_at) return true;
    return ["armado", "closed", "en_ruta", "entregado"].includes(state);
  }

  private isReadyForRoute(order: Order): boolean {
    if (order.status === "ready_for_route") return true;
    if (order.status === "assigned_to_run") return false;
    if (order.status !== "empaque") return false;
    const planned = this.plannedPackagesCount(order);
    if (planned === null) return false;
    if (this.closedPackagesCount(order) < planned) return false;
    return this.unassignedConfirmedItems(order) === 0;
  }

  private isPackingStage(order: Order): boolean {
    if (order.status === "recibido_qa" || order.status === "packing") return true;
    if (order.status !== "empaque") return false;
    return !this.isReadyForRoute(order);
  }

  incidentsLabel(order: Order): string {
    const count = order.open_incidents_count ?? 0;
    return count === 1 ? "1 incidencia" : `${count} incidencias`;
  }

  private normalizeSearchTerm(value: string): string {
    return String(value || "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .trim();
  }

  private compactSearchValue(value: string): string {
    return this.normalizeSearchTerm(value).replace(/[^a-z0-9]/g, "");
  }

  private matchesSearchTerm(order: Order, term: string): boolean {
    if (!term) return true;
    const searchableParts = [
      order.order_id,
      this.customerName(order.customer_id),
      order.route_id || "",
      order.items.map((i) => i.title).join(" "),
    ];
    const blob = this.normalizeSearchTerm(searchableParts.join(" "));
    if (blob.includes(term)) return true;

    // Also match IDs even when users type without separators (e.g. P2401 vs P-2401).
    const compactTerm = this.compactSearchValue(term);
    if (!compactTerm) return false;
    const compactBlob = this.compactSearchValue(searchableParts.join(" "));
    return compactBlob.includes(compactTerm);
  }

  updatedAtRelative(dateInput: string): string {
    const value = new Date(dateInput);
    if (Number.isNaN(value.getTime())) return "sin fecha";
    const diffMs = Date.now() - value.getTime();
    const diffMin = Math.max(0, Math.floor(diffMs / 60000));
    if (diffMin < 1) return "hace menos de 1 min";
    if (diffMin < 60) return `hace ${diffMin} min`;
    const diffHours = Math.floor(diffMin / 60);
    if (diffHours < 24) return `hace ${diffHours} h`;
    const diffDays = Math.floor(diffHours / 24);
    if (diffDays < 30) return `hace ${diffDays} d`;
    return value.toLocaleDateString("es-MX");
  }

  private toDateInputValue(date: Date): string {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }

  private toLocalDateInputValueFromString(dateInput: string | null | undefined): string | null {
    if (!dateInput) return null;
    const parsed = new Date(dateInput);
    if (Number.isNaN(parsed.getTime())) return null;
    return this.toDateInputValue(parsed);
  }

  private formatTableDateCompact(input: string): string {
    const parts = input.split("-");
    if (parts.length !== 3) return input;
    const year = Number(parts[0]);
    const month = Number(parts[1]);
    const day = Number(parts[2]);
    if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) return input;
    const value = new Date(year, month - 1, day);
    if (
      Number.isNaN(value.getTime())
      || value.getFullYear() !== year
      || value.getMonth() !== month - 1
      || value.getDate() !== day
    ) {
      return input;
    }
    return value.toLocaleDateString("es-MX", {
      day: "2-digit",
      month: "short",
    });
  }

  private tryOpenDatePicker(input: HTMLInputElement): void {
    const dateInput = input as HTMLInputElement & { showPicker?: () => void };
    if (typeof dateInput.showPicker === "function") {
      try {
        dateInput.showPicker();
        return;
      } catch {
        // Fallback to native focus behavior in browsers without showPicker support.
      }
    }
    input.focus();
  }

  statusRank(status: OrderStatus): number {
    const flow: OrderStatus[] = [
      "borrador",
      "confirmando_proveedor",
      "reservado_inventario",
      "solicitado_proveedor",
      "supplier_processing",
      "inbound_in_transit",
      "en_transito",
      "recibido_qa",
      "empaque",
      "en_ruta",
      "entregado",
      "pago_pendiente",
      "pagado",
      "cancelado",
      "devuelto",
    ];
    const idx = flow.indexOf(status);
    return idx === -1 ? 0 : idx;
  }

  needsPlannedPackages(order: Order): boolean {
    const planned = this.plannedPackagesCount(order);
    return planned === null && (order.status === "recibido_qa" || order.status === "empaque");
  }

  openPlannedPackages(order: Order) {
    this.plannedOrder.set(order);
    this.plannedPackagesInput.set(1);
    this.plannedModalOpen.set(true);
  }

  savePlannedPackages() {
    const order = this.plannedOrder();
    if (!order) return;
    const planned = Math.max(1, Number(this.plannedPackagesInput() || 1));
    this.orders.updatePlannedPackages(order.order_id, planned);
    this.plannedModalOpen.set(false);
    this.openActionSheet(order);
  }

  closePlannedPackages() {
    this.plannedModalOpen.set(false);
  }

  isPartialDelivery(order: Order | null): boolean {
    if (!order) return false;
    const planned = this.plannedPackagesCount(order);
    if (planned === null) return false;
    return this.deliveredPackagesCount(order) < planned;
  }

  openActionSheet(order: Order) {
    const action = getPrimaryAction(order);
    if (action.disabled) return;
    if (this.needsPlannedPackages(order)) {
      this.openPlannedPackages(order);
      return;
    }
    this.sheetOrder.set(order);
    this.sheetAction.set(action);
    this.sheetChecklist.set(getActionChecklist(order, action.actionId));
    this.resolveFocus.set(this.focusForAction(order, action.actionId));
    this.partialReason.set("");
    this.partialReasonError.set(null);
    this.actionSheetOpen.set(true);
  }

  closeActionSheet() {
    this.actionSheetOpen.set(false);
  }

  async continuePrimary() {
    const action = this.sheetAction();
    const checklist = this.sheetChecklist();
    const order = this.sheetOrder();
    if (!action || !checklist || !order) return;
    const allowPartial = action.actionId === "register_delivery_payment" && this.isPartialDelivery(order);
    if (checklist.blocking && !allowPartial) return;
    if (action.actionId === "register_delivery_payment" && this.isPartialDelivery(order)) {
      const reason = this.partialReason().trim();
      if (!reason) {
        this.partialReasonError.set("Explica el motivo de la entrega parcial.");
        return;
      }
    }
    this.actionSheetOpen.set(false);
    if (action.actionId === "register_delivery_payment" && this.isPartialDelivery(order)) {
      await this.orders.createIncident(order.order_id, {
        orderId: order.order_id,
        packageId: null,
        itemId: null,
        type: "PARTIAL_DELIVERY",
        title: "Entrega parcial",
        severity: "high",
        reason: this.partialReason().trim(),
        evidenceUrls: [],
        createdBy: "admin",
      });
      const url = this.router.createUrlTree([action.route], {
        queryParams: { partialDeliveryReason: this.partialReason().trim() },
      });
      this.router.navigateByUrl(url);
      return;
    }
    this.router.navigateByUrl(action.route);
  }

  resolveNow() {
    const order = this.sheetOrder();
    const action = this.sheetAction();
    if (!order || !action) return;
    this.actionSheetOpen.set(false);
    this.router.navigate(["/main/pedidos", order.order_id], {
      queryParams: { focus: this.resolveFocus() },
    });
  }

  private missingChecklistReasons(): string[] {
    const checklist = this.sheetChecklist();
    if (!checklist) return [];
    return checklist.items.filter((row) => !row.ok).map((row) => row.text);
  }

  private incidentSeverityForAction(actionId: string, blocking: boolean): IncidentSeverity {
    if (actionId === "register_delivery_payment") return blocking ? "high" : "medium";
    if (actionId === "prepare_dispatch") return blocking ? "medium" : "low";
    return blocking ? "medium" : "low";
  }

  private incidentTypeFromOrder(order: Order, actionId: string): string {
    const planned = this.plannedPackagesCount(order);
    const closed = this.closedPackagesCount(order);
    const delivered = this.deliveredPackagesCount(order);
    const unassigned = this.unassignedConfirmedItems(order);
    if (actionId === "register_delivery_payment" && planned !== null && delivered < planned) {
      return "PARTIAL_DELIVERY";
    }
    if (planned === null || closed < (planned ?? 0)) {
      return "PACKAGE_INCOMPLETE";
    }
    if (unassigned > 0) {
      return "MISSING_ITEMS";
    }
    return "CHECKLIST_BLOCKED";
  }

  private incidentTitleFromType(type: string): string {
    switch (type) {
      case "PARTIAL_DELIVERY":
        return "Entrega parcial";
      case "PACKAGE_INCOMPLETE":
        return "Paquetes incompletos";
      case "MISSING_ITEMS":
        return "Items sin asignar";
      default:
        return "Incidencia por bloqueo";
    }
  }

  private focusForAction(order: Order, actionId: string): "incidents" | "packages" {
    const planned = this.plannedPackagesCount(order);
    const closed = this.closedPackagesCount(order);
    const unassigned = this.unassignedConfirmedItems(order);
    if (actionId === "register_delivery_payment" && this.isPartialDelivery(order)) return "incidents";
    if (actionId === "prepare_dispatch" && (planned === null || closed < (planned ?? 0))) return "packages";
    if (unassigned > 0) return "incidents";
    return "packages";
  }

  private unassignedConfirmedItems(order: Order): number {
    const assigned = new Set<string>();
    for (const pkg of order.packages || []) {
      for (const id of pkg.item_ids || []) assigned.add(id);
    }
    return (order.items || []).filter((item) => {
      const isConfirmed = !["entregado", "pagado", "cancelado", "devuelto"].includes(item.state);
      return isConfirmed && !assigned.has(item.item_id);
    }).length;
  }

  async createIncidentFromSheet() {
    const order = this.sheetOrder();
    const action = this.sheetAction();
    const checklist = this.sheetChecklist();
    if (!order || !action || !checklist) return;
    const missing = this.missingChecklistReasons();
    const reason = action.actionId === "register_delivery_payment" && this.partialReason().trim()
      ? this.partialReason().trim()
      : (missing.length > 0 ? missing.join(" \u00b7 ") : action.label);
    const type = this.incidentTypeFromOrder(order, action.actionId);
    const severity = this.incidentSeverityForAction(action.actionId, checklist.blocking);
    await this.orders.createIncident(order.order_id, {
      orderId: order.order_id,
      packageId: null,
      itemId: null,
      type,
      title: this.incidentTitleFromType(type),
      severity,
      reason,
      evidenceUrls: [],
      createdBy: "admin",
    });
    this.actionSheetOpen.set(false);
  }

  statusLabel(status: OrderStatus): string {
    const map: Record<OrderStatus, string> = {
      borrador: "Capturando pedido",
      confirmando_proveedor: "Confirmando",
      reservado_inventario: "Reservado",
      solicitado_proveedor: "Solicitado",
      supplier_processing: "En transito",
      inbound_in_transit: "En transito",
      en_transito: "En transito",
      packing: "Empacando",
      recibido_qa: "Empaque",
      empaque: "Empaque",
      ready_for_route: "Listo para ruta",
      assigned_to_run: "Asignado a salida",
      in_transit: "En transito",
      en_ruta: "En ruta",
      delivered: "Entregado",
      delivered_partial: "Entrega parcial",
      entregado: "Entregado",
      closed: "Cerrado",
      pago_pendiente: "Pago pendiente",
      pagado_parcial: "Pago parcial",
      pagado: "Pagado",
      cancelado: "Cancelado",
      devuelto: "Devuelto",
    };
    return map[status];
  }

  statusClass(status: OrderStatus): string {
    switch (status) {
      case "borrador":
        return "chip neutral";
      case "reservado_inventario":
      case "confirmando_proveedor":
        return "chip info";
      case "packing":
      case "empaque":
      case "ready_for_route":
      case "assigned_to_run":
      case "in_transit":
      case "en_transito":
      case "inbound_in_transit":
      case "en_ruta":
        return "chip accent";
      case "delivered":
      case "closed":
      case "entregado":
      case "pagado":
        return "chip success";
      case "pago_pendiente":
        return "chip warning";
      default:
        return "chip danger";
    }
  }

  customerName(customerId: string): string {
    const row = this.customers.getById(customerId);
    if (!row) return "Cliente sin nombre";
    return [row.first_name, row.last_name].filter(Boolean).join(" ").trim() || "Cliente sin nombre";
  }

  routeName(routeId: string | null): string {
    if (!routeId || routeId === "sin_ruta") return "Sin ruta";
    return this.routes.getById(routeId)?.name || routeId;
  }

  startBulkNoteMode() {
    if (!this.canBulkCreateNotes()) {
      this.bulkNotesMessage.set("Disponible solo en la vista Listos para ruta.");
      return;
    }
    if (this.bulkReadyOrders().length === 0) {
      this.bulkNotesMessage.set("No hay pedidos listos para ruta para generar nota.");
      return;
    }
    this.bulkSelected.set({});
    this.bulkNoteMode.set(true);
    this.bulkNotesMessage.set("Selecciona los pedidos para generar notas.");
  }

  cancelBulkNoteMode() {
    this.bulkNoteMode.set(false);
    this.bulkSelected.set({});
  }

  onOrderCardActivate(order: Order, event?: Event) {
    if (event instanceof KeyboardEvent && (event.key === " " || event.key === "Spacebar" || event.key === "Enter")) {
      event.preventDefault();
    }
    if (this.bulkNoteMode()) {
      event?.preventDefault();
      event?.stopPropagation();
      if (!this.canSelectForBulkNote(order)) return;
      this.toggleOrderForBulkNote(order.order_id, !this.isSelectedForBulkNote(order.order_id));
      return;
    }
    this.open(order.order_id);
  }

  toggleOrderForBulkNote(orderId: string, checked: boolean) {
    this.bulkSelected.update((current) => ({
      ...current,
      [orderId]: checked,
    }));
  }

  isSelectedForBulkNote(orderId: string): boolean {
    return !!this.bulkSelected()[orderId];
  }

  canSelectForBulkNote(order: Order): boolean {
    return this.canBulkCreateNotes() && this.isReadyForRoute(order);
  }

  async generateBulkNotes() {
    if (!this.canBulkCreateNotes()) {
      this.bulkNotesMessage.set("Filtra primero en Listos para ruta.");
      return;
    }
    const selectedOrders = this.bulkReadyOrders().filter((order) => this.bulkSelected()[order.order_id]);
    if (selectedOrders.length === 0) {
      this.bulkNotesMessage.set("Selecciona al menos un pedido.");
      return;
    }
    if (this.bulkNotesLoading()) return;

    this.bulkNotesLoading.set(true);
    this.bulkNotesMessage.set(null);
    let generated = 0;
    let failed = 0;
    const generatedNoteFiles: SalesNoteFile[] = [];

    for (const order of selectedOrders) {
      try {
        const rows = this.salesNoteRows(order);
        if (rows.length === 0) {
          failed += 1;
          continue;
        }
        const blob = await this.buildSalesNoteImage(order, rows);
        generatedNoteFiles.push({
          fileName: `nota-${order.order_id}-${Date.now()}.png`,
          blob,
        });
        generated += 1;
        await this.orders.logEvent(order.order_id, "SALES_NOTE_GENERATED", "Nota de venta generada (lote)", {
          rows: rows.length,
          total: rows.reduce((sum, row) => sum + row.lineTotal, 0),
          mode: "bulk",
        }).catch(() => null);
        await this.sleep(120);
      } catch (error) {
        failed += 1;
        console.warn("[pedidos] No se pudo generar nota en lote", { orderId: order.order_id, error });
      }
    }

    await this.downloadSalesNotesBundle(generatedNoteFiles, "notas-lote");

    this.bulkNotesLoading.set(false);
    this.cancelBulkNoteMode();
    if (failed === 0) {
      this.bulkNotesMessage.set(`Se generaron ${this.tableBulkCountLabel(generated, "nota", "notas")}.`);
    } else if (generated > 0) {
      this.bulkNotesMessage.set(
        `Se generaron ${this.tableBulkCountLabel(generated, "nota", "notas")}. `
        + `${this.tableBulkCountLabel(failed, "pedido no se pudo procesar", "pedidos no se pudieron procesar")}.`
      );
    } else {
      this.bulkNotesMessage.set("No se pudo generar ninguna nota con la selecciÃ³n actual.");
    }
  }

  open(orderId: string) {
    this.router.navigate(["/main/pedidos", orderId]);
  }

  primaryAction(order: Order): PrimaryAction {
    return getPrimaryAction(order);
  }

  private orderAlerts(order: Order): Array<{ label: string; tone: "danger" | "warning" }> {
    const alerts: Array<{ label: string; tone: "danger" | "warning" }> = [];
    if (this.hasPaymentPending(order)) alerts.push({ label: "$ pendiente", tone: "warning" });

    const incidents = order.open_incidents_count ?? 0;
    if (incidents > 0) {
      alerts.push({ label: this.incidentsLabel(order), tone: "warning" });
    }
    return alerts;
  }

  newDraft() {
    this.createOrder();
  }

  private itemConfirmedQty(item: Order["items"][number]): number {
    if (item.confirmation_state !== "confirmed") return 0;
    const fallback = Math.max(0, Number(item.quantity || 0));
    const raw = Number(item.confirmed_qty);
    if (!Number.isFinite(raw)) return fallback;
    return Math.max(0, Math.min(fallback, Math.trunc(raw)));
  }

  private salesNoteRows(order: Order): SalesNoteRow[] {
    return (order.items || [])
      .filter((item) => !["cancelado", "devuelto"].includes(item.state))
      .map((item) => {
        const qty = this.itemConfirmedQty(item);
        const legacyUnitPrice = (item as any)?.unit_price_clienta ?? (item as any)?.unit_price ?? (item as any)?.unitPrice;
        const unitRaw = item.price_clienta ?? item.price_public ?? legacyUnitPrice ?? 0;
        const unitParsed = Number(typeof unitRaw === "string" ? unitRaw.replace(/,/g, "").trim() : unitRaw);
        const unitPrice = Number.isFinite(unitParsed) && unitParsed > 0 ? Number(unitParsed.toFixed(2)) : 0;
        return {
          rowId: item.item_id || `${order.order_id}-${item.title || "item"}`,
          title: item.title || "Producto",
          variant: item.variant || null,
          color: item.color || null,
          qty,
          unitPrice,
          lineTotal: unitPrice * qty,
          imageUrl: item.image_url || null,
        };
      })
      .filter((row) => row.qty > 0);
  }

  private startTableBulkProgress(label: string, total: number): void {
    if (this.tableBulkProgressHideTimer) {
      clearTimeout(this.tableBulkProgressHideTimer);
      this.tableBulkProgressHideTimer = null;
    }
    this.tableBulkProgressLabel.set(label);
    this.tableBulkProgressTotal.set(Math.max(1, Math.trunc(total)));
    this.tableBulkProgressCurrent.set(0);
    this.tableBulkProgressVisible.set(true);
  }

  private updateTableBulkProgress(current: number): void {
    const total = this.tableBulkProgressTotal();
    if (total <= 0) return;
    this.tableBulkProgressCurrent.set(Math.max(0, Math.min(total, Math.trunc(current))));
  }

  private finishTableBulkProgress(): void {
    const total = this.tableBulkProgressTotal();
    if (total > 0) this.tableBulkProgressCurrent.set(total);
    if (this.tableBulkProgressHideTimer) {
      clearTimeout(this.tableBulkProgressHideTimer);
    }
    this.tableBulkProgressHideTimer = setTimeout(() => {
      this.tableBulkProgressVisible.set(false);
      this.tableBulkProgressLabel.set("");
      this.tableBulkProgressCurrent.set(0);
      this.tableBulkProgressTotal.set(0);
      this.tableBulkProgressHideTimer = null;
    }, 900);
  }

  private async generateRouteBitacoraPdfs(
    orders: Order[],
    config: BitacoraConfig,
  ): Promise<{ generated: number; failed: number; routes: number }> {
    const grouped = new Map<string, { routeName: string; orders: Order[] }>();
    for (const order of orders) {
      const routeKey = order.route_id || "sin_ruta";
      const routeName = this.routeName(order.route_id);
      const current = grouped.get(routeKey);
      if (current) {
        current.orders.push(order);
        continue;
      }
      grouped.set(routeKey, { routeName, orders: [order] });
    }

    const groups = [...grouped.values()].sort((a, b) => a.routeName.localeCompare(b.routeName, "es-MX"));
    const dateStamp = new Date().toISOString().slice(0, 10);
    let generated = 0;
    let failed = 0;
    this.startTableBulkProgress("Generando bitacoras por ruta...", groups.length || 1);

    try {
      for (let idx = 0; idx < groups.length; idx += 1) {
        const group = groups[idx];
        try {
          const blob = await this.buildRouteBitacoraPdf(group.routeName, group.orders, config);
          const fileName = `bitacora-${this.slugifyForFileName(group.routeName)}-${dateStamp}.pdf`;
          this.downloadBlob(blob, fileName);
          generated += 1;
        } catch {
          failed += 1;
        } finally {
          this.updateTableBulkProgress(idx + 1);
        }
      }
    } finally {
      this.finishTableBulkProgress();
    }

    return { generated, failed, routes: groups.length };
  }

  private async buildRouteBitacoraPdf(routeName: string, orders: Order[], config: BitacoraConfig): Promise<Blob> {
    const pdfDoc = await PDFDocument.create();
    const fontRegular = await pdfDoc.embedFont(StandardFonts.Helvetica);
    const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

    const pageWidth = 612;
    const pageHeight = 792;
    const marginX = 36;
    const marginTop = 42;
    const marginBottom = 40;
    const checkboxSize = 10;
    const checkboxX = marginX;
    const indexX = marginX + 18;
    const customerX = marginX + 36;
    const totalColWidth = 96;
    const totalLeftX = (pageWidth - marginX) - totalColWidth;
    const productsColRight = totalLeftX - 10;
    const detailMaxWidth = Math.max(84, productsColRight - customerX - 8);

    let page = pdfDoc.addPage([pageWidth, pageHeight]);
    let y = pageHeight - marginTop;
    let pageNumber = 1;
    let routeGrandTotal = 0;

    const drawRightAlignedText = (value: string, yPos: number, size: number, font: PDFFont, color = rgb(0.11, 0.42, 0.24)): void => {
      const width = font.widthOfTextAtSize(value, size);
      const x = Math.max(marginX, (pageWidth - marginX) - width);
      page.drawText(value, {
        x,
        y: yPos,
        size,
        font,
        color,
      });
    };

    const drawListHeader = (): void => {
      page.drawText("Ent.", {
        x: checkboxX,
        y,
        size: 8.2,
        font: fontRegular,
        color: rgb(0.47, 0.56, 0.67),
      });
      page.drawText("#", {
        x: indexX,
        y,
        size: 8.2,
        font: fontRegular,
        color: rgb(0.47, 0.56, 0.67),
      });
      page.drawText("Clienta", {
        x: customerX,
        y,
        size: 8.8,
        font: fontBold,
        color: rgb(0.34, 0.42, 0.52),
      });
      if (config.includeProductCount) {
        const productsHead = "Productos";
        const productsHeadWidth = fontRegular.widthOfTextAtSize(productsHead, 8.2);
        page.drawText(productsHead, {
          x: productsColRight - productsHeadWidth,
          y,
          size: 8.2,
          font: fontRegular,
          color: rgb(0.47, 0.56, 0.67),
        });
      }
      drawRightAlignedText("Total", y, 8.8, fontBold, rgb(0.34, 0.42, 0.52));
      y -= 8;
      page.drawLine({
        start: { x: marginX, y },
        end: { x: pageWidth - marginX, y },
        thickness: 0.7,
        color: rgb(0.85, 0.89, 0.94),
      });
      y -= 8;
    };

    const drawHeader = (continuation: boolean): void => {
      const title = continuation ? "Bitacora de ruta (continuacion)" : "Bitacora de ruta";
      const dateText = new Date().toLocaleDateString("es-MX", {
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      });
      page.drawText(title, {
        x: marginX,
        y,
        size: 16,
        font: fontBold,
        color: rgb(0.09, 0.18, 0.32),
      });
      y -= 20;
      page.drawText(`Ruta: ${routeName}`, {
        x: marginX,
        y,
        size: 11,
        font: fontBold,
        color: rgb(0.15, 0.28, 0.45),
      });
      y -= 14;
      page.drawText(`Fecha: ${dateText} | Pedidos: ${orders.length} | Pagina: ${pageNumber}`, {
        x: marginX,
        y,
        size: 9.5,
        font: fontRegular,
        color: rgb(0.35, 0.42, 0.52),
      });
      y -= 10;
      page.drawLine({
        start: { x: marginX, y },
        end: { x: pageWidth - marginX, y },
        thickness: 0.8,
        color: rgb(0.82, 0.86, 0.92),
      });
      y -= 12;
      drawListHeader();
    };

    const ensureSpace = (needed: number): void => {
      if (y - needed >= marginBottom) return;
      page = pdfDoc.addPage([pageWidth, pageHeight]);
      pageNumber += 1;
      y = pageHeight - marginTop;
      drawHeader(true);
    };

    drawHeader(false);
    const sortedOrders = [...orders].sort((a, b) =>
      this.customerName(a.customer_id).localeCompare(this.customerName(b.customer_id), "es-MX")
    );

    for (let index = 0; index < sortedOrders.length; index += 1) {
      const order = sortedOrders[index];
      const customer = this.customerName(order.customer_id);
      const customerCompact = this.truncatePdfText(customer, fontBold, 10.2, Math.max(72, productsColRight - customerX - 8));
      const itemsCount = this.routeBitacoraItemsCount(order);
      const productsText = `${itemsCount} producto${itemsCount === 1 ? "" : "s"}`;
      const orderTotal = this.tableOrderClientTotal(order);
      const detailLines: string[] = [];

      if (config.includeCustomerContact) {
        detailLines.push(`WhatsApp: ${this.customerWhatsApp(order.customer_id)}`);
      }
      if (config.includeProductDetail) {
        const detailEntries = this.buildRouteBitacoraDetailEntries(order, config.includeProductPrices);
        if (detailEntries.length > 0) {
          detailLines.push(...this.wrapPdfEntries(detailEntries, fontRegular, 7.6, detailMaxWidth));
        }
      }

      const detailBlockHeight = detailLines.length > 0 ? (detailLines.length * 9) + 3 : 0;
      const rowHeight = 24 + detailBlockHeight;
      routeGrandTotal += orderTotal;

      ensureSpace(rowHeight + 2);
      const rowTop = y;
      const rowBottom = rowTop - rowHeight;
      const textY = rowTop - 16;
      const checkboxY = rowTop - ((24 + checkboxSize) / 2);

      page.drawRectangle({
        x: checkboxX,
        y: checkboxY,
        width: checkboxSize,
        height: checkboxSize,
        borderWidth: 0.8,
        borderColor: rgb(0.72, 0.78, 0.86),
        color: rgb(1, 1, 1),
      });
      page.drawText(String(index + 1), {
        x: indexX,
        y: textY,
        size: 8.6,
        font: fontRegular,
        color: rgb(0.47, 0.56, 0.67),
      });
      page.drawText(customerCompact, {
        x: customerX,
        y: textY,
        size: 10.2,
        font: fontBold,
        color: rgb(0.1, 0.17, 0.27),
      });
      if (config.includeProductCount) {
        const productsWidth = fontRegular.widthOfTextAtSize(productsText, 8.2);
        page.drawText(productsText, {
          x: productsColRight - productsWidth,
          y: textY + 0.6,
          size: 8.2,
          font: fontRegular,
          color: rgb(0.52, 0.59, 0.69),
        });
      }
      drawRightAlignedText(this.formatCurrency(orderTotal), textY, 10, fontBold);

      if (detailLines.length > 0) {
        let detailY = textY - 9;
        for (const line of detailLines) {
          page.drawText(this.truncatePdfText(line, fontRegular, 7.6, detailMaxWidth), {
            x: customerX + 2,
            y: detailY,
            size: 7.6,
            font: fontRegular,
            color: rgb(0.46, 0.54, 0.64),
          });
          detailY -= 9;
        }
      }

      page.drawLine({
        start: { x: marginX, y: rowBottom },
        end: { x: pageWidth - marginX, y: rowBottom },
        thickness: 0.6,
        color: rgb(0.9, 0.92, 0.95),
      });
      y = rowBottom;
    }

    ensureSpace(34);
    page.drawLine({
      start: { x: marginX, y },
      end: { x: pageWidth - marginX, y },
      thickness: 0.9,
      color: rgb(0.78, 0.83, 0.9),
    });
    y -= 18;
    drawRightAlignedText(`Total: ${this.formatCurrency(routeGrandTotal)}`, y, 13, fontBold, rgb(0.08, 0.35, 0.2));

    const bytes = await pdfDoc.save();
    const safeBytes = new Uint8Array(bytes);
    return new Blob([safeBytes], { type: "application/pdf" });
  }

  private customerWhatsApp(customerId: string): string {
    const value = (this.customers.getById(customerId)?.whatsapp || "").trim();
    return value || "sin dato";
  }

  private buildRouteBitacoraDetailEntries(order: Order, includePrices: boolean): string[] {
    const chunks: string[] = [];
    for (const item of order.items || []) {
      if (["cancelado", "devuelto"].includes(item.state)) continue;
      const qtyRaw = Number(item.quantity ?? 0);
      const qty = Number.isFinite(qtyRaw) && qtyRaw > 0 ? Math.max(1, Math.trunc(qtyRaw)) : 1;
      const title = (item.title || "Producto sin nombre").trim();
      const base = `${qty}x ${title}`;
      if (includePrices) {
        const unitRaw = Number(item.price_clienta ?? item.price_public ?? 0);
        const unit = Number.isFinite(unitRaw) && unitRaw > 0 ? unitRaw : 0;
        chunks.push(unit > 0 ? `${base} (${this.formatCurrency(unit)} c/u)` : base);
      } else {
        chunks.push(base);
      }
    }
    return chunks;
  }

  private wrapPdfEntries(entries: string[], font: PDFFont, size: number, maxWidth: number): string[] {
    const normalizedEntries = entries.map((entry) => entry.trim()).filter(Boolean);
    if (normalizedEntries.length === 0) return [];
    const lines: string[] = [];
    let current = "";
    for (const entry of normalizedEntries) {
      const candidate = current ? `${current}, ${entry}` : entry;
      if (font.widthOfTextAtSize(candidate, size) <= maxWidth) {
        current = candidate;
        continue;
      }

      if (!current) {
        lines.push(this.truncatePdfText(entry, font, size, maxWidth));
      } else {
        lines.push(current);
        if (font.widthOfTextAtSize(entry, size) <= maxWidth) {
          current = entry;
        } else {
          lines.push(this.truncatePdfText(entry, font, size, maxWidth));
          current = "";
        }
      }
    }

    if (current) {
      lines.push(current);
    }
    return lines;
  }

  private routeBitacoraItemsCount(order: Order): number {
    let total = 0;
    for (const item of order.items || []) {
      if (["cancelado", "devuelto"].includes(item.state)) continue;
      const qtyRaw = Number(item.quantity ?? 0);
      const qty = Number.isFinite(qtyRaw) && qtyRaw > 0 ? Math.max(1, Math.trunc(qtyRaw)) : 1;
      total += qty;
    }
    return total;
  }

  private truncatePdfText(value: string, font: PDFFont, size: number, maxWidth: number): string {
    const normalized = (value || "").trim();
    if (!normalized) return "";
    if (font.widthOfTextAtSize(normalized, size) <= maxWidth) return normalized;
    let current = normalized;
    while (current.length > 0 && font.widthOfTextAtSize(`${current}...`, size) > maxWidth) {
      current = current.slice(0, -1);
    }
    return current ? `${current}...` : "...";
  }

  private slugifyForFileName(value: string): string {
    const base = String(value || "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
    return base || "sin-ruta";
  }

  private async buildSalesNoteImage(order: Order, rows: SalesNoteRow[]): Promise<Blob> {
    const subtotal = rows.reduce((sum, row) => sum + row.lineTotal, 0);
    const discount = Math.min(subtotal, this.orderDiscountAmount(order));
    const totalAmount = Math.max(0, subtotal - discount);
    const balanceDue = this.salesNoteBalanceDue(order, totalAmount);
    return this.salesNoteRender.buildSalesNoteImage({
      orderId: order.order_id,
      customerName: this.customerName(order.customer_id),
      rows,
      discountAmount: discount,
      balanceDue,
    });
  }

  private orderDiscountAmount(order: Order | null): number {
    const value = Number(order?.totals?.discount_amount ?? 0);
    if (!Number.isFinite(value) || value <= 0) return 0;
    return Number(value.toFixed(2));
  }

  private salesNoteBalanceDue(order: Order, totalAmount: number): number {
    const safeTotal = Number(Math.max(0, Number(totalAmount || 0)).toFixed(2));
    const reportedBalance = Number(order.totals?.balance_due ?? 0);
    if (Number.isFinite(reportedBalance) && reportedBalance > 0) {
      return Number(reportedBalance.toFixed(2));
    }
    const paidRaw = Number(order.totals?.paid_amount ?? 0);
    const paidAmount = Number.isFinite(paidRaw) ? Math.max(0, paidRaw) : 0;
    const computedBalance = Number(Math.max(0, safeTotal - paidAmount).toFixed(2));
    if (computedBalance <= 0 && safeTotal > 0) {
      return safeTotal;
    }
    return computedBalance;
  }

  private formatCurrency(value: number): string {
    return new Intl.NumberFormat("es-MX", {
      style: "currency",
      currency: "MXN",
      maximumFractionDigits: 2,
    }).format(Number(value || 0));
  }

  private async downloadSalesNotesBundle(files: SalesNoteFile[], zipLabel: string): Promise<void> {
    if (files.length <= 0) return;
    if (files.length === 1) {
      const only = files[0];
      this.downloadBlob(only.blob, only.fileName);
      return;
    }

    try {
      const zip = new JSZip();
      for (const file of files) {
        zip.file(file.fileName, file.blob);
      }
      const zipBlob = await zip.generateAsync({
        type: "blob",
        compression: "DEFLATE",
        compressionOptions: { level: 6 },
      });
      this.downloadBlob(zipBlob, `${zipLabel}-${Date.now()}.zip`);
    } catch (error) {
      console.warn("[pedidos] No se pudo generar zip de notas, se descargaran por separado", error);
      for (const file of files) {
        this.downloadBlob(file.blob, file.fileName);
      }
    }
  }

  private downloadBlob(blob: Blob, fileName: string) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = fileName;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  }

  private async sleep(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, Math.trunc(ms))));
  }

  private observePillRows() {
    if (!this.pillsResizeObserver) return;
    this.pillsResizeObserver.disconnect();
    for (const rowRef of this.pillsRows.toArray()) {
      const row = rowRef.nativeElement;
      const orderId = row.dataset["orderId"];
      if (!orderId) continue;
      this.pillsResizeObserver.observe(row);
      this.recomputePillsForRow(row, orderId);
    }
  }

  private recomputeAllPills() {
    for (const rowRef of this.pillsRows?.toArray() || []) {
      const row = rowRef.nativeElement;
      const orderId = row.dataset["orderId"];
      if (!orderId) continue;
      this.recomputePillsForRow(row, orderId);
    }
  }

  private recomputePillsForRow(row: HTMLElement, orderId: string) {
    const order = this.filteredById().get(orderId);
    if (!order) return;

    const available = row.clientWidth;
    if (!available || order.items.length === 0) {
      this.visiblePillsByOrder.update((map) => (map[orderId] === 0 ? map : { ...map, [orderId]: 0 }));
      return;
    }

    const styles = getComputedStyle(row);
    const gap = Number.parseFloat(styles.columnGap || styles.gap || "5") || 5;
    const maxChipWidth = Math.max(90, Math.floor(available * 0.58));

    let visible = 0;
    let used = 0;
    for (let i = 0; i < order.items.length; i += 1) {
      const itemWidth = Math.min(this.measurePillWidth(order.items[i].title, false), maxChipWidth);
      const nextUsed = used + (visible > 0 ? gap : 0) + itemWidth;
      const remaining = order.items.length - (i + 1);
      let reserveForMore = 0;
      if (remaining > 0) {
        const moreWidth = this.measurePillWidth(`+${remaining}`, true);
        reserveForMore = (visible + 1 > 0 ? gap : 0) + moreWidth;
      }
      if (nextUsed + reserveForMore <= available) {
        used = nextUsed;
        visible += 1;
      } else {
        break;
      }
    }

    if (visible === 0) visible = 1;
    this.visiblePillsByOrder.update((map) => (map[orderId] === visible ? map : { ...map, [orderId]: visible }));
  }

  private measurePillWidth(text: string, isMore: boolean): number {
    if (!this.pillMeasureEl) {
      const node = document.createElement("span");
      node.className = "pill pill-measure";
      document.body.appendChild(node);
      this.pillMeasureEl = node;
    }
    this.pillMeasureEl.className = isMore ? "pill more pill-measure" : "pill pill-measure";
    this.pillMeasureEl.textContent = text;
    return Math.ceil(this.pillMeasureEl.getBoundingClientRect().width);
  }
}


