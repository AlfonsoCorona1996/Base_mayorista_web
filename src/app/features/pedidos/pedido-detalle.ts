import { Component, ElementRef, HostListener, OnDestroy, OnInit, ViewChild, computed, inject, signal, ChangeDetectionStrategy, DestroyRef } from "@angular/core";
import { DatePipe, DecimalPipe, UpperCasePipe } from "@angular/common";
import { FormsModule } from "@angular/forms";
import { ActivatedRoute, Router, RouterLink } from "@angular/router";
import { takeUntilDestroyed } from "@angular/core/rxjs-interop";
import { lastValueFrom } from "rxjs";
import { collection, getDocs, limit, orderBy, query } from "firebase/firestore";
import { getBlob, ref as storageRef } from "firebase/storage";
import { PDFDocument, PDFFont, PDFPage, StandardFonts, rgb } from "pdf-lib";
import * as QRCode from "qrcode";
import { CustomersService } from "../../core/customers.service";
import { SuppliersService } from "../../core/suppliers.service";
import { OrdersService, Order, OrderEvent, OrderItem, OrderItemState, OrderStatus, PackageRecord, Incident, IncidentSeverity } from "../../core/orders.service";
import { RoutesService } from "../../core/routes.service";
import { LocalitiesService } from "../../core/localities.service";
import { InventoryService, InventoryItem } from "../../core/inventory.service";
import { NormalizedListingsService, NormalizedListingDoc } from "../../core/normalized-listings.service";
import { SupplierOperationsService } from "../../core/supplier-operations.service";
import { ManualProductHistoryService, ManualProductEntry } from "../../core/manual-product-history.service";
import { UserAdminApiService } from "../../services/user-admin-api.service";
import { FIRESTORE, STORAGE } from "../../core/firebase.providers";
import { ActivityLogComponent } from "../../shared/components/activity-log/activity-log.component";
import { AuthzService } from "../../core/authz.service";
import { DispatchOrderRow, RouteRunDoc, RouteRunsService } from "../../services/route-runs.service";

type EstadoConfirmacion = "pendiente" | "confirmado" | "sin_stock";

type ProductCountsVm = {
  total: number;
  outOfStock: number;
  confirmed: number;
  pending: number;
  hasPending: boolean;
  canMagicConfirm: boolean;
  insufficient: number;
};

type ProductCardVm = {
  item: OrderItem;
  cardId: string;
  imageUrl: string | null;
  isConfirmed: boolean;
  isOutOfStock: boolean;
  hasPartial: boolean;
  hasInsufficientStock: boolean;
  confirmedQty: number;
  draftConfirmedQty: number;
  quickConfirming: boolean;
  showSupplierReceive: boolean;
  itemActionLoading: boolean;
};

type PackingRowVm = {
  item: OrderItem;
  qty: number;
  imageUrl: string | null;
  initials: string;
};

type PackingBoxVm = {
  pkg: PackageRecord;
  boxNumber: number;
  title: string;
  label: string;
  rows: PackingRowVm[];
  isActive: boolean;
  isMenuOpen: boolean;
  isMoveMode: boolean;
  isExpanded: boolean;
};

type PackingVm = {
  openBoxes: PackingBoxVm[];
  closedBoxes: PackingBoxVm[];
  unpackedRows: PackingRowVm[];
  unpackedCount: number;
  packedCount: number;
  confirmedPieces: number;
  progressPercent: number;
  canDispatch: boolean;
  canStartPacking: boolean;
  packBlockedCount: number;
  activeOpenBoxNumber: number | null;
  openBoxesCount: number;
  closedBoxesCount: number;
  totalBoxes: number;
};

type SupplierGroupVm = {
  supplierId: string | null;
  displayName: string;
  confirmedCount: number;
  outOfStockCount: number;
  pendingCount: number;
};

type SalesNoteRowVm = {
  item: OrderItem;
  qty: number;
  unitPrice: number;
  lineTotal: number;
  imageUrl: string | null;
};

type OrderViewVm = {
  customerName: string;
  routeName: string;
  statusLabel: string;
  phase: { actionId: string; label: string } | null;
  isPackingWorkflowPhase: boolean;
  canCreatePackages: boolean;
  canEditItems: boolean;
  canAddProducts: boolean;
  canViewFinancialSummary: boolean;
  orderBalanceDue: number;
  totals: { totalVenta: number; totalClienta: number; totalCosto: number; ganancia: number };
  totalItems: number;
  outOfStockItems: number;
  confirmedItems: number;
  pendingConfirmationItems: number;
  hasPendingItems: boolean;
  canMagicConfirm: boolean;
  insufficientItemsCount: number;
  shouldShowStockFab: boolean;
  totalPieces: number;
  confirmedPieces: number;
  outOfStockPieces: number;
  pendingPieces: number;
  resolvedPieces: number;
  confirmedPiecesPercent: number;
  allItemsResolved: boolean;
  confirmExistencesActionLabel: string;
  closedPackagesCount: number;
  packingBoxesCount: number;
  packedCount: number;
  unpackedCount: number;
  openBoxesCount: number;
  canDispatch: boolean;
  canStartPacking: boolean;
  packBlockedCount: number;
  packingProgressPercent: number;
  supplierTransitCandidatesCount: number;
};

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  standalone: true,
  selector: "app-pedido-detalle",
  imports: [FormsModule, RouterLink, DatePipe, DecimalPipe, UpperCasePipe, ActivityLogComponent],
  templateUrl: "./pedido-detalle.html",
  styleUrls: ["./pedido-detalle.css"],
})
export default class PedidoDetallePage implements OnInit, OnDestroy {
  private route = inject(ActivatedRoute);
  private router = inject(Router);
  private orders = inject(OrdersService);
  private customers = inject(CustomersService);
  private suppliers = inject(SuppliersService);
  private rutas = inject(RoutesService);
  private localities = inject(LocalitiesService);
  private inventory = inject(InventoryService);
  private catalog = inject(NormalizedListingsService);
  private supplierOperations = inject(SupplierOperationsService);
  readonly manualHistory = inject(ManualProductHistoryService);
  private authz = inject(AuthzService);
  private routeRuns = inject(RouteRunsService);
  private destroyRef = inject(DestroyRef);
  private api = inject(UserAdminApiService);

  @ViewChild("incidentsSection") incidentsSection?: ElementRef<HTMLElement>;
  @ViewChild("packagesSection") packagesSection?: ElementRef<HTMLElement>;
  @ViewChild("timelineSection") timelineSection?: ElementRef<HTMLElement>;
  @ViewChild("productSearchInput") productSearchInput?: ElementRef<HTMLInputElement>;
  @ViewChild("pageHead") pageHead?: ElementRef<HTMLElement>;
  private readonly onAnyScroll = () => {
    const scrollingEl = document.scrollingElement as HTMLElement | null;
    const scrollTop = Math.max(
      window.scrollY || 0,
      scrollingEl?.scrollTop || 0,
      document.documentElement.scrollTop || 0,
      document.body.scrollTop || 0,
    );
    this.updateStickyByScroll(scrollTop);
  };
  readonly skeletonRows = [1, 2, 3, 4] as const;

  orderId = signal<string>("");
  error = signal<string | null>(null);
  initialHydration = signal(true);
  private lastInventoryBlockedAlertAt = 0;

  order = computed<Order | null>(() => this.orders.getById(this.orderId()));
  incidents = signal<Incident[]>([]);
  openIncidents = computed(() => this.incidents().filter((inc) => inc.status === "open"));
  resolvedIncidents = computed(() => this.incidents().filter((inc) => inc.status === "resolved"));
  events = signal<OrderEvent[]>([]);
  eventsCursor = signal<any>(null);
  eventsLoading = signal(false);
  eventsHasMore = signal(true);
  confirmQtyDraft = signal<Record<string, number>>({});
  debugMode = signal(false);
  userRole = signal("admin");
  copiedOrderId = signal(false);
  actionToast = signal<string | null>(null);
  popupAlertOpen = signal(false);
  popupAlertTitle = signal("Aviso");
  popupAlertMessage = signal("");
  popupConfirmOpen = signal(false);
  popupConfirmTitle = signal("Confirmar accion");
  popupConfirmMessage = signal("");
  popupConfirmConfirmLabel = signal("Aceptar");
  popupConfirmCancelLabel = signal("Cancelar");
  popupConfirmDanger = signal(false);
  lateAddNoteModalOpen = signal(false);
  lateAddNoteTitle = signal("Alta fuera de flujo");
  lateAddNoteMessage = signal("");
  lateAddNoteValue = signal("");
  lateAddNoteError = signal<string | null>(null);
  showStickyFooter = signal(false);
  showStickyHeader = signal(false);
  productStockFilter = signal<"all" | "out_of_stock" | "confirmed" | "pending">("all");
  showStockFab = signal(false);
  quickConfirming = signal<Record<string, boolean>>({});
  itemActionLoading = signal<Record<string, boolean>>({});
  imagePreviewUrl = signal<string | null>(null);
  imagePreviewLoading = signal(false);
  openProductMenuId = signal<string | null>(null);
  generatingSalesNote = signal(false);
  sendingWaNote       = signal(false);
  waNoteSent          = signal<{ ok: boolean; msg?: string } | null>(null);

  incidentModalOpen = signal(false);
  incidentType = signal("GENERAL");
  incidentTypeOptions = ["GENERAL", "STOCK", "CALIDAD", "LOGISTICA", "PAGO", "ENTREGA", "SISTEMA"] as const;
  incidentSeverity = signal<IncidentSeverity>("medium");
  incidentTitle = signal("");
  incidentReason = signal("");
  incidentAssignee = signal("");
  incidentSaving = signal(false);
  showResolvedIncidents = signal(false);

  resolveModalOpen = signal(false);
  resolveNote = signal("");
  resolveTarget = signal<Incident | null>(null);
  assignModalOpen = signal(false);
  assignTarget = signal<Incident | null>(null);

  uploadingEvidence = signal<Record<string, boolean>>({});
  uploadingItemImage = signal<Record<string, boolean>>({});

  plannedModalOpen = signal(false);
  plannedPackagesInput = signal(1);
  actionModalOpen = signal(false);
  actionContext = signal<{ actionId: string; label: string } | null>(null);
  actionError = signal<string | null>(null);
  actionSaving = signal(false);
  transitConfirmOpen = signal(false);
  readyForRouteSheetOpen = signal(false);
  readyForRouteRun = signal<RouteRunDoc | null>(null);
  readyForRouteLoading = signal(false);
  readyForRouteError = signal<string | null>(null);
  lateChangeApproved = signal(false);
  packingBusy = signal(false);
  activeOpenBoxId = signal<string | null>(null);
  openBoxMenuId = signal<string | null>(null);
  moveModeBoxId = signal<string | null>(null);
  deletePackageConfirmOpen = signal(false);
  deletePackageTargetId = signal<string | null>(null);
  createBoxConfirmOpen = signal(false);
  pendingAddItemId = signal<string | null>(null);
  qtyPickerOpen = signal(false);
  qtyPickerItemId = signal<string | null>(null);
  qtyPickerItemTitle = signal("");
  qtyPickerMax = signal(1);
  qtyPickerValue = signal(1);
  moveSheetOpen = signal(false);
  moveSheetPackageId = signal<string | null>(null);
  moveSheetItemId = signal<string | null>(null);
  moveSheetQty = signal(1);
  expandedClosedBoxes = signal<Record<string, boolean>>({});
  supplierEta = signal("");
  // ── Cierre de pedido / Registro de pago ──────────────────────────────────
  paymentModalOpen = signal(false);
  paymentAmount = signal("");
  paymentSaving = signal(false);
  paymentError = signal<string | null>(null);
  // ─────────────────────────────────────────────────────────────────────────

  addItemModalOpen = signal(false);
  addItemMode = signal<"add" | "convert" | "edit">("add");
  convertTargetItemId = signal<string | null>(null);
  editTargetItemId = signal<string | null>(null);
  newItemSupplierId = signal<string | null>(null);
  newItemProductId = signal<string | null>(null);
  selectedPreviewHasColorImage = signal(true);

  pendingItems = computed(() => (this.order()?.items || []).filter((item) => item.state !== "entregado" && item.state !== "pagado"));
  totals = computed(() => {
    const items = this.order()?.items || [];
    let totalVenta = 0;
    let totalClienta = 0;
    let totalCosto = 0;
    for (const item of items) {
      const qty = item.confirmation_state === "confirmed" ? this.confirmedQty(item) : 0;
      const priceVenta = item.price_public ?? item.price_clienta ?? 0;
      const priceClienta = item.price_clienta ?? item.price_public ?? 0;
      const priceCosto = item.price_cost ?? 0;
      totalVenta += priceVenta * qty;
      totalClienta += priceClienta * qty;
      totalCosto += priceCosto * qty;
    }
    const ganancia = totalClienta - totalCosto;
    return {
      totalVenta,
      totalClienta,
      totalCosto,
      ganancia,
    };
  });

  newItemTitle = signal("");
  newItemSearch = signal("");
  newItemSource = signal<"catalogo" | "inventario" | "manual">("catalogo");

  // ── Historial / autocomplete de productos manuales ──────────────────
  manualSuggestionsOpen = signal(false);
  readonly manualSuggestions = computed<ManualProductEntry[]>(() => {
    if (!this.isManualSource()) return [];
    return this.manualHistory.search(this.newItemTitle());
  });
  newItemVariant = signal("");
  newItemColor = signal("");
  newItemInventoryId = signal<string | null>(null);
  newItemQty = signal(1);
  newItemPricePublic = signal<number | null>(null);
  newItemPriceCost = signal<number | null>(null);
  newItemPriceClienta = signal<number | null>(null);
  newItemDiscount = signal<number | null>(null);
  priceInputFocused = signal<"final" | "clienta" | "costo" | null>(null);
  priceInputDraft = signal<{ final: string; clienta: string; costo: string }>({
    final: "",
    clienta: "",
    costo: "",
  });
  supplierDiscountPct = signal<number | null>(null);
  supplierDiscountLabel = signal<string | null>(null);
  selectedPreview = signal<{ title: string; variant: string; color: string; image: string | null; source: string } | null>(null);
  selectedCatalogDoc = signal<NormalizedListingDoc | null>(null);
  readonly isManualSource = computed(() => this.newItemSource() === "manual");
  readonly isConvertMode = computed(() => this.addItemMode() === "convert");
  readonly isEditMode = computed(() => this.addItemMode() === "edit");
  readonly convertTargetItem = computed(() => {
    const id = this.convertTargetItemId();
    if (!id) return null;
    return (this.order()?.items || []).find((item) => item.item_id === id) || null;
  });
  readonly editTargetItem = computed(() => {
    const id = this.editTargetItemId();
    if (!id) return null;
    return (this.order()?.items || []).find((item) => item.item_id === id) || null;
  });
  inventoryLoaded = signal(false);
  catalogLoaded = signal(false);
  showProductList = signal(false);
  private actionToastTimer: ReturnType<typeof setTimeout> | null = null;
  private popupAlertQueue: Array<{ title: string; message: string; resolve: () => void }> = [];
  private popupAlertResolver: (() => void) | null = null;
  private popupConfirmQueue: Array<{
    title: string;
    message: string;
    confirmLabel: string;
    cancelLabel: string;
    danger: boolean;
    resolve: (confirmed: boolean) => void;
  }> = [];
  private popupConfirmResolver: ((confirmed: boolean) => void) | null = null;
  private lateAddNoteResolver: ((note: string | null) => void) | null = null;
  suppressProductBlur = signal(false);
  lockItemFields = signal(false);
  catalogVariantOptions = signal<string[]>([]);
  catalogColorOptions = signal<string[]>([]);
  assigneeOptions = signal<string[]>([]);
  supplierOptions = computed(() => this.suppliers.getActive());
  inventoryById = computed(() => {
    const map = new Map<string, InventoryItem>();
    for (const row of this.inventory.items()) map.set(row.inventory_id, row);
    return map;
  });
  private itemImageByItemId = computed(() => {
    const map = new Map<string, string | null>();
    const currentOrder = this.order();
    if (!currentOrder) return map;
    for (const item of currentOrder.items || []) {
      map.set(item.item_id, this.resolveItemImage(item));
    }
    return map;
  });

  inventorySuggestions = computed(() => {
    if (this.newItemSource() !== "inventario") return [];
    const term = this.newItemSearch().trim().toLowerCase();
    if (term.length < 2) return [];
    return this.inventory.items()
      .filter((item) => {
        const blob = [item.title, item.color_name || "", item.variant_name || "", item.size_label || ""]
          .join(" ")
          .toLowerCase();
        return blob.includes(term);
      })
      .slice(0, 6);
  });
  catalogSuggestions = computed(() => {
    if (this.newItemSource() !== "catalogo") return [];
    const term = this.newItemSearch().trim().toLowerCase();
    if (term.length < 2) return [];
    const matches: { doc: NormalizedListingDoc; variant: any; color: string; image: string | null }[] = [];
    for (const doc of this.catalogRows()) {
      const listing: any = doc.listing || { items: [] };
      const title = (listing.title || "").toLowerCase();
      const cat = (listing.category_hint || "").toLowerCase();
      const variants = listing.items || [];
      for (const v of variants) {
        const colors = this.getVariantColors(v);
        const blob = [title, cat, v.variant_name || "", colors.join(" ")].join(" ").toLowerCase();
        if (!blob.includes(term)) continue;
        const colorHit = colors.find((c) => c.toLowerCase().includes(term)) || colors[0] || "";
        const colorImage = this.resolveColorImage(doc, colorHit);
        const image = colorImage || v?.image_url || doc.cover_images?.[0] || doc.preview_image_url || null;
        matches.push({ doc, variant: v, color: colorHit, image });
        break; // first variant hit is enough per doc for now
      }
    }
    return matches.slice(0, 6);
  });

  private catalogRows = signal<NormalizedListingDoc[]>([]);
  private catalogById = computed(() => {
    const map = new Map<string, NormalizedListingDoc>();
    for (const doc of this.catalogRows()) map.set(doc.normalized_id, doc);
    return map;
  });

  readonly productCountsVm = computed<ProductCountsVm>(() => {
    const currentOrder = this.order();
    if (!currentOrder) {
      return {
        total: 0,
        outOfStock: 0,
        confirmed: 0,
        pending: 0,
        hasPending: false,
        canMagicConfirm: false,
        insufficient: 0,
      };
    }
    let outOfStock = 0;
    let confirmed = 0;
    let pending = 0;
    let insufficient = 0;
    for (const item of currentOrder.items || []) {
      const state = this.estado_confirmacion(item);
      if (state === "sin_stock") outOfStock += 1;
      else if (state === "confirmado") confirmed += 1;
      else pending += 1;
      if (this.hasInsufficientStock(item) || state === "sin_stock") insufficient += 1;
    }
    return {
      total: (currentOrder.items || []).length,
      outOfStock,
      confirmed,
      pending,
      hasPending: pending > 0,
      canMagicConfirm: this.canMagicConfirm(currentOrder),
      insufficient,
    };
  });

  readonly visibleProductCardsVm = computed<ProductCardVm[]>(() => {
    const currentOrder = this.order();
    if (!currentOrder) return [];
    const filter = this.productStockFilter();
    const isConfirmPhase = this.isConfirmItemsPhase(currentOrder);
    const quickMap = this.quickConfirming();
    const loadingMap = this.itemActionLoading();
    const rows: ProductCardVm[] = [];

    for (const item of currentOrder.items || []) {
      const state = this.estado_confirmacion(item);
      const isConfirmed = state === "confirmado";
      const isOutOfStock = state === "sin_stock";
      const isPending = state === "pendiente";
      if (filter === "out_of_stock" && !isOutOfStock) continue;
      if (filter === "confirmed" && !isConfirmed) continue;
      if (filter === "pending" && !isPending) continue;

      rows.push({
        item,
        cardId: `product-card-${item.item_id}`,
        imageUrl: this.itemImage(item),
        isConfirmed,
        isOutOfStock,
        hasPartial: isConfirmed && this.hasPartialConfirmation(item),
        hasInsufficientStock: this.hasInsufficientStock(item),
        confirmedQty: this.confirmedQty(item),
        draftConfirmedQty: this.getCardDraftConfirmedQty(item),
        quickConfirming: !!quickMap[item.item_id],
        showSupplierReceive: !isConfirmPhase && isConfirmed && this.isSupplierManagedItem(item) && !this.isSupplierItemReceived(currentOrder, item),
        itemActionLoading: !!loadingMap[item.item_id],
      });
    }
    return rows;
  });

  readonly supplierGroupsVm = computed<SupplierGroupVm[]>(() => {
    const currentOrder = this.order();
    if (!currentOrder || (currentOrder.items || []).length === 0) return [];
    const groups = this.groupedItemsBySupplier(currentOrder);
    return groups.map((group) => ({
      supplierId: group.supplierId,
      displayName: this.groupDisplayName(group),
      confirmedCount: this.groupConfirmedCount(group.items),
      outOfStockCount: this.groupOutOfStockCount(group.items),
      pendingCount: this.groupPendingCount(group.items),
    }));
  });

  readonly packingVm = computed<PackingVm | null>(() => {
    const currentOrder = this.order();
    if (!currentOrder) return null;
    const allPackages = currentOrder.packages || [];
    const orderedByCreate = [...allPackages].sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
    const totalBoxes = orderedByCreate.length;
    const boxNumberById = new Map<string, number>();
    orderedByCreate.forEach((pkg, index) => boxNumberById.set(pkg.package_id, index + 1));
    const byItemId = new Map((currentOrder.items || []).map((item) => [item.item_id, item]));
    const activeId = this.activeOpenBoxId();
    const menuId = this.openBoxMenuId();
    const moveModeId = this.moveModeBoxId();
    const expandedMap = this.expandedClosedBoxes();

    const rowsForPackage = (pkg: PackageRecord): PackingRowVm[] =>
      this.packageItems(pkg)
        .map((entry) => {
          const item = byItemId.get(entry.orderItemId);
          if (!item || entry.qty <= 0) return null;
          return {
            item,
            qty: entry.qty,
            imageUrl: this.itemImage(item),
            initials: this.itemInitials(item),
          };
        })
        .filter((row): row is PackingRowVm => !!row);

    const openPackages = orderedByCreate.filter((pkg) => this.packageStatus(pkg) === "open");
    const openBoxes = openPackages.map((pkg, index) => {
      const boxNumber = boxNumberById.get(pkg.package_id) ?? (index + 1);
      return {
        pkg,
        boxNumber,
        title: `Caja ${boxNumber}`,
        label: `${boxNumber}/${Math.max(1, totalBoxes)}`,
        rows: rowsForPackage(pkg),
        isActive: activeId ? activeId === pkg.package_id : index === 0,
        isMenuOpen: menuId === pkg.package_id,
        isMoveMode: moveModeId === pkg.package_id,
        isExpanded: false,
      } as PackingBoxVm;
    });

    const closedPackages = [...allPackages]
      .filter((pkg) => this.packageStatus(pkg) === "closed")
      .sort((a, b) => {
        const aDate = new Date((a as any).closed_at || a.created_at).getTime();
        const bDate = new Date((b as any).closed_at || b.created_at).getTime();
        return aDate - bDate;
      });
    const closedBoxes = closedPackages.map((pkg, index) => {
      const boxNumber = boxNumberById.get(pkg.package_id) ?? (index + 1);
      return {
        pkg,
        boxNumber,
        title: `Caja ${boxNumber}`,
        label: `${boxNumber}/${Math.max(1, totalBoxes)}`,
        rows: rowsForPackage(pkg),
        isActive: false,
        isMenuOpen: false,
        isMoveMode: false,
        isExpanded: !!expandedMap[pkg.package_id],
      } as PackingBoxVm;
    });

    const unpackedRows = this.unpackedItems(currentOrder).map((row) => ({
      item: row.item,
      qty: row.qty,
      imageUrl: this.itemImage(row.item),
      initials: this.itemInitials(row.item),
    }));
    const unpackedCount = unpackedRows.reduce((sum, row) => sum + row.qty, 0);
    const confirmedPieces = this.confirmedPieces(currentOrder);
    const packedCount = Math.max(0, confirmedPieces - unpackedCount);
    const progressPercent = confirmedPieces > 0
      ? Math.max(0, Math.min(100, Math.round((packedCount * 100) / confirmedPieces)))
      : 0;
    const activeOpen = openBoxes.find((box) => box.isActive) || null;
    const packBlockedCount = this.packBlockedCount(currentOrder);

    return {
      openBoxes,
      closedBoxes,
      unpackedRows,
      unpackedCount,
      packedCount,
      confirmedPieces,
      progressPercent,
      canDispatch: this.canFinishPacking(currentOrder),
      canStartPacking: packBlockedCount === 0,
      packBlockedCount,
      activeOpenBoxNumber: activeOpen?.boxNumber ?? null,
      openBoxesCount: openBoxes.length,
      closedBoxesCount: closedBoxes.length,
      totalBoxes,
    };
  });

  readonly orderViewVm = computed<OrderViewVm | null>(() => {
    const currentOrder = this.order();
    if (!currentOrder) return null;
    const caps = this.allowedCapabilities(currentOrder, this.userRole());
    const phase = this.phaseAction(currentOrder);
    const counts = this.productCountsVm();
    const packing = this.packingVm();
    const totals = this.totals();
    const totalPieces = this.totalPieces(currentOrder);
    const confirmedPieces = this.confirmedPieces(currentOrder);
    const outOfStockPieces = this.outOfStockPieces(currentOrder);
    const pendingPieces = this.pendingPieces(currentOrder);
    const resolvedPieces = confirmedPieces + outOfStockPieces;
    const confirmedPiecesPercent = totalPieces > 0
      ? Math.max(0, Math.min(100, Math.round((confirmedPieces * 100) / totalPieces)))
      : 0;

    return {
      customerName: this.customerName(currentOrder),
      routeName: this.routeName(currentOrder),
      statusLabel: this.statusLabel(currentOrder.status),
      phase,
      isPackingWorkflowPhase: this.isPackingWorkflowPhase(currentOrder),
      canCreatePackages: caps.canCreatePackages,
      canEditItems: this.canEditItems(currentOrder),
      canAddProducts: this.canAddProducts(currentOrder),
      canViewFinancialSummary: this.canViewFinancialSummary(currentOrder),
      orderBalanceDue: this.orderBalanceDue(currentOrder),
      totals,
      totalItems: counts.total,
      outOfStockItems: counts.outOfStock,
      confirmedItems: counts.confirmed,
      pendingConfirmationItems: counts.pending,
      hasPendingItems: counts.hasPending,
      canMagicConfirm: counts.canMagicConfirm,
      insufficientItemsCount: counts.insufficient,
      shouldShowStockFab: this.showStockFab() && counts.total >= 8 && counts.insufficient > 0,
      totalPieces,
      confirmedPieces,
      outOfStockPieces,
      pendingPieces,
      resolvedPieces,
      confirmedPiecesPercent,
      allItemsResolved: pendingPieces <= 0,
      confirmExistencesActionLabel: `Confirmar existencias · ${confirmedPieces}/${totalPieces}`,
      closedPackagesCount: packing?.closedBoxesCount ?? this.closedPackagesCount(currentOrder),
      packingBoxesCount: packing?.totalBoxes ?? this.packingBoxesCount(currentOrder),
      packedCount: packing?.packedCount ?? this.packedCount(currentOrder),
      unpackedCount: packing?.unpackedCount ?? this.unpackedCount(currentOrder),
      openBoxesCount: packing?.openBoxesCount ?? this.openPackingBoxes(currentOrder).length,
      canDispatch: packing?.canDispatch ?? this.canDispatch(currentOrder),
      canStartPacking: packing?.canStartPacking ?? this.canStartPacking(currentOrder),
      packBlockedCount: packing?.packBlockedCount ?? this.packBlockedCount(currentOrder),
      packingProgressPercent: packing?.progressPercent ?? this.packingProgressPercent(currentOrder),
      supplierTransitCandidatesCount: this.supplierTransitCandidatesCount(currentOrder),
    };
  });

  ngOnInit() {
    this.orderId.set(this.route.snapshot.paramMap.get("id") || "");
    this.initialHydration.set(true);
    void Promise.all([
      this.orders.loadFromFirestore(),
      this.customers.loadFromFirestore().catch(() => null),
      this.suppliers.loadFromFirestore().catch(() => null),
      this.rutas.loadFromFirestore().catch(() => null),
      this.localities.loadFromFirestore().catch(() => null),
      this.inventory.loadFromFirestore().catch(() => null),
      this.supplierOperations.loadFromFirestore().catch(() => null),
      this.loadAssigneeOptions().catch(() => null),
      this.catalog.listValidated(120).then((page) => {
        this.catalogRows.set(page.docs);
        this.catalogLoaded.set(true);
      }).catch(() => null),
      this.manualHistory.load().catch(() => null),
    ]).then(() => {
      this.inventoryLoaded.set(true);
      if (!this.orders.getById(this.orderId())) {
        this.error.set("Pedido no encontrado");
        return;
      }
      this.loadIncidents();
      this.refreshEvents();
    }).catch(() => {
      this.error.set("No se pudo cargar la informacion del pedido.");
    }).finally(() => {
      this.initialHydration.set(false);
    });

    this.route.queryParamMap
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((params) => {
        const focus = params.get("focus");
        this.debugMode.set(params.get("debug") === "1");
        if (!focus) return;
        setTimeout(() => this.applyFocus(focus), 60);
      });

    // Capture scroll from window/body and nested scroll containers.
    window.addEventListener("scroll", this.onAnyScroll, true);
    // Sync sticky controls with current scroll position on initial render.
    setTimeout(() => this.onAnyScroll(), 0);
  }

  ngOnDestroy() {
    window.removeEventListener("scroll", this.onAnyScroll, true);
  }

  async loadIncidents() {
    const orderId = this.orderId();
    if (!orderId) return;
    const list = await this.orders.listIncidents(orderId).catch(() => []);
    this.incidents.set(list);
  }

  private async createIncidentAndRefresh(orderId: string, incident: any): Promise<void> {
    const now = new Date().toISOString();
    const optimisticId = `tmp-inc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const optimisticIncident: Incident = {
      id: optimisticId,
      orderId,
      packageId: incident?.packageId ?? null,
      itemId: incident?.itemId ?? null,
      type: String(incident?.type || "GENERAL"),
      severity: (incident?.severity || "low") as IncidentSeverity,
      status: "open",
      title: String(incident?.title || incident?.type || "Incidencia"),
      reason: String(incident?.reason || ""),
      assigneeId: incident?.assigneeId ?? null,
      evidenceUrls: Array.isArray(incident?.evidenceUrls) ? incident.evidenceUrls : [],
      createdBy: String(incident?.createdBy || "admin"),
      createdAt: now,
      updatedAt: now,
      resolvedBy: null,
      resolvedAt: null,
      resolutionNote: null,
    };

    this.incidents.update((current) => [optimisticIncident, ...current]);
    try {
      await this.orders.createIncident(orderId, incident);
      await this.loadIncidents();
    } catch (error) {
      this.incidents.update((current) => current.filter((row) => row.id !== optimisticId));
      throw error;
    }
  }

  async loadAssigneeOptions() {
    const snap = await getDocs(collection(FIRESTORE, "admins"));
    const names = snap.docs
      .map((docSnap) => {
        const data = docSnap.data() as Record<string, any>;
        const fullName = `${data["first_name"] ?? ""} ${data["last_name"] ?? ""}`.trim();
        return (
          data["display_name"] ||
          data["name"] ||
          data["full_name"] ||
          fullName ||
          data["email"] ||
          ""
        ).toString().trim();
      })
      .filter(Boolean)
      .sort((a, b) => a.localeCompare(b));
    this.assigneeOptions.set(Array.from(new Set(names)));
  }

  itemHasOpenIncident(itemId: string): boolean {
    return this.incidents().some((inc) => inc.status === "open" && inc.itemId === itemId);
  }

  toggleResolved() {
    this.showResolvedIncidents.update((current) => !current);
  }

  incidentItem(order: Order | null, incident: Incident): OrderItem | null {
    if (!order || !incident.itemId) return null;
    return (order.items || []).find((item) => item.item_id === incident.itemId) || null;
  }

  incidentItemImage(order: Order | null, incident: Incident): string | null {
    const item = this.incidentItem(order, incident);
    return item ? this.itemImage(item) : null;
  }

  incidentItemTitle(order: Order | null, incident: Incident): string {
    return this.incidentItem(order, incident)?.title || incident.title || "Producto";
  }

  incidentTitleText(incident: Incident): string {
    const type = (incident.type || "").trim().toUpperCase();
    if (type === "ITEM_MISSING") return "Producto faltante";
    if (type === "ITEM_DAMAGED") return "Producto dañado";
    if (type === "PACK_OVERRIDE_ITEM") return "Confirmado sin recepcion";
    if (type === "DISPATCH_OVERRIDE") return "Salida con pendientes";
    return incident.title || this.incidentTypeText(type);
  }

  incidentTypeText(type: string | null | undefined): string {
    const key = String(type || "").trim().toUpperCase();
    if (!key) return "General";
    const map: Record<string, string> = {
      ITEM_MISSING: "Faltante",
      ITEM_DAMAGED: "Dañado",
      PACK_OVERRIDE_ITEM: "Sin recepcion proveedor",
      DISPATCH_OVERRIDE: "Salida con excepcion",
      GENERAL: "General",
      STOCK: "Stock",
      CALIDAD: "Calidad",
      LOGISTICA: "Logistica",
      PAGO: "Pago",
      ENTREGA: "Entrega",
      SISTEMA: "Sistema",
    };
    if (map[key]) return map[key];
    const human = key
      .replace(/_/g, " ")
      .toLowerCase()
      .trim();
    return human ? `${human[0].toUpperCase()}${human.slice(1)}` : "General";
  }

  incidentSeverityText(severity: IncidentSeverity): string {
    if (severity === "high") return "Alta";
    if (severity === "medium") return "Media";
    return "Baja";
  }

  incidentReasonText(incident: Incident): string {
    const reason = String(incident.reason || "").trim();
    if (!reason) return "Sin detalle adicional.";
    if ((incident.type || "").toUpperCase() === "PACK_OVERRIDE_ITEM") {
      return reason.replace(
        /^(Empaque con override sin recepción confirmada|Empaque sin confirmar llegada del proveedor):/i,
        "Se confirmo sin recepcion de proveedor:",
      );
    }
    return reason;
  }

  incidentReporterText(incident: Incident): string {
    const raw = String(incident.createdBy || "").trim();
    if (!raw) return "Sistema";
    if (raw.toLowerCase() === "admin") return "Administrador";
    return this.toNameAndFirstSurname(raw);
  }

  async loadEvents() {
    const orderId = this.orderId();
    if (!orderId) return;
    if (this.eventsLoading() || !this.eventsHasMore()) return;
    this.eventsLoading.set(true);
    try {
      const page = await this.orders.listEventsPage(orderId, 20, this.eventsCursor()).catch(() => ({ events: [], cursor: null }));
      this.events.update((current) => [...current, ...page.events]);
      this.eventsCursor.set(page.cursor ?? null);
      if (!page.events.length) this.eventsHasMore.set(false);
    } finally {
      this.eventsLoading.set(false);
    }
  }

  async refreshEvents() {
    this.events.set([]);
    this.eventsCursor.set(null);
    this.eventsHasMore.set(true);
    await this.loadEvents();
  }

  customerName(order: Order | null): string {
    if (!order) return "";
    const row = this.customers.getById(order.customer_id);
    if (!row) return "Cliente sin nombre";
    return `${row.first_name} ${row.last_name}`.trim();
  }

  routeName(order: Order | null): string {
    if (!order || !order.route_id) return "Sin ruta";
    return this.rutas.getById(order.route_id)?.name || order.route_id;
  }

  canCap(key: string): boolean {
    return this.authz.canCap(key);
  }

  canRequestDispatchAction(): boolean {
    return this.canCap("cap.dispatch.request");
  }

  canAcceptDispatchAction(): boolean {
    return this.canCap("cap.dispatch.accept_request") && this.canCap("cap.runs.add_order");
  }

  canViewFinancialSummary(order: Order): boolean {
    return this.canCap("cap.payments.view");
  }

  orderBalanceDue(order: Order): number {
    const fromTotals = Number(order.totals?.balance_due ?? 0);
    if (Number.isFinite(fromTotals) && fromTotals > 0) return fromTotals;
    return Math.max(0, (this.totals().totalClienta || 0) - (order.totals?.paid_amount || 0));
  }

  isOrderClosed(order: Order | null): boolean {
    if (!order) return true;
    return ["entregado", "pagado", "cancelado", "devuelto", "closed", "delivered"].includes(order.status);
  }

  hasPackingStarted(order: Order): boolean {
    if ((order.packages || []).length > 0) return true;
    if (order.packing?.status === "done") return true;
    return ["ready_for_route", "assigned_to_run", "in_transit", "en_ruta", "delivered", "entregado", "closed", "pagado"].includes(order.status);
  }

  canAddProducts(order: Order): boolean {
    return this.canEditItems(order);
  }

  statusLabel(status: OrderStatus): string {
    const map: Record<OrderStatus, string> = {
      borrador: "Borrador",
      confirmando_proveedor: "Confirmando",
      reservado_inventario: "Reservado",
      solicitado_proveedor: "Solicitado",
      supplier_processing: "Proveedor",
      inbound_in_transit: "En transito proveedor",
      en_transito: "En transito proveedor",
      packing: "Empacando",
      recibido_qa: "En transito proveedor",
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
      case "entregado":
      case "delivered":
      case "closed":
      case "pagado":
        return "chip success";
      case "cancelado":
      case "devuelto":
        return "chip danger";
      case "pagado_parcial":
        return "chip warning";
      case "pago_pendiente":
        return "chip warning";
      case "empaque":
      case "packing":
      case "ready_for_route":
      case "assigned_to_run":
      case "in_transit":
      case "en_ruta":
      case "en_transito":
      case "inbound_in_transit":
        return "chip accent";
      default:
        return "chip info";
    }
  }

  eventActor(event: any): string {
    if (!event) return "Usuario";
    if (typeof event.actor === "string" && event.actor.trim()) return event.actor;
    if (event.actor?.name) return event.actor.name;
    if (event.meta?.system) return "Sistema";
    return "Usuario";
  }

  relativeTime(value: string | Date | null | undefined): string {
    if (!value) return "";
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) return "";
    const diffMs = Date.now() - date.getTime();
    const diffMin = Math.round(Math.abs(diffMs) / 60000);
    if (diffMin < 1) return "Justo ahora";
    if (diffMin < 60) return `Hace ${diffMin} min`;
    const diffHours = Math.round(diffMin / 60);
    if (diffHours < 24) return `Hace ${diffHours} h`;
    const diffDays = Math.round(diffHours / 24);
    if (diffDays < 7) return `Hace ${diffDays} d`;
    const diffWeeks = Math.round(diffDays / 7);
    if (diffWeeks < 5) return `Hace ${diffWeeks} sem`;
    const diffMonths = Math.round(diffDays / 30);
    if (diffMonths < 12) return `Hace ${diffMonths} mes`;
    const diffYears = Math.round(diffDays / 365);
    return `Hace ${diffYears} a`;
  }

  allowedCapabilities(order: Order | null, userRole: string) {
    if (!order) {
      return {
        canEditItems: false,
        canConfirmItems: false,
        canRegisterReception: false,
        canCreatePackages: false,
        canAssignItemsToPackages: false,
        canPrintLabels: false,
        canDeliverByPackage: false,
        canRegisterPayment: false,
        canPack: false,
        limitedEdit: false,
      };
    }
    if (userRole === "viewer") {
      return {
        canEditItems: false,
        canConfirmItems: false,
        canRegisterReception: false,
        canCreatePackages: false,
        canAssignItemsToPackages: false,
        canPrintLabels: false,
        canDeliverByPackage: false,
        canRegisterPayment: false,
        canPack: false,
        limitedEdit: false,
      };
    }
    switch (order.status) {
      case "borrador":
        return {
          canEditItems: true,
          canConfirmItems: false,
          canRegisterReception: false,
          canCreatePackages: false,
          canAssignItemsToPackages: false,
          canPrintLabels: false,
          canDeliverByPackage: false,
          canRegisterPayment: false,
          canPack: false,
          limitedEdit: false,
        };
      case "confirmando_proveedor":
      case "reservado_inventario":
      case "solicitado_proveedor":
      case "supplier_processing":
      case "inbound_in_transit":
      case "en_transito":
        return {
          canEditItems: true,
          canConfirmItems: true,
          canRegisterReception: false,
          canCreatePackages: false,
          canAssignItemsToPackages: false,
          canPrintLabels: false,
          canDeliverByPackage: false,
          canRegisterPayment: false,
          canPack: false,
          limitedEdit: true,
        };
      case "recibido_qa":
      case "packing":
      case "empaque":
        return {
          canEditItems: false,
          canConfirmItems: false,
          canRegisterReception: true,
          canCreatePackages: true,
          canAssignItemsToPackages: true,
          canPrintLabels: true,
          canDeliverByPackage: false,
          canRegisterPayment: false,
          canPack: true,
          limitedEdit: false,
        };
      case "en_ruta":
      case "in_transit":
        return {
          canEditItems: false,
          canConfirmItems: false,
          canRegisterReception: false,
          canCreatePackages: false,
          canAssignItemsToPackages: false,
          canPrintLabels: true,
          canDeliverByPackage: true,
          canRegisterPayment: false,
          canPack: false,
          limitedEdit: true,
        };
      case "pagado":
        return {
          canEditItems: false,
          canConfirmItems: false,
          canRegisterReception: false,
          canCreatePackages: false,
          canAssignItemsToPackages: false,
          canPrintLabels: false,
          canDeliverByPackage: false,
          canRegisterPayment: false,
          canPack: false,
          limitedEdit: false,
        };
      case "pago_pendiente":
      case "ready_for_route":
      case "assigned_to_run":
      case "delivered":
      case "delivered_partial":
      case "closed":
        return {
          canEditItems: false,
          canConfirmItems: false,
          canRegisterReception: false,
          canCreatePackages: false,
          canAssignItemsToPackages: false,
          canPrintLabels: false,
          canDeliverByPackage: false,
          canRegisterPayment: true,
          canPack: false,
          limitedEdit: false,
        };
      case "entregado":
      default:
        return {
          canEditItems: false,
          canConfirmItems: false,
          canRegisterReception: false,
          canCreatePackages: false,
          canAssignItemsToPackages: false,
          canPrintLabels: false,
          canDeliverByPackage: false,
          canRegisterPayment: false,
          canPack: false,
          limitedEdit: false,
        };
    }
  }

  phaseAction(order: Order | null): { actionId: string; label: string } | null {
    if (!order) return null;
    switch (order.status) {
      case "borrador":
      case "confirmando_proveedor":
      case "reservado_inventario":
      case "solicitado_proveedor":
        return { actionId: "confirm_items", label: "Confirmar existencias" };
      case "supplier_processing":
        return { actionId: "supplier_followup", label: "Marcar en transito proveedor" };
      case "inbound_in_transit":
      case "en_transito":
      case "recibido_qa":
      case "packing":
        if (this.canFinishPacking(order)) {
          return { actionId: "dispatch", label: "Terminar empaquetado" };
        }
        return { actionId: "pack", label: this.canStartPacking(order) ? "Terminar empaquetado" : "Empacar" };
      case "empaque":
        return { actionId: "dispatch", label: "Terminar empaquetado" };
      case "ready_for_route":
      case "assigned_to_run":
        return null;
      case "en_ruta":
      case "in_transit":
        return { actionId: "deliver", label: "Registrar entrega" };
      case "delivered_partial":
      case "pago_pendiente":
        return { actionId: "register_payment", label: "Registrar pago/conciliar" };
      default:
        return null;
    }
  }

  isPackingWorkflowPhase(order: Order | null): boolean {
    if (!order) return false;
    const action = this.phaseAction(order)?.actionId;
    if (action === "pack" || action === "dispatch") return true;
    return order.status === "ready_for_route" || order.status === "assigned_to_run";
  }

  openActionModal(order: Order | null) {
    const action = this.phaseAction(order);
    if (!order || !action) return;
    if (action.actionId === "confirm_items" && order.items.length === 0) {
      this.actionContext.set(action);
      this.actionError.set("No hay items en el pedido.");
      this.actionModalOpen.set(true);
      return;
    }
    this.actionContext.set(action);
    this.actionError.set(null);
    this.actionModalOpen.set(true);
  }

  closeActionModal() {
    this.actionModalOpen.set(false);
  }

  closedPackagesCount(order: Order): number {
    return this.closedPackingBoxes(order).length;
  }

  packingBoxesCount(order: Order): number {
    return this.totalPackingBoxes(order);
  }

  deliveredPackagesCount(order: Order): number {
    return (order.packages || []).filter((pkg) => pkg.state === "entregado").length;
  }

  unassignedConfirmedItems(order: Order): number {
    return this.unpackedCount(order);
  }

  canDispatch(order: Order): boolean {
    return this.canFinishPacking(order);
  }

  hasEmptyPackages(order: Order | null): boolean {
    if (!order) return false;
    return (order.packages || []).some((pkg) => !this.packageHasItems(pkg));
  }

  canFinishPacking(order: Order): boolean {
    if (this.closedPackagesCount(order) <= 0) return false;
    if (this.openPackingBoxes(order).length > 0) return false;
    if (this.hasEmptyPackages(order)) return false;
    if (this.unpackedCount(order) > 0) return false;
    return true;
  }

  supplierNameById(supplierId: string | null | undefined): string {
    if (!supplierId) return "Sin proveedor";
    return this.suppliers.getById(supplierId)?.display_name || supplierId;
  }

  groupDisplayName(group: { supplierName: string; items: OrderItem[] }): string {
    const items = group.items || [];
    if (items.length > 0 && items.every((item) => item.source === "inventario")) return "Inventario";
    if (items.length > 0 && items.every((item) => item.source === "manual")) return "Manual";
    return group.supplierName;
  }

  itemImage(item: OrderItem): string | null {
    const cached = this.itemImageByItemId();
    if (cached.has(item.item_id)) return cached.get(item.item_id) ?? null;
    return this.resolveItemImage(item);
  }

  private resolveItemImage(item: OrderItem): string | null {
    if (item.image_url) return item.image_url;

    if (item.source === "inventario" && item.inventory_id) {
      return this.inventoryById().get(item.inventory_id)?.image_urls?.[0] || null;
    }

    if (item.source === "catalogo" && item.product_id) {
      const doc = this.catalogById().get(item.product_id) || null;
      if (!doc) return null;
      const listing: any = doc.listing || { items: [] };
      const variant = (listing.items || []).find((v: any) => (v.variant_name || "") === (item.variant || "")) || null;
      return variant?.image_url || doc.cover_images?.[0] || doc.preview_image_url || null;
    }

    return null;
  }

  private itemInitials(item: OrderItem): string {
    return (item.title || "?").slice(0, 2).toUpperCase();
  }

  groupedItemsBySupplier(order: Order): { supplierId: string | null; supplierName: string; items: OrderItem[] }[] {
    const groups = new Map<string | null, OrderItem[]>();
    for (const item of order.items || []) {
      const key = item.supplier_id ?? null;
      const list = groups.get(key) || [];
      list.push(item);
      groups.set(key, list);
    }
    return Array.from(groups.entries()).map(([supplierId, items]) => ({
      supplierId,
      supplierName: this.supplierNameById(supplierId),
      items,
    }));
  }

  availableStock(item: OrderItem): number | null {
    if (item.source !== "inventario" || !item.inventory_id) return null;
    return this.inventoryById().get(item.inventory_id)?.quantity_on_hand ?? null;
  }

  hasInsufficientStock(item: OrderItem): boolean {
    const available = this.availableStock(item);
    if (available === null) return false;
    return available < this.itemQuantity(item);
  }

  showStockConfidence(item: OrderItem): boolean {
    const available = this.availableStock(item);
    if (available === null) return false;
    return available >= this.itemQuantity(item);
  }

  insufficientItems(order: Order): OrderItem[] {
    return (order.items || []).filter((item) => this.hasInsufficientStock(item) || this.isOutOfStockConfirmation(item));
  }

  insufficientItemsCount(order: Order): number {
    return this.insufficientItems(order).length;
  }

  outOfStockItemsCount(order: Order): number {
    return (order.items || []).filter((item) => item.confirmation_state === "out_of_stock").length;
  }

  confirmedItemsCount(order: Order): number {
    return (order.items || []).filter((item) => item.confirmation_state === "confirmed").length;
  }

  pendingConfirmationItemsCount(order: Order): number {
    return (order.items || []).filter((item) => !item.confirmation_state || item.confirmation_state === "pending").length;
  }

  readyItemsCount(order: Order): number {
    return (order.items || []).filter((item) => !this.hasInsufficientStock(item)).length;
  }

  filteredProductItems(order: Order): OrderItem[] {
    const items = order.items || [];
    switch (this.productStockFilter()) {
      case "out_of_stock":
        return items.filter((item) => item.confirmation_state === "out_of_stock");
      case "confirmed":
        return items.filter((item) => item.confirmation_state === "confirmed");
      case "pending":
        return items.filter((item) => !item.confirmation_state || item.confirmation_state === "pending");
      default:
        return items;
    }
  }

  setProductStockFilter(filter: "all" | "out_of_stock" | "confirmed" | "pending") {
    this.productStockFilter.set(filter);
  }

  estado_confirmacion(item: OrderItem): EstadoConfirmacion {
    if (item.confirmation_state === "confirmed") return "confirmado";
    if (item.confirmation_state === "out_of_stock" || (item.confirmation_state as unknown) === "sin_stock") return "sin_stock";
    return "pendiente";
  }

  isPendingConfirmation(item: OrderItem): boolean {
    return this.estado_confirmacion(item) === "pendiente";
  }

  isConfirmedConfirmation(item: OrderItem): boolean {
    return this.estado_confirmacion(item) === "confirmado";
  }

  isOutOfStockConfirmation(item: OrderItem): boolean {
    return this.estado_confirmacion(item) === "sin_stock";
  }

  confirmedReadyItems(order: Order): number {
    return (order.items || []).filter((item) => this.isConfirmedConfirmation(item)).length;
  }

  confirmExistencesActionLabel(order: Order): string {
    return `Confirmar existencias · ${this.confirmedPieces(order)}/${this.totalPieces(order)}`;
  }

  isConfirmExistencesReady(order: Order): boolean {
    return this.totalItems(order) > 0 && this.allItemsResolved(order);
  }

  productCardId(item: OrderItem): string {
    return `product-card-${item.item_id}`;
  }

  shouldShowStockFab(order: Order): boolean {
    return this.showStockFab() && this.totalItems(order) >= 8 && this.insufficientItemsCount(order) > 0;
  }

  scrollToFirstInsufficientProduct(order: Order) {
    const target = this.insufficientItems(order)[0];
    if (!target) return;
    this.productStockFilter.set("all");
    setTimeout(() => {
      document.getElementById(this.productCardId(target))?.scrollIntoView({ behavior: "smooth", block: "center" });
    }, 60);
  }

  hasStockAvailable(item: OrderItem): boolean {
    const available = this.availableStock(item);
    if (available === null) return true;
    return available >= this.itemQuantity(item);
  }

  maxConfirmableQty(item: OrderItem): number {
    const qty = this.itemQuantity(item);
    const available = this.availableStock(item);
    if (available === null) return qty;
    return Math.max(0, Math.min(qty, Math.trunc(available)));
  }

  private cardMaxConfirmableQty(item: OrderItem): number {
    if (item.source === "inventario") return this.itemQuantity(item);
    return this.maxConfirmableQty(item);
  }

  hasStockForSmartConfirm(item: OrderItem): boolean {
    return this.maxConfirmableQty(item) > 0;
  }

  canQuickCheck(item: OrderItem): boolean {
    return !this.isConfirmedConfirmation(item);
  }

  isQuickConfirmed(item: OrderItem): boolean {
    return this.isConfirmedConfirmation(item) && this.confirmedQty(item) >= this.itemQuantity(item);
  }

  async quickConfirmItem(order: Order, item: OrderItem) {
    if (!this.canQuickCheck(item) || this.isQuickConfirming(item)) return;
    this.quickConfirming.update((current) => ({ ...current, [item.item_id]: true }));
    try {
      this.confirmQtyDraft.update((current) => ({
        ...current,
        [item.item_id]: this.itemQuantity(item),
      }));
      await this.confirmItem(order, item);
    } finally {
      this.quickConfirming.update((current) => ({ ...current, [item.item_id]: false }));
    }
  }

  isQuickConfirming(item: OrderItem): boolean {
    return !!this.quickConfirming()[item.item_id];
  }

  getCardDraftConfirmedQty(item: OrderItem): number {
    const max = this.cardMaxConfirmableQty(item);
    const draft = this.confirmQtyDraft()[item.item_id];
    if (typeof draft === "number") {
      // If the item was marked out_of_stock, draft is usually 0.
      // Allow switching back to confirmed using the max confirmable qty.
      if (this.isOutOfStockConfirmation(item) && draft <= 0 && max > 0) return max;
      return this.normalizeConfirmedQty(draft, max);
    }
    if (this.isConfirmedConfirmation(item)) return this.normalizeConfirmedQty(this.confirmedQty(item), max);
    return max;
  }

  setCardDraftConfirmedQty(item: OrderItem, value: unknown) {
    const max = this.cardMaxConfirmableQty(item);
    const next = this.normalizeConfirmedQty(value, max);
    this.confirmQtyDraft.update((current) => ({ ...current, [item.item_id]: next }));
  }

  increaseCardConfirmedQty(item: OrderItem) {
    this.setCardDraftConfirmedQty(item, this.getCardDraftConfirmedQty(item) + 1);
  }

  decreaseCardConfirmedQty(item: OrderItem) {
    this.setCardDraftConfirmedQty(item, this.getCardDraftConfirmedQty(item) - 1);
  }

  async confirmarItem(item: OrderItem) {
    const order = this.order();
    if (!order || !this.isConfirmItemsPhase(order)) return;
    if (this.isQuickConfirming(item)) return;
    this.quickConfirming.update((current) => ({ ...current, [item.item_id]: true }));
    try {
      const qty = this.getCardDraftConfirmedQty(item);
      if (qty <= 0) {
        await this.markOutOfStock(order, item);
        return;
      }
      this.confirmQtyDraft.update((current) => ({ ...current, [item.item_id]: qty }));
      await this.confirmItem(order, item);
    } finally {
      this.quickConfirming.update((current) => ({ ...current, [item.item_id]: false }));
    }
  }

  async decreaseConfirmedCounter(item: OrderItem) {
    const max = this.cardMaxConfirmableQty(item);
    if (max <= 0 || this.isQuickConfirming(item)) return;
    const current = this.getCardDraftConfirmedQty(item);
    const next = Math.max(0, current - 1);
    if (next === current) return;
    this.setCardDraftConfirmedQty(item, next);
    if (next <= 0) {
      await this.marcarAgotado(item);
      return;
    }
    await this.confirmarItem(item);
  }

  async increaseConfirmedCounter(item: OrderItem) {
    const max = this.cardMaxConfirmableQty(item);
    if (max <= 0 || this.isQuickConfirming(item)) return;
    const current = this.getCardDraftConfirmedQty(item);
    const next = Math.min(max, current + 1);
    if (next === current) return;
    this.setCardDraftConfirmedQty(item, next);
    await this.confirmarItem(item);
  }

  async marcarAgotado(item: OrderItem) {
    const order = this.order();
    if (!order || !this.isConfirmItemsPhase(order)) return;
    if (this.isOutOfStockConfirmation(item) || this.isQuickConfirming(item)) return;
    this.quickConfirming.update((current) => ({ ...current, [item.item_id]: true }));
    try {
      await this.markOutOfStock(order, item);
    } finally {
      this.quickConfirming.update((current) => ({ ...current, [item.item_id]: false }));
    }
  }

  async confirmarTodoDisponible() {
    const order = this.order();
    if (!order || !this.isConfirmItemsPhase(order)) return;
    await this.magicConfirmAvailable(order);
  }

  canMagicConfirm(order: Order): boolean {
    return (order.items || []).some(
      (item) => !this.isConfirmedConfirmation(item) && (item.source === "inventario" || this.hasStockForSmartConfirm(item)),
    );
  }

  async magicConfirmAvailable(order: Order) {
    const targets = (order.items || []).filter((item) => !this.isConfirmedConfirmation(item));
    if (targets.length === 0) return;
    await Promise.all(
      targets.map(async (item) => {
        const qty = item.source === "inventario" ? this.itemQuantity(item) : this.maxConfirmableQty(item);
        if (qty <= 0) {
          await this.markOutOfStock(order, item);
          return;
        }
        this.confirmQtyDraft.update((current) => ({ ...current, [item.item_id]: qty }));
        await this.confirmItem(order, item);
      }),
    );
  }

  hasPendingItems(order: Order): boolean {
    return (order.items || []).some((item) => !this.isConfirmedConfirmation(item));
  }

  canBatchMarkAvailable(order: Order): boolean {
    return this.canMagicConfirm(order);
  }

  async markVisibleAsAvailable(order: Order) {
    await this.magicConfirmAvailable(order);
  }

  shouldMagnetizeInsufficientTab(order: Order): boolean {
    return this.insufficientItemsCount(order) > 0;
  }

  confirmedItems(order: Order): OrderItem[] {
    return (order.items || []).filter((item) => item.confirmation_state === "confirmed");
  }

  totalPieces(order: Order): number {
    return (order.items || []).reduce((sum, item) => sum + this.itemQuantity(item), 0);
  }

  confirmedPiecesPercent(order: Order): number {
    const total = this.totalPieces(order);
    if (total <= 0) return 0;
    const pct = (this.confirmedPieces(order) * 100) / total;
    return Math.max(0, Math.min(100, Math.round(pct)));
  }

  resolvedPieces(order: Order): number {
    return this.confirmedPieces(order) + this.outOfStockPieces(order);
  }

  resolvedPiecesPercent(order: Order): number {
    const total = this.totalPieces(order);
    if (total <= 0) return 0;
    const pct = (this.resolvedPieces(order) * 100) / total;
    return Math.max(0, Math.min(100, Math.round(pct)));
  }

  totalItems(order: Order): number {
    return (order.items || []).length;
  }

  resolvedItems(order: Order): number {
    return (order.items || []).filter((item) => item.confirmation_state && item.confirmation_state !== "pending").length;
  }

  confirmedPieces(order: Order): number {
    return (order.items || []).reduce((sum, item) => sum + this.itemConfirmedPieces(item), 0);
  }

  outOfStockPieces(order: Order): number {
    return (order.items || []).reduce((sum, item) => sum + this.itemOutOfStockPieces(item), 0);
  }

  pendingPieces(order: Order): number {
    return (order.items || []).reduce((sum, item) => sum + this.itemPendingPieces(item), 0);
  }

  allItemsResolved(order: Order): boolean {
    return (order.items || []).every((item) => item.confirmation_state && item.confirmation_state !== "pending");
  }

  unresolvedItemsCount(order: Order): number {
    return (order.items || []).filter((item) => !item.confirmation_state || item.confirmation_state === "pending").length;
  }

  missingSupplierCount(order: Order): number {
    return this.confirmedItems(order).filter((item) => item.source === "catalogo" && !item.supplier_id).length;
  }

  canEditItems(order: Order | null): boolean {
    if (!order) return false;
    if (this.userRole() === "viewer") return false;
    if (this.isOrderClosed(order)) return false;
    return true;
  }

  nextStatus(order: Order | null): OrderStatus | null {
    if (!order) return null;
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
    ];
    const idx = flow.indexOf(order.status);
    if (idx === -1 || idx === flow.length - 1) return null;
    return flow[idx + 1];
  }

  advance(order: Order | null) {
    const next = this.nextStatus(order);
    if (order && next) this.orders.updateStatus(order.order_id, next);
  }

  setItemState(orderId: string, item: OrderItem, state: OrderItemState) {
    this.orders.updateItemState(orderId, item.item_id, state);
  }

  async confirmItem(order: Order, item: OrderItem) {
    const qty = this.getDraftConfirmedQty(item);
    if (qty <= 0) {
      await this.markOutOfStock(order, item);
      return;
    }
    this.confirmQtyDraft.update((current) => ({ ...current, [item.item_id]: qty }));
    await this.orders.updateItemConfirmation(order.order_id, item.item_id, {
      confirmation_state: "confirmed",
      confirmed_qty: qty,
    });
    await this.logItemConfirmationEvent(order, item, "confirmed", qty);
  }

  async markOutOfStock(order: Order, item: OrderItem) {
    this.confirmQtyDraft.update((current) => ({ ...current, [item.item_id]: 0 }));
    await this.orders.updateItemConfirmation(order.order_id, item.item_id, {
      confirmation_state: "out_of_stock",
      confirmed_qty: 0,
    });
    await this.logItemConfirmationEvent(order, item, "out_of_stock", 0);
  }

  groupUnresolvedCount(items: OrderItem[]): number {
    return items.filter((item) => !item.confirmation_state || item.confirmation_state === "pending").length;
  }

  groupConfirmedCount(items: OrderItem[]): number {
    return items.reduce((sum, item) => sum + this.itemConfirmedPieces(item), 0);
  }

  groupOutOfStockCount(items: OrderItem[]): number {
    return items.reduce((sum, item) => sum + this.itemOutOfStockPieces(item), 0);
  }

  groupPendingCount(items: OrderItem[]): number {
    return items.reduce((sum, item) => sum + this.itemPendingPieces(item), 0);
  }

  async confirmGroup(order: Order, items: OrderItem[]) {
    const pending = items.filter((item) => item.confirmation_state !== "confirmed");
    if (pending.length === 0) return;
    this.confirmQtyDraft.update((current) => {
      const next = { ...current };
      for (const item of pending) next[item.item_id] = this.normalizeConfirmedQty(item.quantity, item.quantity);
      return next;
    });
    await Promise.all(
      pending.map((item) =>
        this.orders.updateItemConfirmation(order.order_id, item.item_id, {
          confirmation_state: "confirmed",
          confirmed_qty: this.normalizeConfirmedQty(item.quantity, item.quantity),
        }),
      ),
    );
    await this.orders.logEvent(order.order_id, "existence_confirmed", "Confirmación masiva de existencias", {
      items: pending.map((item) => item.item_id),
      qty: pending.length,
    });
  }

  async outOfStockGroup(order: Order, items: OrderItem[]) {
    const pending = items.filter((item) => item.confirmation_state !== "out_of_stock");
    if (pending.length === 0) return;
    this.confirmQtyDraft.update((current) => {
      const next = { ...current };
      for (const item of pending) next[item.item_id] = 0;
      return next;
    });
    await Promise.all(
      pending.map((item) =>
        this.orders.updateItemConfirmation(order.order_id, item.item_id, {
          confirmation_state: "out_of_stock",
          confirmed_qty: 0,
        }),
      ),
    );
    await this.orders.logEvent(order.order_id, "out_of_stock_marked", "Marcado masivo de items agotados", {
      items: pending.map((item) => item.item_id),
      qty: pending.length,
    });
  }

  private async logItemConfirmationEvent(
    order: Order,
    item: OrderItem,
    state: "confirmed" | "out_of_stock",
    confirmedQty: number,
  ) {
    if (state === "confirmed") {
      await this.orders.logEvent(order.order_id, "existence_confirmed", "Item marcado disponible", {
        itemId: item.item_id,
        itemTitle: item.title,
        confirmed_qty: confirmedQty,
      });
      await this.refreshEvents();
      return;
    }
    await this.orders.logEvent(order.order_id, "out_of_stock_marked", "Item marcado agotado", {
      itemId: item.item_id,
      itemTitle: item.title,
      confirmed_qty: 0,
    });
    await this.refreshEvents();
  }

  confirmedQty(item: OrderItem): number {
    if (typeof item.confirmed_qty === "number") {
      return this.normalizeConfirmedQty(item.confirmed_qty, item.quantity);
    }
    if (item.confirmation_state === "confirmed") {
      return this.normalizeConfirmedQty(item.quantity, item.quantity);
    }
    return 0;
  }

  getDraftConfirmedQty(item: OrderItem): number {
    const draft = this.confirmQtyDraft()[item.item_id];
    if (typeof draft === "number") return this.normalizeConfirmedQty(draft, item.quantity);
    return this.confirmedQty(item);
  }

  setDraftConfirmedQty(item: OrderItem, value: unknown) {
    const next = this.normalizeConfirmedQty(value, item.quantity);
    this.confirmQtyDraft.update((current) => ({ ...current, [item.item_id]: next }));
  }

  increaseDraftConfirmedQty(item: OrderItem) {
    this.setDraftConfirmedQty(item, this.getDraftConfirmedQty(item) + 1);
  }

  decreaseDraftConfirmedQty(item: OrderItem) {
    this.setDraftConfirmedQty(item, this.getDraftConfirmedQty(item) - 1);
  }

  hasPartialConfirmation(item: OrderItem): boolean {
    return item.confirmation_state === "confirmed" && this.confirmedQty(item) < item.quantity;
  }

  private itemOutOfStockPieces(item: OrderItem): number {
    if (item.confirmation_state === "out_of_stock" || (item.confirmation_state as unknown) === "sin_stock") {
      return this.itemQuantity(item);
    }
    if (item.confirmation_state !== "confirmed") return 0;
    return Math.max(0, this.itemQuantity(item) - this.confirmedQty(item));
  }

  private itemConfirmedPieces(item: OrderItem): number {
    return this.confirmedQty(item);
  }

  private itemPendingPieces(item: OrderItem): number {
    if (item.confirmation_state && item.confirmation_state !== "pending") return 0;
    return Math.max(0, this.itemQuantity(item) - this.confirmedQty(item));
  }

  private itemQuantity(item: OrderItem): number {
    const qty = Number(item.quantity);
    if (!Number.isFinite(qty)) return 0;
    return Math.max(0, Math.trunc(qty));
  }

  private normalizeConfirmedQty(value: unknown, max: number): number {
    const qty = Number(value);
    if (!Number.isFinite(qty)) return 0;
    return Math.max(0, Math.min(max, Math.round(qty)));
  }

  async markSubstitute(order: Order, item: OrderItem) {
    await this.orders.updateItemConfirmationState(order.order_id, item.item_id, "substitute");
  }

  async receiveItem(order: Order, item: OrderItem) {
    if (this.isItemActionLoading(item)) return;
    this.setItemActionLoading(item, true);
    try {
      if (this.isSupplierManagedItem(item)) {
        await this.receiveSupplierItem(order, item);
        return;
      }
      await this.orders.updateItemState(order.order_id, item.item_id, "recibido_qa");
      await this.orders.logEvent(order.order_id, "ITEM_RECEIVED_QA", `En transito proveedor: ${item.title}`, {
        itemId: item.item_id,
      });
      this.showActionToast(`"${item.title}" recibido.`);
    } finally {
      this.setItemActionLoading(item, false);
    }
  }

  async markPacked(order: Order, item: OrderItem) {
    if (this.isItemActionLoading(item)) return;
    if (!this.isItemReadyForPack(order, item)) {
      this.actionError.set(`No puedes empacar "${item.title}" porque sigue pendiente de recepción de proveedor.`);
      return;
    }
    this.setItemActionLoading(item, true);
    try {
      await this.orders.updateItemState(order.order_id, item.item_id, "empaque");
      await this.orders.logEvent(order.order_id, "ITEM_PACKED", `Empaque: ${item.title}`, {
        itemId: item.item_id,
      });
      this.actionError.set(null);
      this.showActionToast(`"${item.title}" en empaque.`);
    } finally {
      this.setItemActionLoading(item, false);
    }
  }

  isSupplierManagedItem(item: OrderItem): boolean {
    return item.source !== "inventario" && !!(item.supplier_id || "").trim();
  }

  isManualItem(item: OrderItem): boolean {
    return item.source === "manual";
  }

  unregisteredItems(order: Order): OrderItem[] {
    return (order.items || []).filter((item) => item.source === "manual");
  }

  unregisteredItemsCount(order: Order): number {
    return this.unregisteredItems(order).length;
  }

  private supplierOpId(order: Order, item: OrderItem): string {
    return `op-${order.order_id}-${item.item_id}`;
  }

  supplierOperationForItem(order: Order, item: OrderItem) {
    return this.supplierOperations.rows().find((row) => row.order_id === order.order_id && row.order_item_id === item.item_id) || null;
  }

  isSupplierItemReceived(order: Order, item: OrderItem): boolean {
    if (!this.isSupplierManagedItem(item)) return true;
    if (this.isLateAddedItem(item) && this.isLateArrivalConfirmed(item)) return true;
    const op = this.supplierOperationForItem(order, item);
    if (!op) return false;
    return op.status === "recibido" || op.received_to_inventory === true;
  }

  isItemReadyForPack(order: Order, item: OrderItem): boolean {
    if (item.confirmation_state !== "confirmed") return false;
    if (["cancelado", "devuelto"].includes(item.state)) return false;
    if (["empaque", "en_ruta", "entregado", "pagado"].includes(item.state)) return true;
    if (item.source === "inventario") return true;
    return this.isSupplierItemReceived(order, item);
  }

  packBlockedItems(order: Order): OrderItem[] {
    return (order.items || []).filter((item) => item.confirmation_state === "confirmed" && !this.isItemReadyForPack(order, item));
  }

  packBlockedCount(order: Order): number {
    return this.packBlockedItems(order).length;
  }

  canStartPacking(order: Order): boolean {
    return this.packBlockedCount(order) === 0;
  }

  packedCount(order: Order): number {
    const totalConfirmed = this.confirmedPieces(order);
    return Math.max(0, totalConfirmed - this.unpackedCount(order));
  }

  packingProgressPercent(order: Order): number {
    const totalConfirmed = this.confirmedPieces(order);
    if (totalConfirmed <= 0) return 0;
    const pct = (this.packedCount(order) * 100) / totalConfirmed;
    return Math.max(0, Math.min(100, Math.round(pct)));
  }

  private async receiveSupplierItem(order: Order, item: OrderItem) {
    if (!this.isSupplierManagedItem(item)) return;
    const opId = this.supplierOpId(order, item);
    try {
      await this.supplierOperations.upsertFromConfirmedOrder(order, this.customerName(order));
      await this.supplierOperations.updateStatus(opId, "recibido");
      await this.orders.updateItemState(order.order_id, item.item_id, "recibido_qa");
      await this.orders.syncDerivedStatus(order.order_id);
      await this.orders.logEvent(order.order_id, "ITEM_RECEIVED_QA", `Recibido desde proveedor: ${item.title}`, {
        itemId: item.item_id,
        supplierOpId: opId,
      });
      this.actionError.set(null);
      this.showActionToast(`"${item.title}" recibido de proveedor.`);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Error al recibir item de proveedor.";
      this.actionError.set(`No se pudo recibir "${item.title}": ${message}`);
    }
  }

  isItemActionLoading(item: OrderItem): boolean {
    return !!this.itemActionLoading()[item.item_id];
  }

  private setItemActionLoading(item: OrderItem, loading: boolean) {
    this.itemActionLoading.update((current) => ({ ...current, [item.item_id]: loading }));
  }

  private showActionToast(message: string) {
    if (this.actionToastTimer) clearTimeout(this.actionToastTimer);
    this.actionToast.set(message);
    this.actionToastTimer = setTimeout(() => {
      this.actionToast.set(null);
      this.actionToastTimer = null;
    }, 1800);
  }

  private showPopupAlert(message: string, title = "Aviso"): Promise<void> {
    const normalizedMessage = String(message || "").trim();
    if (!normalizedMessage) return Promise.resolve();
    const normalizedTitle = String(title || "").trim() || "Aviso";

    if (
      this.popupAlertOpen()
      && this.popupAlertMessage() === normalizedMessage
      && this.popupAlertTitle() === normalizedTitle
    ) {
      return Promise.resolve();
    }

    if (this.popupAlertQueue.some((row) => row.message === normalizedMessage && row.title === normalizedTitle)) {
      return Promise.resolve();
    }

    return new Promise((resolve) => {
      this.popupAlertQueue.push({ title: normalizedTitle, message: normalizedMessage, resolve });
      this.flushPopupAlertQueue();
    });
  }

  closeAlertPopup() {
    if (!this.popupAlertOpen()) return;
    this.popupAlertOpen.set(false);
    const resolver = this.popupAlertResolver;
    this.popupAlertResolver = null;
    if (resolver) resolver();
  }

  private flushPopupAlertQueue() {
    if (this.popupAlertOpen()) return;
    const next = this.popupAlertQueue.shift();
    if (!next) return;
    this.popupAlertTitle.set(next.title);
    this.popupAlertMessage.set(next.message);
    this.popupAlertOpen.set(true);
    this.popupAlertResolver = () => {
      next.resolve();
      this.flushPopupAlertQueue();
    };
  }

  private showClientaBelowCostoPopup(): Promise<void> {
    return this.showPopupAlert("Precio clienta no puede ser menor a precio costo.", "Precio invalido");
  }

  private showPopupConfirm(
    message: string,
    options: {
      title?: string;
      confirmLabel?: string;
      cancelLabel?: string;
      danger?: boolean;
    } = {},
  ): Promise<boolean> {
    const normalizedMessage = String(message || "").trim();
    if (!normalizedMessage) return Promise.resolve(false);
    const title = String(options.title || "").trim() || "Confirmar accion";
    const confirmLabel = String(options.confirmLabel || "").trim() || "Aceptar";
    const cancelLabel = String(options.cancelLabel || "").trim() || "Cancelar";
    const danger = !!options.danger;

    return new Promise((resolve) => {
      this.popupConfirmQueue.push({
        title,
        message: normalizedMessage,
        confirmLabel,
        cancelLabel,
        danger,
        resolve,
      });
      this.flushPopupConfirmQueue();
    });
  }

  closeConfirmPopup(confirmed: boolean) {
    if (!this.popupConfirmOpen()) return;
    this.popupConfirmOpen.set(false);
    const resolver = this.popupConfirmResolver;
    this.popupConfirmResolver = null;
    if (resolver) resolver(confirmed);
  }

  private flushPopupConfirmQueue() {
    if (this.popupConfirmOpen()) return;
    const next = this.popupConfirmQueue.shift();
    if (!next) return;
    this.popupConfirmTitle.set(next.title);
    this.popupConfirmMessage.set(next.message);
    this.popupConfirmConfirmLabel.set(next.confirmLabel);
    this.popupConfirmCancelLabel.set(next.cancelLabel);
    this.popupConfirmDanger.set(next.danger);
    this.popupConfirmOpen.set(true);
    this.popupConfirmResolver = (confirmed: boolean) => {
      next.resolve(confirmed);
      this.flushPopupConfirmQueue();
    };
  }

  private requiresLateAdditionNote(order: Order | null): boolean {
    if (!order) return false;
    return !this.isConfirmItemsPhase(order);
  }

  private requestLateAdditionNote(order: Order): Promise<string | null> {
    if (!this.requiresLateAdditionNote(order)) return Promise.resolve(null);
    const status = this.statusLabel(order.status) || order.status;
    return new Promise((resolve) => {
      this.lateAddNoteTitle.set("Alta fuera de flujo");
      this.lateAddNoteMessage.set(
        `Este pedido está en "${status}". Agregar un producto en esta etapa requiere nota breve para bitácora.`,
      );
      this.lateAddNoteValue.set("");
      this.lateAddNoteError.set(null);
      this.lateAddNoteModalOpen.set(true);
      this.lateAddNoteResolver = resolve;
    });
  }

  cancelLateAdditionNote() {
    if (!this.lateAddNoteModalOpen()) return;
    this.lateAddNoteModalOpen.set(false);
    this.lateAddNoteError.set(null);
    const resolver = this.lateAddNoteResolver;
    this.lateAddNoteResolver = null;
    if (resolver) resolver(null);
  }

  confirmLateAdditionNote() {
    if (!this.lateAddNoteModalOpen()) return;
    const note = String(this.lateAddNoteValue() || "").trim();
    if (note.length < 8) {
      this.lateAddNoteError.set("Escribe una nota breve (mínimo 8 caracteres).");
      return;
    }
    this.lateAddNoteModalOpen.set(false);
    this.lateAddNoteError.set(null);
    const resolver = this.lateAddNoteResolver;
    this.lateAddNoteResolver = null;
    if (resolver) resolver(note.slice(0, 280));
  }

  async markMissing(order: Order, item: OrderItem) {
    await this.detachItemFromPackages(order, item, "mark_missing");
    await this.orders.updateItemConfirmationState(order.order_id, item.item_id, "out_of_stock");
    await this.orders.updateItemState(order.order_id, item.item_id, "cancelado");
    await this.createIncidentAndRefresh(order.order_id, {
      orderId: order.order_id,
      packageId: null,
      itemId: item.item_id,
      type: "ITEM_MISSING",
      title: "Item faltante",
      severity: "high",
      reason: `Faltante en recepción: ${item.title}`,
      evidenceUrls: [],
      createdBy: "admin",
    });
    await this.orders.logEvent(order.order_id, "ITEM_MISSING", `Faltante: ${item.title}`, {
      itemId: item.item_id,
    });
    this.showActionToast(`"${item.title}" marcado como faltante.`);
  }

  async markDamaged(order: Order, item: OrderItem) {
    await this.detachItemFromPackages(order, item, "mark_damaged");
    await this.orders.updateItemConfirmationState(order.order_id, item.item_id, "out_of_stock");
    await this.orders.updateItemState(order.order_id, item.item_id, "devuelto");
    await this.createIncidentAndRefresh(order.order_id, {
      orderId: order.order_id,
      packageId: null,
      itemId: item.item_id,
      type: "ITEM_DAMAGED",
      title: "Item dañado",
      severity: "high",
      reason: `Dañado en recepción: ${item.title}`,
      evidenceUrls: [],
      createdBy: "admin",
    });
    await this.orders.logEvent(order.order_id, "ITEM_DAMAGED", `Dañado: ${item.title}`, {
      itemId: item.item_id,
    });
    this.showActionToast(`"${item.title}" marcado como dañado.`);
  }

  private packageStatus(pkg: PackageRecord): "open" | "closed" {
    const status = String((pkg as any).status || "").toLowerCase();
    if (status === "open" || status === "closed") return status;
    const state = String((pkg as any).state || "").toLowerCase();
    if (state === "open") return "open";
    if (state === "closed" || state === "en_ruta" || state === "entregado") return "closed";
    if ((pkg as any).closed_at) return "closed";
    return "closed";
  }

  private packageItems(pkg: PackageRecord): Array<{
    orderItemId: string;
    name: string;
    qty: number;
    variant?: string | null;
    size?: string | null;
    color?: string | null;
    imageUrl?: string | null;
  }> {
    const raw = (pkg as any).items;
    if (Array.isArray(raw) && raw.length > 0) {
      return raw
        .map((entry: any) => ({
          orderItemId: String(entry.orderItemId || entry.order_item_id || ""),
          name: String(entry.name || ""),
          qty: Math.max(0, Number(entry.qty || 0)),
          variant: entry.variant ?? null,
          size: entry.size ?? null,
          color: entry.color ?? null,
          imageUrl: entry.imageUrl ?? entry.image_url ?? null,
        }))
        .filter((entry: any) => entry.orderItemId && entry.qty > 0);
    }
    return Array.isArray(pkg.item_ids)
      ? pkg.item_ids.map((itemId) => ({ orderItemId: itemId, name: "", qty: 1 }))
      : [];
  }

  private buildPackageItem(order: Order, item: OrderItem, qty: number) {
    return {
      orderItemId: item.item_id,
      name: item.title,
      qty,
      variant: item.variant ?? null,
      size: null,
      color: item.color ?? null,
      imageUrl: this.itemImage(item),
    };
  }

  private packageHasItems(pkg: PackageRecord): boolean {
    return this.packageItems(pkg).some((entry) => entry.qty > 0);
  }

  private patchPackage(pkg: PackageRecord, patch: Partial<PackageRecord> & Record<string, any>): PackageRecord {
    const merged = { ...pkg, ...patch } as PackageRecord;
    const items = this.packageItems(merged);
    return {
      ...merged,
      item_ids: items.filter((entry) => entry.qty > 0).map((entry) => entry.orderItemId),
      items,
    } as PackageRecord;
  }

  openPackingBoxes(order: Order | null): PackageRecord[] {
    if (!order) return [];
    return (order.packages || [])
      .filter((pkg) => this.packageStatus(pkg) === "open")
      .sort((a, b) => {
        const aDate = new Date(a.created_at).getTime();
        const bDate = new Date(b.created_at).getTime();
        return aDate - bDate;
      });
  }

  private packingBoxesOrdered(order: Order | null): PackageRecord[] {
    if (!order) return [];
    return [...(order.packages || [])].sort((a, b) => {
      const aDate = new Date(a.created_at).getTime();
      const bDate = new Date(b.created_at).getTime();
      return aDate - bDate;
    });
  }

  packingBoxNumber(order: Order | null, pkg: PackageRecord | null): number | null {
    if (!order || !pkg) return null;
    const ordered = this.packingBoxesOrdered(order);
    const idx = ordered.findIndex((row) => row.package_id === pkg.package_id);
    return idx >= 0 ? idx + 1 : null;
  }

  private totalPackingBoxes(order: Order | null): number {
    return this.packingBoxesOrdered(order).length;
  }

  openPackingBox(order: Order | null): PackageRecord | null {
    const boxes = this.openPackingBoxes(order);
    return boxes.length ? boxes[0] : null;
  }

  activeOpenBox(order: Order | null): PackageRecord | null {
    const boxes = this.openPackingBoxes(order);
    if (!boxes.length) return null;
    const selectedId = this.activeOpenBoxId();
    const selected = selectedId ? boxes.find((pkg) => pkg.package_id === selectedId) || null : null;
    if (selected) return selected;
    return boxes[0];
  }

  activeOpenBoxNumber(order: Order | null): number | null {
    const active = this.activeOpenBox(order);
    if (!active) return null;
    return this.packingBoxNumber(order, active);
  }

  setActiveOpenBox(packageId: string) {
    this.activeOpenBoxId.set(packageId);
  }

  closePackingMenus() {
    this.openBoxMenuId.set(null);
  }

  toggleOpenBoxMenu(packageId: string) {
    this.openBoxMenuId.update((current) => (current === packageId ? null : packageId));
  }

  toggleMoveMode(packageId: string) {
    this.moveModeBoxId.update((current) => (current === packageId ? null : packageId));
    this.closePackingMenus();
  }

  isMoveMode(packageId: string): boolean {
    return this.moveModeBoxId() === packageId;
  }

  closedPackingBoxes(order: Order | null): PackageRecord[] {
    if (!order) return [];
    return (order.packages || [])
      .filter((pkg) => this.packageStatus(pkg) === "closed")
      .sort((a, b) => {
        const aDate = new Date((a as any).closed_at || a.created_at).getTime();
        const bDate = new Date((b as any).closed_at || b.created_at).getTime();
        return aDate - bDate;
      });
  }

  packingItemsInBox(order: Order, pkg: PackageRecord): Array<{ item: OrderItem; qty: number }> {
    const byItemId = new Map((order.items || []).map((item) => [item.item_id, item]));
    return this.packageItems(pkg)
      .map((entry) => ({ entry, item: byItemId.get(entry.orderItemId) || null }))
      .filter((row) => !!row.item && row.entry.qty > 0)
      .map((row) => ({ item: row.item as OrderItem, qty: row.entry.qty }));
  }

  private packedQtyByItem(order: Order): Map<string, number> {
    const map = new Map<string, number>();
    for (const pkg of order.packages || []) {
      for (const entry of this.packageItems(pkg)) {
        map.set(entry.orderItemId, (map.get(entry.orderItemId) || 0) + entry.qty);
      }
    }
    return map;
  }

  private itemPackedQty(order: Order, itemId: string): number {
    return this.packedQtyByItem(order).get(itemId) || 0;
  }

  unpackedItems(order: Order | null): Array<{ item: OrderItem; qty: number }> {
    if (!order) return [];
    const packedMap = this.packedQtyByItem(order);
    return this.confirmedItems(order)
      .filter((item) => this.isItemReadyForPack(order, item))
      .map((item) => {
        const confirmed = Math.max(0, this.confirmedQty(item));
        const packed = packedMap.get(item.item_id) || 0;
        return { item, qty: Math.max(0, confirmed - packed) };
      })
      .filter((row) => row.qty > 0);
  }

  unpackedCount(order: Order | null): number {
    return this.unpackedItems(order).reduce((sum, row) => sum + row.qty, 0);
  }

  canCreateNewBox(order: Order): boolean {
    return this.unpackedCount(order) > 0;
  }

  async createPackage(order: Order | null) {
    if (!order || this.packingBusy()) return;
    this.packingBusy.set(true);
    try {
      const pkg: PackageRecord = {
        package_id: `pack-${Date.now()}`,
        label: "Caja abierta",
        sequence: 0,
        total_packages: 0,
        state: "open" as any,
        amount_due: null,
        item_ids: [],
        created_at: new Date().toISOString(),
        status: "open",
        items: [],
      } as PackageRecord;
      await this.orders.addPackage(order.order_id, pkg);
      this.activeOpenBoxId.set(pkg.package_id);
      this.postPackingEvent(order.order_id, "package_created", "Nueva caja abierta", {
        packageId: pkg.package_id,
      });
      this.showActionToast("Nueva caja creada.");
    } finally {
      this.packingBusy.set(false);
    }
  }

  private async updatePackageItemQty(order: Order, packageId: string, item: OrderItem, qtyDelta: number) {
    const packages = (order.packages || []).map((pkg) => {
      if (pkg.package_id !== packageId) return pkg;
      const items = [...this.packageItems(pkg)];
      const matchingIdx = items
        .map((entry, idx) => ({ entry, idx }))
        .filter((row) => row.entry.orderItemId === item.item_id)
        .map((row) => row.idx);
      const totalCurrent = matchingIdx.reduce((sum, idx) => sum + (items[idx].qty || 0), 0);
      const nextTotal = totalCurrent + qtyDelta;

      if (matchingIdx.length > 0) {
        for (let i = matchingIdx.length - 1; i >= 0; i--) items.splice(matchingIdx[i], 1);
      }

      if (nextTotal > 0) {
        items.push(this.buildPackageItem(order, item, nextTotal));
      }
      return this.patchPackage(pkg, { items });
    });
    await this.orders.updatePackages(order.order_id, packages);
  }

  private buildPackagesAfterMove(
    order: Order,
    fromPackageId: string,
    orderItemId: string,
    qty: number,
    toPackageId: string | null,
  ): PackageRecord[] {
    const sourcePkg = (order.packages || []).find((pkg) => pkg.package_id === fromPackageId) || null;
    const sourceEntry = sourcePkg
      ? this.packageItems(sourcePkg).find((entry) => entry.orderItemId === orderItemId) || null
      : null;
    const sourceItem = (order.items || []).find((row) => row.item_id === orderItemId) || null;
    const buildMovedEntry = (nextQty: number) => ({
      orderItemId,
      name: sourceEntry?.name || sourceItem?.title || "Producto",
      qty: nextQty,
      variant: sourceEntry?.variant ?? sourceItem?.variant ?? null,
      size: sourceEntry?.size ?? null,
      color: sourceEntry?.color ?? sourceItem?.color ?? null,
      imageUrl: sourceEntry?.imageUrl ?? sourceItem?.image_url ?? (sourceItem ? this.itemImage(sourceItem) : null) ?? null,
    });

    const updated = (order.packages || []).map((pkg) => {
      if (pkg.package_id !== fromPackageId && pkg.package_id !== toPackageId) return pkg;
      const items = [...this.packageItems(pkg)];
      const matchingIdx = items
        .map((entry, idx) => ({ entry, idx }))
        .filter((row) => row.entry.orderItemId === orderItemId)
        .map((row) => row.idx);
      const totalCurrent = matchingIdx.reduce((sum, idx) => sum + (items[idx].qty || 0), 0);

      if (matchingIdx.length > 0) {
        for (let i = matchingIdx.length - 1; i >= 0; i--) items.splice(matchingIdx[i], 1);
      }

      if (pkg.package_id === fromPackageId) {
        const nextQty = totalCurrent - qty;
        if (nextQty > 0) {
          items.push(buildMovedEntry(nextQty));
        }
      }

      if (toPackageId && pkg.package_id === toPackageId) {
        const nextQty = totalCurrent + qty;
        if (nextQty > 0) items.push(buildMovedEntry(nextQty));
      }

      return this.patchPackage(pkg, { items });
    });
    return updated.filter((pkg) => !(this.packageStatus(pkg) === "open" && !this.packageHasItems(pkg)));
  }

  private patchPackageItemByDelta(
    order: Order,
    pkg: PackageRecord,
    orderItemId: string,
    qtyDelta: number,
    seed?: { name?: string | null; variant?: string | null; size?: string | null; color?: string | null; imageUrl?: string | null } | null,
  ): PackageRecord {
    const entries = [...this.packageItems(pkg)];
    const matching = entries.filter((entry) => entry.orderItemId === orderItemId);
    const currentTotal = matching.reduce((sum, entry) => sum + (entry.qty || 0), 0);
    const nextTotal = currentTotal + qtyDelta;
    const base = matching[0] || null;
    const orderItem = (order.items || []).find((it) => it.item_id === orderItemId) || null;
    const next = entries.filter((entry) => entry.orderItemId !== orderItemId);
    if (nextTotal > 0) {
      next.push({
        orderItemId,
        name: seed?.name || base?.name || orderItem?.title || "Producto",
        qty: nextTotal,
        variant: seed?.variant ?? base?.variant ?? orderItem?.variant ?? null,
        size: seed?.size ?? base?.size ?? null,
        color: seed?.color ?? base?.color ?? orderItem?.color ?? null,
        imageUrl: seed?.imageUrl ?? base?.imageUrl ?? orderItem?.image_url ?? (orderItem ? this.itemImage(orderItem) : null) ?? null,
      });
    }
    return this.patchPackage(pkg, { items: next });
  }

  private syncActiveOpenBoxAfterPackages(packages: PackageRecord[], preferredId?: string | null) {
    const open = packages
      .filter((pkg) => this.packageStatus(pkg) === "open")
      .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
    if (!open.length) {
      this.activeOpenBoxId.set(null);
      return;
    }
    if (preferredId && open.some((pkg) => pkg.package_id === preferredId)) {
      this.activeOpenBoxId.set(preferredId);
      return;
    }
    const current = this.activeOpenBoxId();
    if (current && open.some((pkg) => pkg.package_id === current)) return;
    this.activeOpenBoxId.set(open[0].package_id);
  }

  async addItemToOpenBox(order: Order, row: { item: OrderItem; qty: number }, selectedQty?: number) {
    if (this.packingBusy()) return;
    let activeOrder = order;
    let open = this.activeOpenBox(activeOrder);
    if (!open) {
      this.pendingAddItemId.set(row.item.item_id);
      this.createBoxConfirmOpen.set(true);
      return;
    }
    if (selectedQty === undefined && row.qty > 1) {
      this.qtyPickerItemId.set(row.item.item_id);
      this.qtyPickerItemTitle.set(row.item.title);
      this.qtyPickerMax.set(Math.max(1, Math.floor(row.qty)));
      this.qtyPickerValue.set(Math.max(1, Math.floor(row.qty)));
      this.qtyPickerOpen.set(true);
      return;
    }
    const qty = Math.max(1, Math.min(row.qty, Math.floor(selectedQty ?? 1)));
    if (qty <= 0) return;
    this.packingBusy.set(true);
    try {
      await this.updatePackageItemQty(activeOrder, open.package_id, row.item, qty);
      this.postPackingEvent(activeOrder.order_id, "package_item_added", "Producto agregado a caja", {
        packageId: open.package_id,
        orderItemId: row.item.item_id,
        qty,
      });
      this.showActionToast("Agregado a caja.");
    } finally {
      this.packingBusy.set(false);
    }
  }

  closeQtyPicker() {
    this.qtyPickerOpen.set(false);
    this.qtyPickerItemId.set(null);
    this.qtyPickerItemTitle.set("");
    this.qtyPickerMax.set(1);
    this.qtyPickerValue.set(1);
  }

  onQtyPickerChange(raw: string | number) {
    const numeric = typeof raw === "number" ? raw : Number(raw ?? "");
    if (!Number.isFinite(numeric)) {
      this.qtyPickerValue.set(1);
      return;
    }
    const max = Math.max(1, Math.floor(this.qtyPickerMax()));
    this.qtyPickerValue.set(Math.max(1, Math.min(max, Math.floor(numeric))));
  }

  async confirmQtyPicker(order: Order) {
    const targetId = this.qtyPickerItemId();
    const qty = this.qtyPickerValue();
    this.closeQtyPicker();
    if (!targetId) return;
    const current = this.order();
    if (!current || current.order_id !== order.order_id) return;
    const row = this.unpackedItems(current).find((entry) => entry.item.item_id === targetId);
    if (!row) return;
    await this.addItemToOpenBox(current, row, qty);
  }

  closeCreateBoxConfirm() {
    this.createBoxConfirmOpen.set(false);
    this.pendingAddItemId.set(null);
  }

  async confirmCreateBoxAndAdd(order: Order) {
    const pendingItemId = this.pendingAddItemId();
    this.closeCreateBoxConfirm();
    if (!pendingItemId) return;
    if (this.packingBusy()) return;
    await this.createPackage(order);
    const current = this.order();
    if (!current) return;
    const pendingRow = this.unpackedItems(current).find((row) => row.item.item_id === pendingItemId);
    if (!pendingRow) return;
    await this.addItemToOpenBox(current, pendingRow);
  }

  openMoveSheet(pkg: PackageRecord, item: OrderItem, qty?: number) {
    this.moveSheetPackageId.set(pkg.package_id);
    this.moveSheetItemId.set(item.item_id);
    const normalizedQty = Number.isFinite(Number(qty)) ? Math.max(1, Math.floor(Number(qty))) : 1;
    this.moveSheetQty.set(normalizedQty);
    this.moveSheetOpen.set(true);
  }

  closeMoveSheet() {
    this.moveSheetOpen.set(false);
    this.moveSheetPackageId.set(null);
    this.moveSheetItemId.set(null);
    this.moveSheetQty.set(1);
  }

  moveSheetItem(order: Order | null): { pkg: PackageRecord; item: OrderItem; qty: number } | null {
    const selection = this.moveSheetSelection(order);
    if (!selection) return null;
    const { pkg, itemId, qty } = selection;
    const baseItem = selection.item;
    const baseEntry = selection.entry;
    const item = baseItem || ({
      item_id: itemId,
      title: baseEntry?.name || "Producto",
      quantity: qty,
      source: "catalogo",
      state: "empaque",
      variant: baseEntry?.variant ?? null,
      color: baseEntry?.color ?? null,
      image_url: baseEntry?.imageUrl ?? null,
    } as OrderItem);
    return { pkg, item, qty };
  }

  private moveSheetSelection(
    order: Order | null,
  ): { pkg: PackageRecord; itemId: string; qty: number; entry: any | null; item: OrderItem | null } | null {
    if (!order) return null;
    const pkgId = this.moveSheetPackageId();
    const itemId = this.moveSheetItemId();
    if (!pkgId || !itemId) return null;
    const pkg = (order.packages || []).find((row) => row.package_id === pkgId) || null;
    if (!pkg) return null;
    const entry = this.packageItems(pkg).find((row) => row.orderItemId === itemId) || null;
    if (!entry || entry.qty <= 0) return null;
    const item = (order.items || []).find((row) => row.item_id === itemId) || null;
    return { pkg, itemId, qty: entry.qty, entry, item };
  }

  setMoveSheetQty(raw: string | number, maxQty: number) {
    const numeric = typeof raw === "number" ? raw : Number(raw ?? "");
    if (!Number.isFinite(numeric)) {
      this.moveSheetQty.set(1);
      return;
    }
    const max = Math.max(1, Math.floor(maxQty));
    this.moveSheetQty.set(Math.max(1, Math.min(max, Math.floor(numeric))));
  }

  moveSheetTargetBoxes(order: Order | null): PackageRecord[] {
    if (!order) return [];
    const sourceId = this.moveSheetPackageId();
    return this.openPackingBoxes(order).filter((pkg) => pkg.package_id !== sourceId);
  }

  async moveItemToUnpacked(order: Order) {
    const currentOrder = this.order();
    if (!currentOrder || currentOrder.order_id !== order.order_id) return;
    const selection = this.moveSheetSelection(currentOrder);
    if (!selection || this.packingBusy()) return;
    const qty = Math.max(1, Math.min(selection.qty, Math.floor(this.moveSheetQty())));
    if (qty <= 0) return;
    const sourceEntries = this.packageItems(selection.pkg);
    const willEmptySource = qty >= selection.qty && sourceEntries.length === 1;
    if (willEmptySource) {
      this.closeMoveSheet();
      await this.deleteOpenPackage(currentOrder, selection.pkg);
      return;
    }
    this.packingBusy.set(true);
    try {
      const packages = this.buildPackagesAfterMove(currentOrder, selection.pkg.package_id, selection.itemId, qty, null);
      await this.orders.updatePackages(currentOrder.order_id, packages);
      this.syncActiveOpenBoxAfterPackages(packages, this.activeOpenBoxId());
      this.postPackingEvent(currentOrder.order_id, "package_item_removed", "Producto sacado de caja", {
        packageId: selection.pkg.package_id,
        orderItemId: selection.itemId,
        qty,
      });
      this.showActionToast("Producto devuelto a sin empacar.");
      this.closeMoveSheet();
    } finally {
      this.packingBusy.set(false);
    }
  }

  async moveItemToOpenBox(order: Order, targetPackageId: string) {
    const currentOrder = this.order();
    if (!currentOrder || currentOrder.order_id !== order.order_id) return;
    const selection = this.moveSheetSelection(currentOrder);
    if (!selection || this.packingBusy()) return;
    if (selection.pkg.package_id === targetPackageId) return;
    const target = this.openPackingBoxes(currentOrder).find((pkg) => pkg.package_id === targetPackageId) || null;
    if (!target) return;
    const qty = Math.max(1, Math.min(selection.qty, Math.floor(this.moveSheetQty())));
    if (qty <= 0) return;
    const sourceEntries = this.packageItems(selection.pkg);
    const willEmptySource = qty >= selection.qty && sourceEntries.length === 1;
    this.packingBusy.set(true);
    try {
      let packages: PackageRecord[];
      if (willEmptySource) {
        const seed = selection.entry
          ? {
              name: selection.entry.name,
              variant: selection.entry.variant ?? null,
              size: selection.entry.size ?? null,
              color: selection.entry.color ?? null,
              imageUrl: selection.entry.imageUrl ?? null,
            }
          : null;
        packages = (currentOrder.packages || [])
          .filter((pkg) => pkg.package_id !== selection.pkg.package_id)
          .map((pkg) =>
            pkg.package_id === target.package_id
              ? this.patchPackageItemByDelta(currentOrder, pkg, selection.itemId, qty, seed)
              : pkg,
          );
      } else {
        packages = this.buildPackagesAfterMove(currentOrder, selection.pkg.package_id, selection.itemId, qty, target.package_id);
      }
      await this.orders.updatePackages(currentOrder.order_id, packages);
      this.syncActiveOpenBoxAfterPackages(packages, target.package_id);
      this.postPackingEvent(currentOrder.order_id, "package_item_moved", "Producto movido entre cajas", {
        fromPackageId: selection.pkg.package_id,
        toPackageId: target.package_id,
        orderItemId: selection.itemId,
        qty,
      });
      this.showActionToast("Producto movido de caja.");
      this.closeMoveSheet();
    } finally {
      this.packingBusy.set(false);
    }
  }

  requestMoveFromPackage(order: Order, pkg: PackageRecord) {
    if (this.packingItemsInBox(order, pkg).length === 0) return;
    this.toggleMoveMode(pkg.package_id);
  }

  async closePackage(order: Order, pkg: PackageRecord) {
    if (this.packingBusy()) return;
    if (!this.packageHasItems(pkg)) {
      this.actionError.set("No puedes cerrar una caja vacia.");
      return;
    }
    this.packingBusy.set(true);
    try {
      const closedAt = new Date().toISOString();
      const qr = `QR:${order.order_id}:${pkg.package_id}:${Date.now()}`;
      const packages = (order.packages || []).map((row) =>
        row.package_id === pkg.package_id
          ? this.patchPackage(row, {
              status: "closed",
              state: "closed",
              closed_at: closedAt,
              label_qr: qr,
            })
          : row,
      );
      await this.orders.updatePackages(order.order_id, packages);
      this.postPackingEvent(order.order_id, "package_closed", "Caja cerrada", {
        packageId: pkg.package_id,
      });
      if (this.activeOpenBoxId() === pkg.package_id) this.activeOpenBoxId.set(null);
      this.showActionToast("Caja cerrada.");
    } finally {
      this.packingBusy.set(false);
    }
  }

  async reopenPackage(order: Order, pkg: PackageRecord) {
    if (this.packingBusy()) return;
    this.packingBusy.set(true);
    try {
      const packages = (order.packages || []).map((row) =>
        row.package_id === pkg.package_id
          ? this.patchPackage(row, {
              status: "open",
              state: "open",
              closed_at: null,
            })
          : row,
      );
      await this.orders.updatePackages(order.order_id, packages);
      this.activeOpenBoxId.set(pkg.package_id);
      this.postPackingEvent(order.order_id, "package_reopened", "Caja reabierta", {
        packageId: pkg.package_id,
      });
      this.showActionToast("Caja reabierta.");
    } finally {
      this.packingBusy.set(false);
    }
  }

  async deleteOpenPackage(order: Order, pkg: PackageRecord) {
    if (this.packingBusy()) return;
    if (this.packageStatus(pkg) !== "open") return;
    const hasItems = this.packageHasItems(pkg);
    this.packingBusy.set(true);
    try {
      const packages = (order.packages || []).filter((row) => row.package_id !== pkg.package_id);
      await this.orders.updatePackages(order.order_id, packages);
      if (this.activeOpenBoxId() === pkg.package_id) this.activeOpenBoxId.set(null);
      this.postPackingEvent(order.order_id, "package_deleted", "Caja abierta eliminada", {
        packageId: pkg.package_id,
        hadItems: hasItems,
      });
      this.actionError.set(null);
      this.showActionToast(hasItems ? "Caja eliminada. Productos devueltos a sin empacar." : "Caja eliminada.");
    } finally {
      this.packingBusy.set(false);
    }
  }

  private postPackingEvent(orderId: string, type: string, message: string, meta?: any) {
    void (async () => {
      try {
        await this.orders.logEvent(orderId, type, message, meta);
        await this.refreshEvents();
      } catch (error) {
        console.warn("[pedido-detalle] No se pudo registrar/refrescar evento de empaque", { orderId, type, error });
      }
    })();
  }

  requestDeleteOpenPackage(order: Order, pkg: PackageRecord) {
    if (this.packingBusy()) return;
    if (this.packageStatus(pkg) !== "open") return;
    if (!this.packageHasItems(pkg)) {
      void this.deleteOpenPackage(order, pkg);
      return;
    }
    this.deletePackageTargetId.set(pkg.package_id);
    this.deletePackageConfirmOpen.set(true);
  }

  closeDeletePackageConfirm() {
    this.deletePackageConfirmOpen.set(false);
    this.deletePackageTargetId.set(null);
  }

  async confirmDeletePackageWithItems(order: Order) {
    const packageId = this.deletePackageTargetId();
    if (!packageId) return;
    const pkg = (order.packages || []).find((row) => row.package_id === packageId) || null;
    this.closeDeletePackageConfirm();
    if (!pkg) return;
    await this.deleteOpenPackage(order, pkg);
  }

  closedBoxLabel(order: Order, pkg: PackageRecord): string {
    const boxNumber = this.packingBoxNumber(order, pkg);
    const total = this.totalPackingBoxes(order);
    if (!boxNumber || total <= 0) return "1/1";
    return `${boxNumber}/${total}`;
  }

  closedBoxTitle(order: Order, pkg: PackageRecord): string {
    const boxNumber = this.packingBoxNumber(order, pkg);
    return `Caja ${boxNumber ?? 1}`;
  }

  isClosedBoxExpanded(pkg: PackageRecord): boolean {
    return !!this.expandedClosedBoxes()[pkg.package_id];
  }

  toggleClosedBox(pkg: PackageRecord) {
    this.expandedClosedBoxes.update((current) => ({
      ...current,
      [pkg.package_id]: !current[pkg.package_id],
    }));
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

  plannedPackages(order: Order | null): number | null {
    if (!order) return null;
    const planned = order.planned_packages;
    if (planned === null || planned === undefined) return null;
    return Math.max(1, Number(planned));
  }

  requiresPlannedPackages(order: Order | null): boolean {
    if (!order) return false;
    if (["cancelado", "devuelto"].includes(order.status)) return false;
    const planned = this.plannedPackages(order);
    if (planned !== null) return false;
    return this.statusRank(order.status) >= this.statusRank("recibido_qa");
  }

  openPlannedPackages() {
    const order = this.order();
    if (!order) return;
    const max = this.maxAllowedPlannedPackages(order);
    const current = this.plannedPackages(order) ?? 1;
    this.plannedPackagesInput.set(Math.max(1, Math.min(max, current)));
    this.plannedModalOpen.set(true);
  }

  async savePlannedPackages() {
    const order = this.order();
    if (!order) return;
    const max = this.maxAllowedPlannedPackages(order);
    const planned = Math.max(1, Math.min(max, Number(this.plannedPackagesInput() || 1)));
    this.plannedPackagesInput.set(planned);
    await this.orders.updatePlannedPackages(order.order_id, planned);
    this.plannedModalOpen.set(false);
  }

  maxAllowedPlannedPackages(order: Order | null): number {
    if (!order) return 1;
    return Math.max(1, (order.items || []).length);
  }

  normalizePlannedPackagesInput(rawValue: number | string | null | undefined, order: Order | null) {
    const max = this.maxAllowedPlannedPackages(order);
    const numeric = Number(rawValue);
    const safe = Number.isFinite(numeric) ? numeric : 1;
    this.plannedPackagesInput.set(Math.max(1, Math.min(max, Math.trunc(safe))));
  }

  closePlannedPackages() {
    this.plannedModalOpen.set(false);
  }

  openAddItemModal() {
    this.resetAddItemForm();
    this.addItemMode.set("add");
    this.addItemModalOpen.set(true);
  }

  openConvertItemModal(item: OrderItem) {
    if (item.source !== "manual") return;
    this.resetAddItemForm();
    this.addItemMode.set("convert");
    this.convertTargetItemId.set(item.item_id);
    this.newItemSource.set("catalogo");
    this.newItemTitle.set(item.title || "");
    this.newItemVariant.set(item.variant || "");
    this.newItemColor.set(item.color || "");
    this.newItemQty.set(Math.max(1, this.itemQuantity(item)));
    this.newItemPricePublic.set(item.price_public ?? null);
    this.newItemPriceClienta.set(item.price_clienta ?? null);
    this.newItemPriceCost.set(item.price_cost ?? null);
    this.updatePriceDraftFromSignals();
    this.addItemModalOpen.set(true);
  }

  openEditItemModal(item: OrderItem) {
    const currentOrder = this.order();
    if (!currentOrder || !this.canEditItems(currentOrder)) return;
    this.closeProductMenus();
    this.resetAddItemForm();
    this.addItemMode.set("edit");
    this.editTargetItemId.set(item.item_id);
    this.newItemSource.set(item.source);
    this.newItemTitle.set(item.title || "");
    this.newItemVariant.set(item.variant || "");
    this.newItemColor.set(item.color || "");
    this.newItemQty.set(Math.max(1, this.itemQuantity(item)));
    this.newItemPricePublic.set(item.price_public ?? null);
    this.newItemPriceClienta.set(item.price_clienta ?? null);
    this.newItemPriceCost.set(item.price_cost ?? null);
    this.newItemInventoryId.set(item.inventory_id || null);
    this.newItemSupplierId.set(item.supplier_id || null);
    this.newItemProductId.set(item.product_id || null);
    this.updatePriceDraftFromSignals();
    this.selectedPreviewHasColorImage.set(Boolean(item.image_url));
    this.selectedPreview.set({
      title: item.title || "Producto",
      variant: item.variant || "",
      color: item.color || "",
      image: item.image_url || null,
      source: item.source === "inventario" ? "Inventario" : item.source === "catalogo" ? "Catalogo" : "Manual",
    });
    this.addItemModalOpen.set(true);
  }

  closeAddItemModal() {
    this.resetAddItemForm();
    this.addItemModalOpen.set(false);
  }

  private resetAddItemForm() {
    this.addItemMode.set("add");
    this.convertTargetItemId.set(null);
    this.editTargetItemId.set(null);
    this.newItemSource.set("catalogo");
    this.newItemTitle.set("");
    this.newItemVariant.set("");
    this.newItemColor.set("");
    this.newItemQty.set(1);
    this.newItemPricePublic.set(null);
    this.newItemPriceCost.set(null);
    this.newItemPriceClienta.set(null);
    this.priceInputFocused.set(null);
    this.priceInputDraft.set({ final: "", clienta: "", costo: "" });
    this.supplierDiscountPct.set(null);
    this.supplierDiscountLabel.set(null);
    this.newItemSearch.set("");
    this.newItemInventoryId.set(null);
    this.newItemSupplierId.set(null);
    this.newItemProductId.set(null);
    this.lockItemFields.set(false);
    this.catalogVariantOptions.set([]);
    this.catalogColorOptions.set([]);
    this.selectedPreview.set(null);
    this.selectedCatalogDoc.set(null);
    this.selectedPreviewHasColorImage.set(true);
    this.showProductList.set(false);
  }

  onNewItemSourceChange(source: string) {
    if (this.isEditMode()) return;
    if (this.isConvertMode() && source === "manual") return;
    const normalized = source === "inventario" || source === "manual" ? source : "catalogo";
    if (normalized === this.newItemSource()) return;
    this.newItemSource.set(normalized);
    this.clearAddItemDraftForSourceChange();
  }

  private clearAddItemDraftForSourceChange() {
    this.newItemTitle.set("");
    this.newItemVariant.set("");
    this.newItemColor.set("");
    this.newItemQty.set(1);
    this.newItemPricePublic.set(null);
    this.newItemPriceCost.set(null);
    this.newItemPriceClienta.set(null);
    this.priceInputFocused.set(null);
    this.priceInputDraft.set({ final: "", clienta: "", costo: "" });
    this.supplierDiscountPct.set(null);
    this.supplierDiscountLabel.set(null);
    this.newItemSearch.set("");
    this.newItemInventoryId.set(null);
    this.newItemSupplierId.set(null);
    this.newItemProductId.set(null);
    this.showProductList.set(false);
    this.lockItemFields.set(false);
    this.catalogVariantOptions.set([]);
    this.catalogColorOptions.set([]);
    this.selectedPreview.set(null);
    this.selectedCatalogDoc.set(null);
    this.selectedPreviewHasColorImage.set(true);
  }

  canSubmitNewItem(): boolean {
    if (this.isEditMode()) return !!this.editTargetItem();
    if (this.isConvertMode()) return this.newItemSource() !== "manual" && !!this.selectedPreview();
    return this.isManualSource() || !!this.selectedPreview();
  }

  async submitItemForm(order: Order | null) {
    if (this.isEditMode()) {
      await this.updateExistingItem(order);
      return;
    }
    if (this.isConvertMode()) {
      await this.convertManualItem(order);
      return;
    }
    await this.addItem(order);
  }

  packageDisplayLabel(order: Order, pkg: PackageRecord): string {
    if (this.packageStatus(pkg) === "closed") return this.closedBoxTitle(order, pkg);
    return "Caja abierta";
  }

  salesNoteRows(order: Order): SalesNoteRowVm[] {
    return (order.items || [])
      .filter((item) => !["cancelado", "devuelto"].includes(item.state))
      .map((item) => {
        const qty = item.confirmation_state === "confirmed" ? this.confirmedQty(item) : 0;
        const unitPrice = item.price_clienta ?? item.price_public ?? 0;
        return {
          item,
          qty,
          unitPrice,
          lineTotal: unitPrice * qty,
          imageUrl: this.itemImage(item),
        };
      })
      .filter((row) => row.qty > 0);
  }

  canGenerateSalesNote(order: Order | null): boolean {
    if (!order) return false;
    // Disponible en cualquier estado desde que hay ítems confirmados con cantidad > 0.
    // No esperamos a empaque ni a ruta — el usuario puede necesitarla al cerrar caja.
    return this.salesNoteRows(order).length > 0;
  }

  async generateSalesNote(order: Order) {
    if (this.generatingSalesNote()) return;
    const rows = this.salesNoteRows(order);
    if (rows.length <= 0) {
      this.actionError.set("No hay productos confirmados para generar nota.");
      return;
    }

    this.generatingSalesNote.set(true);
    try {
      await this.withTimeout(
        this.ensureSalesNoteImageSourcesReady(),
        15000,
        "Tiempo de espera agotado al preparar fuentes de imagen.",
      );
      const fileName = `nota-${order.order_id}-${Date.now()}.png`;
      const blob = await this.withTimeout(
        this.buildSalesNoteImage(order, rows),
        60000,
        "Tiempo de espera agotado al generar la nota.",
      );
      const shared = await this.tryShareSalesNote(blob, fileName, order);
      if (!shared) {
        this.downloadBlob(blob, fileName);
      }
      await this.orders.logEvent(order.order_id, "SALES_NOTE_GENERATED", "Nota de venta generada", {
        rows: rows.length,
        total: rows.reduce((sum, row) => sum + row.lineTotal, 0),
        shared,
      }).catch(() => null);
      this.showActionToast(shared ? "Nota generada y lista para compartir." : "Nota generada.");
      this.actionError.set(null);
    } catch (error: any) {
      this.actionError.set(error?.message || "No se pudo generar la nota.");
      this.showActionToast("No se pudo generar la nota.");
    } finally {
      this.generatingSalesNote.set(false);
    }
  }

  private async ensureSalesNoteImageSourcesReady(): Promise<void> {
    const tasks: Promise<void>[] = [];

    if (!this.inventoryLoaded() || this.inventory.items().length === 0) {
      tasks.push(
        this.inventory
          .loadFromFirestore()
          .catch(() => undefined)
          .then(() => {
            this.inventoryLoaded.set(true);
          }),
      );
    }

    if (!this.catalogLoaded() || this.catalogRows().length === 0) {
      tasks.push(
        this.catalog
          .listValidated(120)
          .then((page) => {
            this.catalogRows.set(page.docs);
            this.catalogLoaded.set(true);
          })
          .catch(() => undefined),
      );
    }

    if (tasks.length > 0) {
      await Promise.all(tasks);
    }
  }

  private async buildSalesNoteImage(order: Order, rows: SalesNoteRowVm[]): Promise<Blob> {
    const width = 1080;
    const cardX = 40;
    const cardY = 34;
    const cardW = width - (cardX * 2);
    const cardPaddingX = 28;
    const cardPaddingTop = 38;
    const cardPaddingBottom = 34;
    const titleBlockHeight = 148;
    const tableHeaderHeight = 56;
    const rowHeight = 106;
    const rowGap = 12;
    const footerGap = 22;
    const footerHeight = 98;
    const rowsHeight = rows.length > 0 ? (rows.length * rowHeight) + ((rows.length - 1) * rowGap) : 0;
    const cardH = cardPaddingTop
      + titleBlockHeight
      + 16
      + tableHeaderHeight
      + 16
      + rowsHeight
      + footerGap
      + footerHeight
      + cardPaddingBottom;
    const height = (cardY * 2) + cardH;

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("No se pudo crear el lienzo para la nota.");

    ctx.fillStyle = "#f2f5fa";
    ctx.fillRect(0, 0, width, height);

    this.drawRoundedRect(ctx, cardX, cardY, cardW, cardH, 34, "#ffffff");
    ctx.fill();

    const customer = this.customerName(order);
    const dateText = new Date().toLocaleDateString("es-MX", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    const total = rows.reduce((sum, row) => sum + row.lineTotal, 0);
    const cardInnerX = cardX + cardPaddingX;
    const cardInnerW = cardW - (cardPaddingX * 2);
    const productColumnX = cardX + 136;
    const qtyColumnX = cardX + 612;
    const unitColumnX = cardX + 802;
    const totalColumnX = cardX + cardW - 56;
    const imageByItemId = new Map<string, HTMLImageElement | null>();
    const imageResults = await Promise.all(rows.map((row) => this.loadSalesNoteRowImage(row)));
    for (const result of imageResults) {
      imageByItemId.set(result.itemId, result.image);
    }
    const missingDownloads = imageResults.filter((result) => result.hasCandidates && !result.image);
    if (missingDownloads.length > 0) {
      const missingTitles = rows
        .filter((row) => missingDownloads.some((missing) => missing.itemId === row.item.item_id))
        .map((row) => row.item.title || "Producto")
        .slice(0, 2)
        .join(", ");
      throw new Error(
        `No se pudieron descargar ${missingDownloads.length} imagen(es) (${missingTitles}). Intenta de nuevo.`,
      );
    }
    const titleTop = cardY + cardPaddingTop;

    ctx.fillStyle = "#0f172a";
    ctx.font = "700 52px -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
    ctx.fillText("Nota de venta", cardX + 44, titleTop + 40);

    ctx.fillStyle = "#5f6f85";
    ctx.font = "500 28px -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
    ctx.textAlign = "left";
    ctx.fillText(customer, cardX + 44, titleTop + 92);
    ctx.fillText(dateText, cardX + 44, titleTop + 128);

    ctx.textAlign = "right";
    ctx.fillStyle = "#4f627d";
    ctx.font = "700 30px -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
    ctx.fillText(`Pedido ${order.order_id}`, cardX + cardW - 44, titleTop + 44);

    const tableHeaderTop = titleTop + titleBlockHeight;
    this.drawRoundedRect(ctx, cardInnerX, tableHeaderTop, cardInnerW, tableHeaderHeight, 18, "#f5f8fd");
    ctx.fill();

    ctx.fillStyle = "#4f627d";
    ctx.font = "600 24px -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
    ctx.textAlign = "left";
    ctx.fillText("Producto", cardX + 64, tableHeaderTop + 36);
    ctx.textAlign = "right";
    ctx.fillText("Cant", qtyColumnX, tableHeaderTop + 36);
    ctx.fillText("Unit", unitColumnX, tableHeaderTop + 36);
    ctx.fillText("Total", totalColumnX, tableHeaderTop + 36);

    let y = tableHeaderTop + tableHeaderHeight + 16;
    for (const row of rows) {
      this.drawRoundedRect(ctx, cardInnerX, y, cardInnerW, rowHeight, 16, "#ffffff");
      ctx.fillStyle = "#e4ebf5";
      ctx.fill();
      this.drawRoundedRect(ctx, cardInnerX, y, cardInnerW, rowHeight, 16, "#ffffff");
      ctx.strokeStyle = "#dce6f3";
      ctx.lineWidth = 2;
      ctx.stroke();

      const imageX = cardX + 48;
      const imageY = y + 12;
      const imageSize = 70;
      const image = imageByItemId.get(row.item.item_id) || null;
      if (image) {
        ctx.save();
        this.drawRoundedRect(ctx, imageX, imageY, imageSize, imageSize, 14, "#ffffff");
        ctx.clip();
        this.drawImageCover(ctx, image, imageX, imageY, imageSize, imageSize);
        ctx.restore();
      } else {
        this.drawRoundedRect(ctx, imageX, imageY, imageSize, imageSize, 14, "#edf2f9");
        ctx.fillStyle = "#edf2f9";
        ctx.fill();
        ctx.fillStyle = "#6e8099";
        ctx.font = "600 19px -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
        const initials = (row.item.title || "?").slice(0, 2).toUpperCase();
        ctx.fillText(initials, imageX + 20, imageY + 42);
      }

      const title = this.truncateForNote(ctx, row.item.title || "Producto", 388, "600 28px -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif");
      const variant = `${row.item.variant || "Unica"} · ${row.item.color || "N/A"}`;
      ctx.fillStyle = "#0f172a";
      ctx.font = "600 28px -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
      ctx.textAlign = "left";
      ctx.fillText(title, productColumnX, y + 44);
      ctx.fillStyle = "#64748b";
      ctx.font = "500 22px -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
      ctx.fillText(this.truncateForNote(ctx, variant, 388, "500 22px -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"), productColumnX, y + 76);

      ctx.fillStyle = "#1f2f46";
      ctx.font = "600 26px -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
      ctx.textAlign = "right";
      ctx.fillText(String(row.qty), qtyColumnX, y + 58);
      ctx.fillText(this.formatCurrency(row.unitPrice), unitColumnX, y + 58);
      ctx.fillText(this.formatCurrency(row.lineTotal), totalColumnX, y + 58);

      y += rowHeight + rowGap;
    }

    const rowsBottom = (tableHeaderTop + tableHeaderHeight + 16) + rowsHeight;
    const footerTop = rowsBottom + footerGap;
    this.drawRoundedRect(ctx, cardInnerX, footerTop, cardInnerW, footerHeight, 18, "#f6f9ff");
    ctx.fillStyle = "#f6f9ff";
    ctx.fill();

    ctx.fillStyle = "#5f6f85";
    ctx.font = "600 30px -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
    ctx.textAlign = "left";
    ctx.fillText("Total", cardX + 56, footerTop + 60);
    ctx.fillStyle = "#0f172a";
    ctx.font = "700 44px -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
    ctx.textAlign = "right";
    ctx.fillText(this.formatCurrency(total), totalColumnX, footerTop + 64);
    ctx.textAlign = "left";

    return new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((blob) => {
        if (!blob) {
          reject(new Error("No se pudo exportar la nota."));
          return;
        }
        resolve(blob);
      }, "image/png");
    });
  }

  private drawRoundedRect(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    width: number,
    height: number,
    radius: number,
    fillStyle: string,
  ) {
    const r = Math.max(0, Math.min(radius, width / 2, height / 2));
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + width, y, x + width, y + height, r);
    ctx.arcTo(x + width, y + height, x, y + height, r);
    ctx.arcTo(x, y + height, x, y, r);
    ctx.arcTo(x, y, x + width, y, r);
    ctx.closePath();
    ctx.fillStyle = fillStyle;
  }

  private truncateForNote(ctx: CanvasRenderingContext2D, value: string, maxWidth: number, font: string): string {
    ctx.font = font;
    if (ctx.measureText(value).width <= maxWidth) return value;
    let text = value;
    while (text.length > 0 && ctx.measureText(`${text}…`).width > maxWidth) {
      text = text.slice(0, -1);
    }
    return text ? `${text}…` : "…";
  }

  private drawImageCover(
    ctx: CanvasRenderingContext2D,
    image: CanvasImageSource & { naturalWidth?: number; naturalHeight?: number; width?: number; height?: number },
    dx: number,
    dy: number,
    dw: number,
    dh: number,
  ) {
    const sourceWidth = Number(image.naturalWidth || image.width || 0);
    const sourceHeight = Number(image.naturalHeight || image.height || 0);
    if (sourceWidth <= 0 || sourceHeight <= 0) {
      ctx.drawImage(image as CanvasImageSource, dx, dy, dw, dh);
      return;
    }

    const scale = Math.max(dw / sourceWidth, dh / sourceHeight);
    const cropWidth = dw / scale;
    const cropHeight = dh / scale;
    const sx = Math.max(0, (sourceWidth - cropWidth) / 2);
    const sy = Math.max(0, (sourceHeight - cropHeight) / 2);

    ctx.drawImage(
      image as CanvasImageSource,
      sx,
      sy,
      cropWidth,
      cropHeight,
      dx,
      dy,
      dw,
      dh,
    );
  }

  private async loadSalesNoteRowImage(row: SalesNoteRowVm): Promise<{
    itemId: string;
    image: HTMLImageElement | null;
    hasCandidates: boolean;
  }> {
    const loadedCardImage = this.getLoadedProductCardImageElement(row.item.item_id);
    if (loadedCardImage) {
      return {
        itemId: row.item.item_id,
        image: loadedCardImage,
        hasCandidates: true,
      };
    }

    const candidates = this.salesNoteImageCandidates(row);
    return {
      itemId: row.item.item_id,
      image: await this.loadSalesNoteImageCandidates(candidates),
      hasCandidates: candidates.length > 0,
    };
  }

  private async loadSalesNoteImageCandidates(candidates: string[]): Promise<HTMLImageElement | null> {
    if (candidates.length === 0) return null;
    const attempts = candidates.map(async (candidate) => {
      const image = await this.loadNoteImageWithRetries(candidate, 2);
      if (!image) throw new Error("image_not_loaded");
      return image;
    });
    try {
      return await this.withTimeout(Promise.any(attempts), 20000, "Tiempo de espera agotado al descargar imagen.");
    } catch {
      return null;
    }
  }

  private async loadNoteImageWithRetries(url: string, maxAttempts: number): Promise<HTMLImageElement | null> {
    const attempts = Math.max(1, Math.trunc(maxAttempts || 1));
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const image = await this.loadNoteImage(url);
      if (image) return image;
      if (attempt < attempts) {
        await this.sleep(180 * attempt);
      }
    }
    return null;
  }

  private sleep(ms: number): Promise<void> {
    const waitMs = Math.max(0, Math.trunc(ms || 0));
    return new Promise((resolve) => setTimeout(resolve, waitMs));
  }

  private async withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
    const waitMs = Math.max(1000, Math.trunc(timeoutMs || 0));
    let timer: ReturnType<typeof setTimeout> | null = null;
    try {
      return await Promise.race([
        promise,
        new Promise<T>((_, reject) => {
          timer = setTimeout(() => reject(new Error(message)), waitMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private salesNoteImageCandidates(row: SalesNoteRowVm): string[] {
    const item = row.item;
    const loadedCardImageUrl = this.getLoadedProductCardImageUrl(item.item_id);
    const candidates: Array<string | null | undefined> = [
      loadedCardImageUrl,
      row.imageUrl,
      item.image_url,
      this.resolveItemImage(item),
      this.resolveSalesNoteCatalogImage(item),
      this.resolveSalesNoteInventoryImage(item),
      this.resolveSalesNoteImageByLabel(item),
    ];
    return this.uniqueNoteImageCandidates(candidates);
  }

  private getLoadedProductCardImageUrl(itemId: string): string | null {
    const image = this.getLoadedProductCardImageElement(itemId);
    if (!image) return null;
    return image.currentSrc || image.src || null;
  }

  private getLoadedProductCardImageElement(itemId: string): HTMLImageElement | null {
    const cardEl = document.getElementById(`product-card-${itemId}`);
    if (!cardEl) return null;
    const imageEl = cardEl.querySelector(".image-container img") as HTMLImageElement | null;
    if (!imageEl) return null;
    if (!imageEl.complete || imageEl.naturalWidth <= 0 || imageEl.naturalHeight <= 0) return null;
    if (!this.canUseImageOnCanvas(imageEl)) return null;
    return imageEl;
  }

  private canUseImageOnCanvas(image: HTMLImageElement): boolean {
    try {
      const canvas = document.createElement("canvas");
      canvas.width = 1;
      canvas.height = 1;
      const ctx = canvas.getContext("2d");
      if (!ctx) return false;
      ctx.drawImage(image, 0, 0, 1, 1);
      ctx.getImageData(0, 0, 1, 1);
      return true;
    } catch {
      return false;
    }
  }

  private resolveSalesNoteCatalogImage(item: OrderItem): string | null {
    const productId = (item.product_id || "").trim();
    if (!productId) return null;
    const doc = this.catalogById().get(productId) || null;
    if (!doc) return null;
    const listing: any = doc.listing || { items: [] };
    const targetVariant = (item.variant || "").trim().toLowerCase();
    const variant = (listing.items || []).find((entry: any) => {
      const variantName = String(entry?.variant_name || "").trim().toLowerCase();
      return variantName && variantName === targetVariant;
    }) || (listing.items || [])[0] || null;
    const colorImage = this.resolveColorImage(doc, item.color);
    return colorImage || variant?.image_url || doc.cover_images?.[0] || doc.preview_image_url || null;
  }

  private resolveSalesNoteInventoryImage(item: OrderItem): string | null {
    const inventoryId = (item.inventory_id || "").trim();
    if (!inventoryId) return null;
    return this.inventoryById().get(inventoryId)?.image_urls?.[0] || null;
  }

  private resolveSalesNoteImageByLabel(item: OrderItem): string | null {
    const title = String(item.title || "").trim().toLowerCase();
    if (!title) return null;
    const variant = String(item.variant || "").trim().toLowerCase();
    const color = String(item.color || "").trim().toLowerCase();

    const invHit = this.inventory.items().find((row) => {
      const rowTitle = String(row.title || "").trim().toLowerCase();
      if (!rowTitle || rowTitle !== title) return false;
      if (variant && String(row.variant_name || row.size_label || "").trim().toLowerCase() !== variant) return false;
      if (color && String(row.color_name || "").trim().toLowerCase() !== color) return false;
      return true;
    });
    if (invHit?.image_urls?.[0]) return invHit.image_urls[0];

    for (const doc of this.catalogRows()) {
      const listing: any = doc.listing || { items: [] };
      const listingTitle = String(listing.title || "").trim().toLowerCase();
      if (!listingTitle || listingTitle !== title) continue;

      const variantRows = Array.isArray(listing.items) ? listing.items : [];
      const variantRow = variantRows.find((entry: any) => {
        const variantName = String(entry?.variant_name || "").trim().toLowerCase();
        return !variant || variantName === variant;
      }) || variantRows[0] || null;
      if (!variantRow) continue;
      const colorImage = this.resolveColorImage(doc, item.color);
      const image = colorImage || variantRow.image_url || doc.cover_images?.[0] || doc.preview_image_url || null;
      if (image) return image;
    }

    return null;
  }

  private uniqueNoteImageCandidates(values: Array<string | null | undefined>): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    for (const raw of values) {
      const normalized = this.normalizeNoteImageUrl(raw);
      if (!normalized) continue;
      const key = normalized.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(normalized);
    }
    return out;
  }

  private normalizeNoteImageUrl(value: string | null | undefined): string | null {
    const raw = String(value || "").trim();
    if (!raw) return null;
    if (raw.startsWith("data:") || raw.startsWith("blob:")) return raw;
    if (raw.startsWith("//")) return `${window.location.protocol}${raw}`;
    if (raw.startsWith("gs://")) {
      const gsPath = raw.slice("gs://".length);
      const firstSlash = gsPath.indexOf("/");
      if (firstSlash <= 0) return null;
      const bucket = gsPath.slice(0, firstSlash);
      const objectPath = gsPath.slice(firstSlash + 1);
      const firebaseUrl = `https://firebasestorage.googleapis.com/v0/b/${bucket}/o/${encodeURIComponent(objectPath)}?alt=media`;
      return this.toStorageProxyUrl(firebaseUrl);
    }
    return this.toStorageProxyUrl(raw);
  }

  private toStorageProxyUrl(url: string): string {
    try {
      const parsed = new URL(url, window.location.origin);
      if (!parsed.hostname.includes("firebasestorage.googleapis.com")) return parsed.toString();
      return `/__storage_proxy${parsed.pathname}${parsed.search}`;
    } catch {
      return url;
    }
  }

  private async loadNoteImage(url: string | null): Promise<HTMLImageElement | null> {
    if (!url) return null;
    const normalizedUrl = this.normalizeNoteImageUrl(url);
    if (!normalizedUrl) return null;

    const fromStorageSdk = await this.loadImageFromStorageBlob(normalizedUrl);
    if (fromStorageSdk) return fromStorageSdk;

    const fetched = await this.loadImageFromFetchBlob(normalizedUrl);
    if (fetched) return fetched;

    const directCors = await this.loadImageElement(normalizedUrl, true);
    if (directCors) return directCors;

    return null;
  }

  private looksLikeFirebaseStorageUrl(url: string): boolean {
    if (!url) return false;
    return (
      url.startsWith("gs://")
      || url.includes("firebasestorage.googleapis.com/")
      || url.includes("storage.googleapis.com/")
    );
  }

  private async loadImageFromStorageBlob(url: string): Promise<HTMLImageElement | null> {
    if (!this.looksLikeFirebaseStorageUrl(url)) return null;
    try {
      const blob = await this.withTimeout(
        getBlob(storageRef(STORAGE, url)),
        7000,
        "Tiempo de espera agotado al descargar imagen de Storage.",
      );
      if (!blob || blob.size <= 0) return null;
      const dataUrl = await this.blobToDataUrl(blob);
      return this.loadImageElement(dataUrl, false);
    } catch {
      return null;
    }
  }

  private async loadImageFromFetchBlob(url: string): Promise<HTMLImageElement | null> {
    const attempts: Array<{ credentials: RequestCredentials; mode: RequestMode }> = [
      { credentials: "include", mode: "cors" },
      { credentials: "omit", mode: "cors" },
    ];
    for (const attempt of attempts) {
      try {
        const response = await this.fetchWithTimeout(
          url,
          {
            mode: attempt.mode,
            credentials: attempt.credentials,
            cache: "force-cache",
          },
          6500,
        );
        if (!response.ok) continue;
        const blob = await response.blob();
        if (!blob || blob.size <= 0) continue;
        const dataUrl = await this.blobToDataUrl(blob);
        const image = await this.loadImageElement(dataUrl, false);
        if (image) return image;
      } catch {
        // Continue with next strategy.
      }
    }
    return null;
  }

  private blobToDataUrl(blob: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ""));
      reader.onerror = () => reject(new Error("No se pudo convertir imagen."));
      reader.readAsDataURL(blob);
    });
  }

  private async fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(1000, Math.trunc(timeoutMs || 0)));
    try {
      return await fetch(url, {
        ...init,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  private async loadImageElement(url: string, withCrossOrigin: boolean, timeoutMs = 6000): Promise<HTMLImageElement | null> {
    return new Promise((resolve) => {
      const img = new Image();
      let done = false;
      const finish = (value: HTMLImageElement | null) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(value);
      };
      const timer = setTimeout(() => finish(null), Math.max(1000, timeoutMs));
      if (withCrossOrigin) img.crossOrigin = "anonymous";
      img.onload = () => finish(img);
      img.onerror = () => finish(null);
      img.src = url;
    });
  }

  private async tryShareSalesNote(blob: Blob, fileName: string, order: Order): Promise<boolean> {
    const nav = navigator as Navigator & { canShare?: (data: ShareData) => boolean };
    if (typeof nav.share !== "function") return false;
    const file = new File([blob], fileName, { type: "image/png" });
    const data: ShareData = {
      title: `Nota ${order.order_id}`,
      text: `Nota de venta del pedido ${order.order_id}`,
      files: [file],
    };
    if (typeof nav.canShare === "function" && !nav.canShare({ files: [file] })) return false;
    try {
      await nav.share(data);
      return true;
    } catch (error: any) {
      // User canceled share flow: treat as handled to avoid forced download.
      if (error?.name === "AbortError") return true;
      return false;
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

  async printLabel(order: Order, pkg: PackageRecord) {
    if (this.packingBusy()) return;
    this.packingBusy.set(true);
    try {
      const qrPayload = this.buildLabelQrPayload(order, pkg);
      const pdfBytes = await this.buildPackageLabelPdf(order, pkg, qrPayload);
      const opened = this.openLabelPdf(pdfBytes, `etiqueta-${order.order_id}-${pkg.package_id}.pdf`);
      this.actionError.set(null);
      this.showActionToast(opened ? "Etiqueta PDF 100x150 lista para imprimir." : "Etiqueta PDF descargada.");

      try {
        await this.orders.logEvent(order.order_id, "label_printed", "Etiqueta PDF 100x150 generada", {
          packageId: pkg.package_id,
          qrPayload,
          format: "pdf_100x150mm",
        });
        await this.refreshEvents();
      } catch (error) {
        console.warn("[pedido-detalle] Etiqueta generada sin registrar evento", { orderId: order.order_id, error });
      }
    } catch (error) {
      console.error("[pedido-detalle] No se pudo generar etiqueta PDF", { orderId: order.order_id, packageId: pkg.package_id, error });
      this.actionError.set("No se pudo generar la etiqueta PDF 100x150.");
      this.showActionToast("Error al generar etiqueta.");
    } finally {
      this.packingBusy.set(false);
    }
  }

  private async buildPackageLabelPdf(order: Order, pkg: PackageRecord, qrPayload: string): Promise<Uint8Array> {
    const pdfDoc = await PDFDocument.create();
    const pageWidth = this.mmToPt(100);
    const pageHeight = this.mmToPt(150);
    const marginX = this.mmToPt(5);
    const topMargin = this.mmToPt(5);
    const bottomMargin = this.mmToPt(5);
    const contentWidth = pageWidth - (marginX * 2);
    const ink = rgb(0, 0, 0);
    const secondary = rgb(0.28, 0.28, 0.28);
    const meta = rgb(0.45, 0.45, 0.45);
    const divider = rgb(0.82, 0.82, 0.82);
    const dividerThickness = 1.4;

    const page = pdfDoc.addPage([pageWidth, pageHeight]);
    const fontRegular = await pdfDoc.embedFont(StandardFonts.Helvetica);
    const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

    page.drawRectangle({
      x: 0,
      y: 0,
      width: pageWidth,
      height: pageHeight,
      color: rgb(1, 1, 1),
    });

    let cursorTop = pageHeight - topMargin;
    const logoSlotWidth = this.mmToPt(31);
    const topSectionHeight = this.mmToPt(18);
    const topSectionBottom = cursorTop - topSectionHeight;
    const logoBytes = await this.loadLabelLogoBytes();
    if (logoBytes) {
      const logoImage = await pdfDoc.embedPng(logoBytes);
      const logoBoxWidth = this.mmToPt(29);
      const logoBoxHeight = this.mmToPt(15.5);
      const fittedLogo = this.fitImage(logoImage.width, logoImage.height, logoBoxWidth, logoBoxHeight);
      page.drawImage(logoImage, {
        x: marginX + ((logoSlotWidth - fittedLogo.width) / 2),
        y: topSectionBottom + ((topSectionHeight - fittedLogo.height) / 2),
        width: fittedLogo.width,
        height: fittedLogo.height,
      });
    } else {
      const fallback = "BM";
      const fallbackSize = 16;
      const fallbackWidth = fontBold.widthOfTextAtSize(fallback, fallbackSize);
      page.drawText(fallback, {
        x: marginX + ((logoSlotWidth - fallbackWidth) / 2),
        y: topSectionBottom + this.mmToPt(6),
        font: fontBold,
        size: fallbackSize,
        color: ink,
      });
    }

    const routeX = marginX + logoSlotWidth + this.mmToPt(2.5);
    const routeWidth = pageWidth - marginX - routeX;
    page.drawText("RUTA", {
      x: routeX,
      y: cursorTop - this.mmToPt(5.2),
      font: fontBold,
      size: 7.2,
      color: meta,
    });
    const routeLines = this.splitTextByWidth((this.routeName(order) || "SIN RUTA").toUpperCase(), routeWidth, fontBold, 16).slice(0, 2);
    let routeY = cursorTop - this.mmToPt(11.4);
    for (const line of routeLines) {
      page.drawText(line, {
        x: routeX,
        y: routeY,
        font: fontBold,
        size: 16,
        color: ink,
      });
      routeY -= this.mmToPt(5.5);
    }

    page.drawLine({
      start: { x: marginX, y: topSectionBottom },
      end: { x: pageWidth - marginX, y: topSectionBottom },
      thickness: dividerThickness,
      color: divider,
    });

    const customerSectionTop = topSectionBottom - this.mmToPt(2.2);
    let customerY = customerSectionTop - this.mmToPt(2.4);
    page.drawText("CLIENTA", {
      x: marginX,
      y: customerY,
      font: fontBold,
      size: 7.2,
      color: meta,
    });
    customerY -= this.mmToPt(5.2);

    const customerLines = this.splitTextByWidth(this.customerName(order), contentWidth, fontBold, 13.6).slice(0, 2);
    for (const line of customerLines) {
      page.drawText(line, {
        x: marginX,
        y: customerY,
        font: fontBold,
        size: 13.6,
        color: ink,
      });
      customerY -= this.mmToPt(5);
    }

    const addressLines = this.customerAddressLines(order);
    for (const line of addressLines.slice(0, 1)) {
      const wrapped = this.splitTextByWidth(line, contentWidth, fontRegular, 8.8).slice(0, 1);
      if (wrapped.length > 0) {
        page.drawText(wrapped[0], {
          x: marginX,
          y: customerY,
          font: fontRegular,
          size: 8.8,
          color: secondary,
        });
        customerY -= this.mmToPt(4.2);
      }
    }

    const packageSectionTop = customerY - this.mmToPt(3.5);
    const packageSectionHeight = this.mmToPt(13.5);
    const packageSectionBottom = packageSectionTop - packageSectionHeight;
    const shortPackageId = this.shortPackageId(pkg);
    const boxCountLabel = this.packageCountLabel(order, pkg);

    page.drawText(shortPackageId, {
      x: marginX,
      y: packageSectionTop - this.mmToPt(5.8),
      font: fontBold,
      size: 11.2,
      color: ink,
    });
    page.drawText(order.order_id, {
      x: marginX,
      y: packageSectionTop - this.mmToPt(10.3),
      font: fontRegular,
      size: 8,
      color: secondary,
    });
    page.drawText("CAJA", {
      x: marginX + (contentWidth * 0.62),
      y: packageSectionTop - this.mmToPt(3.8),
      font: fontBold,
      size: 7,
      color: meta,
    });

    const boxCountSize = 21;
    const boxCountWidth = fontBold.widthOfTextAtSize(boxCountLabel, boxCountSize);
    page.drawText(boxCountLabel, {
      x: pageWidth - marginX - boxCountWidth,
      y: packageSectionTop - this.mmToPt(11.2),
      font: fontBold,
      size: boxCountSize,
      color: ink,
    });

    page.drawLine({
      start: { x: marginX, y: packageSectionBottom },
      end: { x: pageWidth - marginX, y: packageSectionBottom },
      thickness: dividerThickness,
      color: divider,
    });

    const qrTop = packageSectionBottom - this.mmToPt(1.2);
    const qrSize = this.mmToPt(36);
    const qrX = (pageWidth - qrSize) / 2;
    const qrY = qrTop - qrSize;
    const qrDataUrl = await this.buildQrDataUrl(qrPayload);
    const qrImage = await pdfDoc.embedPng(this.dataUrlToBytes(qrDataUrl));
    page.drawImage(qrImage, {
      x: qrX,
      y: qrY,
      width: qrSize,
      height: qrSize,
    });

    const qrCaption = "ESCANEAR PAQUETE";
    const qrCaptionSize = 8.2;
    const qrCaptionWidth = fontBold.widthOfTextAtSize(qrCaption, qrCaptionSize);
    const qrCaptionY = qrY - this.mmToPt(3.2);
    page.drawText(qrCaption, {
      x: (pageWidth - qrCaptionWidth) / 2,
      y: qrCaptionY,
      font: fontBold,
      size: qrCaptionSize,
      color: ink,
    });

    const footerTextY = bottomMargin + this.mmToPt(0.7);
    const footerDividerY = footerTextY + this.mmToPt(5.8);
    page.drawLine({
      start: { x: marginX, y: footerDividerY },
      end: { x: pageWidth - marginX, y: footerDividerY },
      thickness: dividerThickness,
      color: divider,
    });

    const contentTop = qrCaptionY - this.mmToPt(6.2);
    const contentBottom = footerDividerY + this.mmToPt(1.6);
    let contentY = contentTop;
    page.drawText("CONTENIDO", {
      x: marginX,
      y: contentY,
      font: fontBold,
      size: 8.2,
      color: meta,
    });
    contentY -= this.mmToPt(4.8);

    const packageItems = this.packingItemsInBox(order, pkg);
    const totalPieces = packageItems.reduce((sum, row) => sum + Math.max(1, Math.trunc(row.qty || 0)), 0);
    const summary = `${packageItems.length} producto(s) | ${totalPieces} pieza(s)`;
    page.drawText(summary, {
      x: marginX,
      y: contentY,
      font: fontRegular,
      size: 7.5,
      color: secondary,
    });
    contentY -= this.mmToPt(4.2);

    const listFontSize = 7.1;
    const listLineHeight = this.mmToPt(3.4);
    let hiddenProducts = 0;
    for (let index = 0; index < packageItems.length; index += 1) {
      const row = packageItems[index];
      const line = this.truncateTextToWidth(
        `${Math.max(1, Math.trunc(row.qty || 0))} x ${this.itemLabelWithoutPrice(row.item)}`,
        contentWidth,
        fontRegular,
        listFontSize,
      );
      const blockHeight = listLineHeight;
      const remainingAfterCurrent = packageItems.length - (index + 1);
      const reserveOverflow = remainingAfterCurrent > 0 ? (listLineHeight * 0.9) : 0;
      if (contentY - blockHeight < (contentBottom + reserveOverflow)) {
        hiddenProducts = packageItems.length - index;
        break;
      }
      page.drawText(line, {
        x: marginX,
        y: contentY,
        font: fontRegular,
        size: listFontSize,
        color: ink,
      });
      contentY -= listLineHeight;
      contentY -= this.mmToPt(0.2);
    }

    if (packageItems.length === 0 && contentY > contentBottom) {
      page.drawText("Sin productos en este paquete.", {
        x: marginX,
        y: contentY,
        font: fontRegular,
        size: listFontSize,
        color: secondary,
      });
    } else if (hiddenProducts > 0) {
      page.drawText(`+ ${hiddenProducts} productos`, {
        x: marginX,
        y: Math.max(contentBottom, contentY),
        font: fontBold,
        size: 8.2,
        color: secondary,
      });
    }

    const footerMeta = "www.base-mayorista.com   |   Tel. 33 1859 7241";
    const footerMetaSize = 6.2;
    const footerMetaWidth = fontRegular.widthOfTextAtSize(footerMeta, footerMetaSize);
    page.drawText(footerMeta, {
      x: (pageWidth - footerMetaWidth) / 2,
      y: footerTextY,
      font: fontRegular,
      size: footerMetaSize,
      color: secondary,
    });

    return pdfDoc.save();
  }

  private shortPackageId(pkg: PackageRecord): string {
    const normalized = String(pkg.package_id || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
    const shortCode = (normalized.slice(-4) || normalized || "0000").padStart(4, "0");
    return `PKG-${shortCode}`;
  }

  private packageCountLabel(order: Order, pkg: PackageRecord): string {
    const raw = this.packageStatus(pkg) === "closed" ? this.closedBoxLabel(order, pkg) : "1/1";
    const parts = raw.split("/");
    if (parts.length !== 2) return raw.replace("/", " / ");
    return `${parts[0].trim()} / ${parts[1].trim()}`;
  }

  private customerAddressLines(order: Order): string[] {
    const customer = this.customers.getById(order.customer_id);
    if (!customer) return [];
    const lines: string[] = [];

    const localityId = String(customer.locality_id || "").trim();
    if (localityId) {
      const localityName = this.localities.getById(localityId)?.name || localityId;
      if (localityName) lines.push(localityName);
    }

    const noteRaw = String(customer.notes || order.notes || "").replace(/\s+/g, " ").trim();
    if (noteRaw) {
      lines.push(noteRaw.length > 72 ? `${noteRaw.slice(0, 69).trim()}...` : noteRaw);
    }

    if (lines.length === 0) {
      const fallbackRoute = this.routeName(order);
      if (fallbackRoute) lines.push(fallbackRoute);
    }

    return lines.slice(0, 2);
  }

  private splitTextByWidth(text: string, maxWidth: number, font: PDFFont, fontSize: number): string[] {
    const safe = (text || "").replace(/\s+/g, " ").trim();
    if (!safe) return [];
    const words = safe.split(" ");
    const lines: string[] = [];
    let current = "";

    for (const word of words) {
      const candidate = current ? `${current} ${word}` : word;
      if (font.widthOfTextAtSize(candidate, fontSize) <= maxWidth) {
        current = candidate;
        continue;
      }

      if (current) {
        lines.push(current);
      }

      if (font.widthOfTextAtSize(word, fontSize) <= maxWidth) {
        current = word;
        continue;
      }

      const chunks = this.breakLongWord(word, maxWidth, font, fontSize);
      if (chunks.length === 0) {
        current = "";
      } else {
        lines.push(...chunks.slice(0, -1));
        current = chunks[chunks.length - 1];
      }
    }

    if (current) lines.push(current);
    return lines;
  }

  private truncateTextToWidth(text: string, maxWidth: number, font: PDFFont, fontSize: number): string {
    const safe = (text || "").replace(/\s+/g, " ").trim();
    if (!safe) return "";
    if (font.widthOfTextAtSize(safe, fontSize) <= maxWidth) return safe;

    const suffix = "...";
    const suffixWidth = font.widthOfTextAtSize(suffix, fontSize);
    if (suffixWidth >= maxWidth) return suffix;

    let output = "";
    for (const char of safe) {
      const candidate = `${output}${char}`;
      if (font.widthOfTextAtSize(candidate, fontSize) + suffixWidth > maxWidth) break;
      output = candidate;
    }

    return `${output.trimEnd()}${suffix}`;
  }

  private breakLongWord(word: string, maxWidth: number, font: PDFFont, fontSize: number): string[] {
    if (!word) return [];
    const chunks: string[] = [];
    let chunk = "";
    for (const char of word) {
      const candidate = `${chunk}${char}`;
      if (chunk && font.widthOfTextAtSize(candidate, fontSize) > maxWidth) {
        chunks.push(chunk);
        chunk = char;
      } else {
        chunk = candidate;
      }
    }
    if (chunk) chunks.push(chunk);
    return chunks;
  }

  private fitImage(sourceWidth: number, sourceHeight: number, boxWidth: number, boxHeight: number): { width: number; height: number } {
    if (!sourceWidth || !sourceHeight) return { width: boxWidth, height: boxHeight };
    const scale = Math.min(boxWidth / sourceWidth, boxHeight / sourceHeight);
    return {
      width: sourceWidth * scale,
      height: sourceHeight * scale,
    };
  }

  private itemLabelWithoutPrice(item: OrderItem): string {
    const title = (item.title || "").trim() || "Producto sin titulo";
    const variant = (item.variant || "").trim();
    const color = (item.color || "").trim();
    return [title, variant, color].filter(Boolean).join(" - ");
  }

  private buildLabelQrPayload(order: Order, pkg: PackageRecord): string {
    const payload = {
      v: 1,
      type: "BM_PACKAGE",
      orderId: order.order_id,
      packageId: pkg.package_id,
      packageLabel: this.packageDisplayLabel(order, pkg),
      packageStatus: this.packageStatus(pkg),
      customerId: order.customer_id,
      customerName: this.customerName(order),
      routeId: order.route_id || null,
      routeName: this.routeName(order),
      qrToken: this.qrPlaceholder(order, pkg),
      createdAt: new Date().toISOString(),
      action: "scan_package",
    };
    return JSON.stringify(payload);
  }

  private async buildQrDataUrl(payload: string): Promise<string> {
    return QRCode.toDataURL(payload, {
      errorCorrectionLevel: "M",
      margin: 1,
      width: 512,
      color: {
        dark: "#000000",
        light: "#FFFFFF",
      },
    });
  }

  private async loadLabelLogoBytes(): Promise<Uint8Array | null> {
    const candidates = ["/BM%20_BN.png", "/BM _BN.png"];
    for (const assetPath of candidates) {
      try {
        const response = await fetch(assetPath);
        if (!response.ok) continue;
        return new Uint8Array(await response.arrayBuffer());
      } catch {
        // Try next path variant.
      }
    }
    return null;
  }

  private dataUrlToBytes(dataUrl: string): Uint8Array {
    const base64 = String(dataUrl).split(",")[1] || "";
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  }

  private openLabelPdf(pdfBytes: Uint8Array, fileName: string): boolean {
    const safeBytes = new Uint8Array(pdfBytes.length);
    safeBytes.set(pdfBytes);
    const blob = new Blob([safeBytes], { type: "application/pdf" });
    const blobUrl = URL.createObjectURL(blob);
    const win = window.open(blobUrl, "_blank", "noopener,noreferrer");
    if (win) {
      win.focus();
      setTimeout(() => URL.revokeObjectURL(blobUrl), 120000);
      return true;
    }

    const link = document.createElement("a");
    link.href = blobUrl;
    link.download = fileName;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(blobUrl), 30000);
    return false;
  }

  private mmToPt(mm: number): number {
    return (mm * 72) / 25.4;
  }

  async deliverPackage(order: Order, pkg: PackageRecord) {
    await this.orders.setPackageState(order.order_id, pkg.package_id, "entregado");
    await this.orders.logEvent(order.order_id, "PACKAGE_DELIVERED", `Paquete entregado ${pkg.label}`, {
      packageId: pkg.package_id,
    });
  }

  async registerPayment(order: Order) {
    await this.orders.logEvent(order.order_id, "PAYMENT_REGISTERED", "Pago registrado/conciliado", {});
  }

  // ── Cierre de pedido ─────────────────────────────────────────────────────

  canCloseOrder(order: Order | null): boolean {
    if (!order) return false;
    // Disponible desde que se tiene algo empacado hasta estados de pago pendiente.
    // Excluimos borrador/confirmando (aún no hay productos listos) y terminales (pagado/cancelado).
    const TERMINAL = new Set(["pagado", "cancelado", "devuelto", "closed"]);
    const TOO_EARLY = new Set(["borrador", "confirmando_proveedor", "reservado_inventario", "solicitado_proveedor", "supplier_processing", "inbound_in_transit"]);
    return !TERMINAL.has(order.status) && !TOO_EARLY.has(order.status);
  }

  // ── Historial / autocomplete de productos manuales ──────────────────

  /** Rellena todos los campos del formulario con la sugerencia seleccionada */
  applyManualSuggestion(entry: ManualProductEntry): void {
    this.newItemTitle.set(entry.title);
    this.newItemVariant.set(entry.variant || "");
    this.newItemColor.set(entry.color || "");
    if (entry.price_clienta != null) {
      this.newItemPriceClienta.set(entry.price_clienta);
      this.priceInputDraft.update(d => ({ ...d, clienta: String(entry.price_clienta) }));
    }
    if (entry.price_cost != null) {
      this.newItemPriceCost.set(entry.price_cost);
      this.priceInputDraft.update(d => ({ ...d, costo: String(entry.price_cost) }));
    }
    this.manualSuggestionsOpen.set(false);
  }

  openPaymentModal() {
    const order = this.order();
    if (!order) return;
    const balance = this.orderBalanceDue(order);
    this.paymentAmount.set(balance > 0 ? String(balance) : "");
    this.paymentError.set(null);
    this.paymentModalOpen.set(true);
  }

  closePaymentModal() {
    this.paymentModalOpen.set(false);
    this.paymentError.set(null);
  }

  async confirmPayment(order: Order) {
    if (this.paymentSaving()) return;

    const rawAmount = this.paymentAmount().replace(/,/g, "").trim();
    const paidAmount = rawAmount === "" ? 0 : parseFloat(rawAmount);

    if (!Number.isFinite(paidAmount) || paidAmount < 0) {
      this.paymentError.set("Ingresa un monto válido.");
      return;
    }

    const totalAmount = this.totals().totalClienta || 0;

    this.paymentSaving.set(true);
    this.paymentError.set(null);
    try {
      await this.orders.closeWithPayment(order.order_id, paidAmount, totalAmount);
      await this.orders.logEvent(
        order.order_id,
        "PAYMENT_CLOSED",
        `Pedido cerrado. Pago: $${paidAmount}. Total: $${totalAmount}.`,
        { paid_amount: paidAmount, total_amount: totalAmount },
      );
      this.paymentModalOpen.set(false);
      this.showActionToast(
        paidAmount >= totalAmount
          ? "Pedido marcado como Pagado ✓"
          : paidAmount > 0
            ? `Pago parcial registrado. Saldo: $${(totalAmount - paidAmount).toFixed(2)}`
            : "Pedido marcado con pago pendiente.",
      );
    } catch (err: any) {
      this.paymentError.set(err?.message || "No se pudo registrar el pago.");
    } finally {
      this.paymentSaving.set(false);
    }
  }

  markFullyPaid(order: Order) {
    const total = this.totals().totalClienta || 0;
    this.paymentAmount.set(String(total));
    this.confirmPayment(order);
  }

  async sendSalesNoteWa(order: Order): Promise<void> {
    if (this.sendingWaNote()) return;
    const customerId = order.customer_id;
    if (!customerId) {
      this.waNoteSent.set({ ok: false, msg: "El pedido no tiene clienta asignada." });
      return;
    }
    this.sendingWaNote.set(true);
    this.waNoteSent.set(null);
    try {
      await lastValueFrom(
        this.api.post("/api/wa/send-sales-note", { customer_id: customerId, order })
      );
      this.waNoteSent.set({ ok: true });
    } catch (err: any) {
      const msg = err?.error?.message ?? "No se pudo enviar la nota por WhatsApp.";
      this.waNoteSent.set({ ok: false, msg });
    } finally {
      this.sendingWaNote.set(false);
      setTimeout(() => this.waNoteSent.set(null), 5000);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────

  private dispatchOverrideItems(order: Order): OrderItem[] {
    const packedMap = this.packedQtyByItem(order);
    return this.confirmedItems(order).filter((item) => {
      if ((packedMap.get(item.item_id) || 0) <= 0) return false;
      if (this.isSupplierManagedItem(item) && !this.isSupplierItemReceived(order, item)) return true;
      if (item.source === "inventario" && this.hasInsufficientStock(item)) return true;
      return false;
    });
  }

  private async registerDispatchOverrideWarning(order: Order, overrideItems: OrderItem[]) {
    if (overrideItems.length === 0) return;
    const listed = overrideItems.slice(0, 3).map((item) => item.title).join(", ");
    const extra = overrideItems.length > 3 ? ` +${overrideItems.length - 3} más` : "";
    const reason = `Salida con pendientes para ${overrideItems.length} item(s): ${listed}${extra}.`;

    await this.createIncidentAndRefresh(order.order_id, {
      orderId: order.order_id,
      packageId: null,
      itemId: null,
      type: "DISPATCH_OVERRIDE",
      title: "Salida con pendientes",
      severity: "medium",
      reason,
      evidenceUrls: [],
      createdBy: "admin",
    });
    await this.orders.logEvent(order.order_id, "DISPATCH_OVERRIDE", "Termino de empaque con pendientes", {
      items: overrideItems.map((item) => item.item_id),
      qty: overrideItems.length,
      reason,
    });
    this.showActionToast(`Aviso: ${overrideItems.length} item(s) saldran con pendientes.`);
  }

  async dispatchOrder(order: Order) {
    if (this.actionSaving()) return;
    if (!this.canDispatch(order)) {
      await this.createIncidentAndRefresh(order.order_id, {
        orderId: order.order_id,
        packageId: null,
        itemId: null,
        type: "DISPATCH_BLOCKED",
        title: "Bloqueo de salida",
        severity: "high",
        reason: "Existen cajas abiertas, cajas vacias o productos sin empacar.",
        evidenceUrls: [],
        createdBy: "admin",
      });
      await this.orders.logEvent(order.order_id, "DISPATCH_BLOCKED", "Salida bloqueada por precondiciones", {});
      this.actionError.set("No se puede terminar empaque/preparar salida: hay cajas abiertas, cajas vacias o productos sin empacar.");
      return;
    }
    const overrideItems = this.dispatchOverrideItems(order);
    if (overrideItems.length > 0) {
      this.actionError.set(`Aviso: terminaras empaque con pendientes para ${overrideItems.length} item(s). Se registrara incidencia.`);
    }
    this.actionSaving.set(true);
    try {
      if (overrideItems.length > 0) {
        await this.registerDispatchOverrideWarning(order, overrideItems).catch((error) => {
          console.warn("[pedido-detalle] No se pudo registrar aviso de pendientes", { orderId: order.order_id, error });
        });
      }
      const packagesCount = this.closedPackagesCount(order);
      await this.orders.markReadyForRoute(order.order_id, packagesCount);
      await this.orders.logEvent(order.order_id, "DISPATCH_READY", "Pedido listo para ruta", {
        packages_count: packagesCount,
      });
      if (overrideItems.length <= 0) this.actionError.set(null);
      this.closeActionModal();
      const latest = this.orders.getById(order.order_id) || order;
      await this.openReadyForRouteSheet(latest);
    } catch (error: any) {
      this.actionError.set(error?.message || "No se pudo terminar el empaquetado.");
    } finally {
      this.actionSaving.set(false);
    }
  }

  async openReadyForRouteSheet(order: Order) {
    this.readyForRouteSheetOpen.set(true);
    this.readyForRouteLoading.set(true);
    this.readyForRouteRun.set(null);
    this.readyForRouteError.set(null);
    try {
      const allRuns = await this.routeRuns.listRuns();
      const now = new Date();
      const start = new Date(now);
      start.setHours(0, 0, 0, 0);
      const end = new Date(now);
      end.setHours(23, 59, 59, 999);
      const run = allRuns
        .filter((row) =>
          row.route_id === order.route_id
          && (row.status === "draft" || row.status === "scheduled")
          && new Date(row.scheduled_at).getTime() >= start.getTime()
          && new Date(row.scheduled_at).getTime() <= end.getTime(),
        )
        .sort((a, b) => (a.scheduled_at < b.scheduled_at ? -1 : 1))[0] || null;
      this.readyForRouteRun.set(run);
    } catch (error: any) {
      this.readyForRouteError.set(error?.message || "No se pudo consultar salidas.");
    } finally {
      this.readyForRouteLoading.set(false);
    }
  }

  closeReadyForRouteSheet() {
    this.readyForRouteSheetOpen.set(false);
    this.readyForRouteError.set(null);
    this.readyForRouteRun.set(null);
  }

  async requestDispatchFromSheet(order: Order) {
    const actor = this.currentRunActor();
    if (!actor) return;
    this.readyForRouteLoading.set(true);
    this.readyForRouteError.set(null);
    try {
      await this.routeRuns.requestDispatch(order.order_id, actor);
      await this.orders.logEvent(order.order_id, "dispatch_requested", "Solicitud de salida enviada", {});
      this.showActionToast("Solicitud de salida enviada.");
      this.closeReadyForRouteSheet();
    } catch (error: any) {
      this.readyForRouteError.set(error?.message || "No se pudo solicitar salida.");
    } finally {
      this.readyForRouteLoading.set(false);
    }
  }

  async acceptDispatchFromSheet(order: Order) {
    const actor = this.currentRunActor();
    if (!actor) return;
    this.readyForRouteLoading.set(true);
    this.readyForRouteError.set(null);
    try {
      const runId = await this.routeRuns.acceptDispatchRequest({
        order: this.toDispatchOrder(order),
        routeName: this.routeName(order),
        customerName: this.customerName(order),
        actor,
      });
      await this.orders.logEvent(order.order_id, "dispatch_accepted", "Pedido agregado a salida", { runId });
      this.showActionToast("Pedido agregado a salida.");
      this.closeReadyForRouteSheet();
      await this.router.navigateByUrl(`/main/salidas/${runId}`);
    } catch (error: any) {
      this.readyForRouteError.set(error?.message || "No se pudo agregar a salida.");
    } finally {
      this.readyForRouteLoading.set(false);
    }
  }

  goToSalidas(order: Order) {
    const route = order.route_id || "sin_ruta";
    this.router.navigateByUrl(`/main/salidas?route=${encodeURIComponent(route)}`);
  }

  private toDispatchOrder(order: Order): DispatchOrderRow {
    return {
      order_id: order.order_id,
      customer_id: order.customer_id,
      route_id: order.route_id,
      status: order.status,
      route_run_id: order.route_run_id || null,
      dispatch_request: {
        status: order.dispatch_request?.status || "none",
        requested_at: order.dispatch_request?.requested_at || null,
        requested_by: order.dispatch_request?.requested_by || null,
        note: order.dispatch_request?.note || null,
      },
      packing: {
        status: order.packing?.status || "in_progress",
        packages_count: Number(order.packing?.packages_count || this.closedPackagesCount(order)),
        completed_at: order.packing?.completed_at || null,
      },
      totals: {
        total_amount: Number(order.totals?.total_amount || this.totals().totalClienta || 0),
        paid_amount: Number(order.totals?.paid_amount || 0),
        balance_due: Number(order.totals?.balance_due || this.orderBalanceDue(order)),
      },
      updated_at: order.updated_at,
    };
  }

  private currentRunActor(): { uid: string; name: string } | null {
    const user = this.authz.currentUserSig();
    if (!user) {
      this.readyForRouteError.set("No hay usuario activo.");
      return null;
    }
    return {
      uid: user.uid,
      name: user.displayName || user.email || "Usuario",
    };
  }

  async requestLateChange(order: Order) {
    await this.createIncidentAndRefresh(order.order_id, {
      orderId: order.order_id,
      packageId: null,
      itemId: null,
      type: "LATE_CHANGE",
      title: "Cambio tardío",
      severity: "medium",
      reason: "Solicitud de cambio tardío en ruta.",
      evidenceUrls: [],
      createdBy: "admin",
    });
    await this.orders.logEvent(order.order_id, "LATE_CHANGE_REQUESTED", "Cambio tardío solicitado", {});
    this.lateChangeApproved.set(true);
  }

  async createSupplierRequest(order: Order) {
    const confirmed = this.confirmedItems(order);
    if (confirmed.length === 0) {
      this.actionError.set("No hay items confirmados para solicitar.");
      return;
    }
    const missingSupplier = this.missingSupplierCount(order);
    if (missingSupplier > 0) {
      this.actionError.set(`Falta proveedor en catálogo para ${missingSupplier} items.`);
      return;
    }
    if (this.actionSaving()) return;
    this.actionSaving.set(true);
    const eta = this.supplierEta().trim() || null;
    const grouped = new Map<string, OrderItem[]>();
    for (const item of confirmed) {
      const supplierId = item.supplier_id as string;
      const list = grouped.get(supplierId) || [];
      list.push(item);
      grouped.set(supplierId, list);
    }
    const groups = Array.from(grouped.entries()).map(([supplierId, items]) => ({
      supplierId,
      supplierName: this.supplierNameById(supplierId),
      eta,
      items: items.map((item) => ({
        orderItemId: item.item_id,
        productId: item.product_id || null,
        qty: item.quantity,
        variant: item.variant || null,
        color: item.color || null,
      })),
    }));
    try {
      await this.orders.createSupplierOrders(order.order_id, groups, "admin");
      await this.orders.logEvent(order.order_id, "PROCUREMENT_CREATED", "Solicitudes creadas", {
        supplierOrderCount: groups.length,
        eta,
      });
      await this.refreshEvents();
      this.actionError.set(null);
      this.closeActionModal();
    } finally {
      this.actionSaving.set(false);
    }
  }

  async markInTransit(order: Order) {
    const eta = this.supplierEta().trim() || null;
    const supplierOrders = await this.orders.listSupplierOrders(order.order_id).catch(() => []);
    const hasSupplierOrders = supplierOrders.length > 0;
    const hasConfirmedSupplierItems = this.confirmedItems(order).some((item) => item.supplier_id);
    if (!hasSupplierOrders && !hasConfirmedSupplierItems) {
      this.actionError.set("No hay solicitudes a proveedor ni items confirmados con proveedor.");
      return;
    }
    if (this.actionSaving()) return;
    this.actionSaving.set(true);
    try {
      await this.supplierOperations.upsertFromConfirmedOrder(order, this.customerName(order));
      const pendingOps = this.supplierOperations
        .rows()
        .filter((row) => row.order_id === order.order_id && (row.status === "por_levantar" || row.status === "levantado"));

      if (pendingOps.length === 0) {
        this.actionError.set("No hay lineas pendientes para marcar en transito.");
        return;
      }

      await Promise.all(
        pendingOps.map((row) =>
          this.supplierOperations.updateLineState(row.op_id, "en_camino", undefined, { reload: false }),
        ),
      );
      await this.supplierOperations.loadFromFirestore();
      await this.orders.updateStatus(order.order_id, "inbound_in_transit");
      await this.orders.logEvent(order.order_id, "MARKED_INBOUND", "Pedido marcado en tránsito", {
        eta,
        updatedSupplierOps: pendingOps.length,
      });
      await this.refreshEvents();
      this.actionError.set(null);
      this.closeActionModal();
    } finally {
      this.actionSaving.set(false);
    }
  }

  openTransitConfirm() {
    this.transitConfirmOpen.set(true);
  }

  closeTransitConfirm() {
    this.transitConfirmOpen.set(false);
  }

  supplierTransitCandidatesCount(order: Order): number {
    return this.confirmedItems(order).filter((item) => {
      if (item.source === "inventario" || !(item.supplier_id || "").trim()) return false;
      const op = this.supplierOperationForItem(order, item);
      if (!op) return true;
      return op.status === "por_levantar" || op.status === "levantado";
    }).length;
  }

  async confirmMarkInTransit(order: Order) {
    if (this.actionSaving()) return;
    this.transitConfirmOpen.set(false);
    await this.markInTransit(order);
  }

  async confirmExistences(order: Order) {
    if (!this.allItemsResolved(order)) {
      this.actionError.set("Aún hay items sin resolver.");
      return;
    }
    const missingSupplier = this.missingSupplierCount(order);
    if (missingSupplier > 0) {
      this.actionError.set(`Falta proveedor en catálogo para ${missingSupplier} items confirmados.`);
      return;
    }
    if (this.actionSaving()) return;
    this.actionSaving.set(true);
    try {
      const hasConfirmedSupplierItems = this.confirmedItems(order).some(
        (item) => item.source === "catalogo" && !!(item.supplier_id || "").trim(),
      );
      const createdOps = await this.supplierOperations.upsertFromConfirmedOrder(order, this.customerName(order));
      let nextStatus = await this.orders.syncDerivedStatus(order.order_id);
      const refreshed = this.orders.getById(order.order_id);
      const stillConfirmPhase = this.phaseAction(refreshed || order)?.actionId === "confirm_items";
      if (stillConfirmPhase && !hasConfirmedSupplierItems) {
        nextStatus = "recibido_qa";
        await this.orders.updateStatus(order.order_id, nextStatus);
      }
      await this.orders.logEvent(order.order_id, "EXISTENCES_CONFIRMED", "Existencias confirmadas", {
        items: order.items.length,
        supplierOperations: createdOps,
        nextStatus: nextStatus || "recibido_qa",
      });
      await this.refreshEvents();
      this.actionError.set(null);
      this.closeActionModal();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Error desconocido al confirmar existencias.";
      this.actionError.set(`No se pudo confirmar existencias: ${message}`);
    } finally {
      this.actionSaving.set(false);
    }
  }

  openImagePreview(url: string) {
    this.imagePreviewUrl.set(url);
    this.imagePreviewLoading.set(true);
  }

  closeImagePreview() {
    this.imagePreviewUrl.set(null);
    this.imagePreviewLoading.set(false);
  }

  onPreviewImageLoaded() {
    this.imagePreviewLoading.set(false);
  }

  onPreviewImageError() {
    this.imagePreviewLoading.set(false);
  }

  onConfirmExistencesClick(order: Order) {
    const pending = this.pendingPieces(order);
    if (pending > 0) {
      this.actionError.set(`Tienes que solucionar las piezas pendientes (${pending}).`);
      return;
    }
    void this.confirmExistences(order);
  }

  openIncidentModal() {
    this.incidentType.set("GENERAL");
    this.incidentSeverity.set("medium");
    this.incidentTitle.set("Incidencia general");
    this.incidentReason.set("");
    this.incidentAssignee.set("");
    this.incidentModalOpen.set(true);
  }

  closeIncidentModal() {
    this.incidentModalOpen.set(false);
  }

  async createIncident() {
    const order = this.order();
    if (!order) return;
    const reason = this.incidentReason().trim();
    if (!reason) return;
    this.incidentSaving.set(true);
    try {
      await this.createIncidentAndRefresh(order.order_id, {
        orderId: order.order_id,
        packageId: null,
        itemId: null,
        type: this.incidentType(),
        severity: this.incidentSeverity(),
        title: this.incidentTitle().trim() || this.incidentType(),
        reason,
        assigneeId: this.incidentAssignee().trim() || null,
        evidenceUrls: [],
        createdBy: "admin",
      });
      await this.refreshEvents();
      this.incidentModalOpen.set(false);
    } finally {
      this.incidentSaving.set(false);
    }
  }

  openResolveModal(incident: Incident) {
    this.resolveTarget.set(incident);
    this.resolveNote.set("");
    this.resolveModalOpen.set(true);
  }

  closeResolveModal() {
    this.resolveModalOpen.set(false);
  }

  async confirmResolve() {
    const order = this.order();
    const incident = this.resolveTarget();
    if (!order || !incident) return;
    await this.orders.resolveIncident(order.order_id, incident.id, this.resolveNote().trim(), "admin");
    await this.loadIncidents();
    await this.refreshEvents();
    this.resolveModalOpen.set(false);
  }

  async attachEvidence(incident: Incident, event: Event) {
    const order = this.order();
    if (!order) return;
    const input = event.target as HTMLInputElement;
    if (!input.files || input.files.length === 0) return;
    const file = input.files[0];
    this.uploadingEvidence.update((current) => ({ ...current, [incident.id]: true }));
    try {
      await this.orders.uploadIncidentEvidence(order.order_id, incident.id, file, "admin");
      await this.loadIncidents();
      await this.refreshEvents();
    } finally {
      this.uploadingEvidence.update((current) => ({ ...current, [incident.id]: false }));
      input.value = "";
    }
  }

  isUploadingItemImage(item: OrderItem): boolean {
    return !!this.uploadingItemImage()[item.item_id];
  }

  async attachItemImage(order: Order | null, item: OrderItem, event: Event) {
    if (!order) return;
    if (!this.canEditItems(order)) return;
    const input = event.target as HTMLInputElement;
    if (!input.files || input.files.length === 0) return;
    const file = input.files[0];
    if (!file.type.startsWith("image/")) {
      await this.showPopupAlert("Solo puedes cargar archivos de imagen.", "Archivo invalido");
      input.value = "";
      return;
    }
    this.uploadingItemImage.update((current) => ({ ...current, [item.item_id]: true }));
    try {
      await this.orders.uploadOrderItemImage(order.order_id, item.item_id, file, "admin");
      this.showActionToast("Imagen cargada.");
    } catch {
      await this.showPopupAlert("No se pudo cargar la imagen. Intenta de nuevo.", "Error al cargar imagen");
    } finally {
      this.uploadingItemImage.update((current) => ({ ...current, [item.item_id]: false }));
      input.value = "";
    }
  }

  openAssignModal(incident: Incident) {
    this.assignTarget.set(incident);
    this.incidentAssignee.set(incident.assigneeId || "");
    this.assignModalOpen.set(true);
  }

  closeAssignModal() {
    this.assignModalOpen.set(false);
  }

  async confirmAssign() {
    const order = this.order();
    const incident = this.assignTarget();
    if (!order || !incident) return;
    const assignee = this.incidentAssignee().trim();
    if (!assignee) return;
    await this.orders.updateIncident(order.order_id, incident.id, {
      assigneeId: assignee,
    }, "admin");
    await this.loadIncidents();
    await this.refreshEvents();
    this.assignModalOpen.set(false);
  }

  scrollToTimeline() {
    this.timelineSection?.nativeElement.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  @HostListener("window:scroll")
  onWindowScroll() {
    const scrollTop =
      window.scrollY ||
      document.documentElement.scrollTop ||
      document.body.scrollTop ||
      0;
    this.updateStickyByScroll(scrollTop);
  }

  onPageScroll(event: Event) {
    const target = event.target as HTMLElement | null;
    const scrollTop = target?.scrollTop || 0;
    this.updateStickyByScroll(scrollTop);
  }

  private updateStickyByScroll(scrollTop: number) {
    this.showStickyFooter.set(scrollTop > 260);
    const headBottom = this.pageHead?.nativeElement?.getBoundingClientRect().bottom ?? Number.POSITIVE_INFINITY;
    const topbarBottom = document.querySelector(".topbar")?.getBoundingClientRect().bottom ?? 0;
    const shouldShowTopHeader = headBottom <= (topbarBottom + 8);
    this.showStickyHeader.set(shouldShowTopHeader);
    this.showStockFab.set(window.innerWidth <= 640 && scrollTop > 360);
  }

  async copyOrderId(orderId: string) {
    const value = (orderId || "").trim();
    if (!value) return;
    await navigator.clipboard.writeText(value).catch(() => null);
    this.copiedOrderId.set(true);
    setTimeout(() => this.copiedOrderId.set(false), 1200);
  }

  isConfirmItemsPhase(order: Order | null): boolean {
    return this.phaseAction(order)?.actionId === "confirm_items";
  }

  isOperationalConfirmPhase(order: Order | null): boolean {
    return !!order && order.status !== "borrador" && this.isConfirmItemsPhase(order);
  }

  canUseStockMenuActions(order: Order | null): boolean {
    if (!order) return false;
    if (!this.canEditItems(order)) return false;
    if (this.isOrderClosed(order)) return false;
    return this.isConfirmItemsPhase(order);
  }

  canUsePackingMenuActions(order: Order | null): boolean {
    if (!order) return false;
    if (!this.canEditItems(order)) return false;
    if (this.isOrderClosed(order)) return false;
    return this.isPackingWorkflowPhase(order);
  }

  isLateAddedItem(item: OrderItem): boolean {
    return item.late_addition === true || !!String(item.late_addition_note || "").trim();
  }

  lateAdditionStatus(item: OrderItem): "pending" | "arrived" | "missing" | "damaged" | null {
    const raw = String(item.late_addition_status || "").trim().toLowerCase();
    if (raw === "pending" || raw === "arrived" || raw === "missing" || raw === "damaged") return raw;
    if (this.isItemCancelledOrReturned(item)) return "missing";
    return null;
  }

  isLateArrivalConfirmed(item: OrderItem): boolean {
    return this.lateAdditionStatus(item) === "arrived";
  }

  hasLateAdditionNote(item: OrderItem): boolean {
    return !!String(item.late_addition_note || "").trim();
  }

  canConfirmLateArrival(order: Order | null, item: OrderItem): boolean {
    if (!this.canUsePackingMenuActions(order)) return false;
    if (!this.isLateAddedItem(item)) return false;
    if (this.isItemCancelledOrReturned(item)) return false;
    return !this.isLateArrivalConfirmed(item);
  }

  private normalizedItemState(item: OrderItem): string {
    return String(item.state || "").trim().toLowerCase();
  }

  isItemCancelledOrReturned(item: OrderItem): boolean {
    const state = this.normalizedItemState(item);
    return state === "cancelado" || state === "devuelto";
  }

  async viewLateAdditionNote(item: OrderItem) {
    const note = String(item.late_addition_note || "").trim();
    if (!note) return;
    await this.showPopupAlert(note, "Nota de excepción");
  }

  isProductMenuOpen(itemId: string): boolean {
    return this.openProductMenuId() === itemId;
  }

  toggleProductMenu(itemId: string) {
    this.openProductMenuId.update((current) => (current === itemId ? null : itemId));
  }

  closeProductMenus() {
    this.openProductMenuId.set(null);
  }

  async markItemAvailableFromMenu(order: Order, item: OrderItem) {
    if (!this.canUseStockMenuActions(order)) return;
    const qty = this.itemQuantity(item);
    await this.orders.updateItemConfirmation(order.order_id, item.item_id, {
      confirmation_state: "confirmed",
      confirmed_qty: qty,
    });
    if (["cancelado", "devuelto"].includes(item.state)) {
      const nextState: OrderItemState = item.source === "inventario" ? "reservado_inventario" : "confirmando_proveedor";
      await this.orders.updateItemState(order.order_id, item.item_id, nextState);
    }
    await this.orders.logEvent(order.order_id, "ITEM_MARKED_AVAILABLE", `Disponible (menu): ${item.title}`, {
      itemId: item.item_id,
      confirmedQty: qty,
    });
    this.closeProductMenus();
    this.showActionToast(`"${item.title}" marcado como disponible.`);
  }

  async markItemOutOfStockFromMenu(order: Order, item: OrderItem) {
    if (!this.canUseStockMenuActions(order)) return;
    const packedQty = this.itemPackedQty(order, item.item_id);
    if (packedQty > 0) {
      this.closeProductMenus();
      const ok = await this.showPopupConfirm(
        `"${item.title}" tiene ${packedQty} pza en cajas. Se sacarán antes de marcar agotado. ¿Continuar?`,
        {
          title: "Confirmar agotado",
          confirmLabel: "Si, marcar agotado",
          cancelLabel: "Cancelar",
        },
      );
      if (!ok) return;
      await this.detachItemFromPackages(order, item, "mark_out_of_stock");
    }
    await this.orders.updateItemConfirmation(order.order_id, item.item_id, {
      confirmation_state: "out_of_stock",
      confirmed_qty: 0,
    });
    await this.orders.logEvent(order.order_id, "ITEM_MARKED_OUT_OF_STOCK", `Agotado (menu): ${item.title}`, {
      itemId: item.item_id,
      packedQtyRemoved: packedQty,
    });
    this.closeProductMenus();
    this.showActionToast(`"${item.title}" marcado como agotado.`);
  }

  async confirmLateArrivalFromMenu(order: Order, item: OrderItem) {
    if (!this.canConfirmLateArrival(order, item)) return;
    this.closeProductMenus();
    const ok = await this.showPopupConfirm(
      `Confirmar llegada manual de "${item.title}"?\n\nSe registrará recepción y se apartará en inventario para este pedido.`,
      {
        title: "Confirmar llegada manual",
        confirmLabel: "Confirmar llegada",
        cancelLabel: "Cancelar",
      },
    );
    if (!ok) return;

    const qty = this.itemQuantity(item);
    const inventoryId = await this.ensureLateArrivalReservedInInventory(order, item, qty);
    const current = this.orders.getById(order.order_id) || order;
    const nextItems: OrderItem[] = (current.items || []).map((row): OrderItem => {
      if (row.item_id !== item.item_id) return row;
      return {
        ...row,
        confirmation_state: "confirmed" as const,
        confirmed_qty: qty,
        state: row.state === "cancelado" || row.state === "devuelto" ? "recibido_qa" : row.state,
        source: row.source === "inventario" || this.isSupplierManagedItem(row) ? row.source : "inventario",
        inventory_id: inventoryId || row.inventory_id || null,
        late_addition_status: "arrived",
      };
    });
    await this.orders.updateItems(order.order_id, nextItems);
    await this.orders.syncDerivedStatus(order.order_id).catch(() => null);
    await this.orders.logEvent(order.order_id, "ITEM_LATE_ARRIVAL_CONFIRMED", `Llegada manual confirmada: ${item.title}`, {
      itemId: item.item_id,
      qty,
      inventoryId,
      lateNote: item.late_addition_note || null,
    });
    this.showActionToast(`"${item.title}" confirmado y apartado en inventario.`);
  }

  async forcePackWithoutStock(order: Order, item: OrderItem) {
    if (!this.canUsePackingMenuActions(order)) return;
    if (this.isItemCancelledOrReturned(item)) return;
    this.closeProductMenus();
    const ok = await this.showPopupConfirm(
      `Se confirmara "${item.title}" para empaque sin confirmar llegada del proveedor. Se registrara aviso. ¿Continuar?`,
      {
        title: "Confirmar empaque sin llegada",
        confirmLabel: "Si, confirmar",
        cancelLabel: "Cancelar",
      },
    );
    if (!ok) return;
    const qty = this.itemQuantity(item);
    await this.orders.updateItemConfirmation(order.order_id, item.item_id, {
      confirmation_state: "confirmed",
      confirmed_qty: qty,
    });
    await this.orders.updateItemState(order.order_id, item.item_id, "empaque");
    await this.createIncidentAndRefresh(order.order_id, {
      orderId: order.order_id,
      packageId: null,
      itemId: item.item_id,
      type: "PACK_OVERRIDE_ITEM",
      title: "Empaque sin llegada confirmada",
      severity: "medium",
      reason: `Empaque sin confirmar llegada del proveedor: ${item.title}`,
      evidenceUrls: [],
      createdBy: "admin",
    });
    await this.orders.logEvent(order.order_id, "ITEM_PACK_OVERRIDE", `Empaque sin llegada confirmada: ${item.title}`, {
      itemId: item.item_id,
      qty,
    });
    this.closeProductMenus();
    this.showActionToast(`"${item.title}" se confirmo para empaque sin llegada.`);
  }

  async revertItemToPending(order: Order, item: OrderItem) {
    if (!this.canUseStockMenuActions(order)) return;
    const packedQty = this.itemPackedQty(order, item.item_id);
    const prompt = packedQty > 0
      ? `Regresar "${item.title}" a pendiente?\n\nSe removerán ${packedQty} pza de cajas antes de continuar.`
      : `Regresar "${item.title}" a pendiente?`;
    this.closeProductMenus();
    const ok = await this.showPopupConfirm(prompt, {
      title: "Regresar a pendiente",
      confirmLabel: "Si, regresar",
      cancelLabel: "Cancelar",
    });
    if (!ok) return;

    if (packedQty > 0) {
      await this.detachItemFromPackages(order, item, "revert_pending");
    }
    await this.orders.updateItemConfirmation(order.order_id, item.item_id, {
      confirmation_state: "pending",
      confirmed_qty: null,
    });
    const nextState: OrderItemState = item.source === "inventario" ? "reservado_inventario" : "confirmando_proveedor";
    await this.orders.updateItemState(order.order_id, item.item_id, nextState);
    await this.orders.logEvent(order.order_id, "ITEM_REVERTED_PENDING", `Regresado a pendiente: ${item.title}`, {
      itemId: item.item_id,
      packedQtyRemoved: packedQty,
    });
    this.closeProductMenus();
    this.showActionToast(`"${item.title}" regresó a pendiente.`);
  }

  async markMissingFromMenu(order: Order, item: OrderItem) {
    if (!this.canUsePackingMenuActions(order)) return;
    if (this.isItemCancelledOrReturned(item)) return;
    this.closeProductMenus();
    const ok = await this.showPopupConfirm(`Marcar "${item.title}" como faltante?`, {
      title: "Confirmar faltante",
      confirmLabel: "Si, marcar faltante",
      cancelLabel: "Cancelar",
      danger: true,
    });
    if (!ok) return;
    await this.patchLateAdditionStatus(order, item, "missing");
    await this.markMissing(order, item);
  }

  async markDamagedFromMenu(order: Order, item: OrderItem) {
    if (!this.canUsePackingMenuActions(order)) return;
    if (this.isItemCancelledOrReturned(item)) return;
    this.closeProductMenus();
    const ok = await this.showPopupConfirm(`Marcar "${item.title}" como dañado?`, {
      title: "Confirmar dañado",
      confirmLabel: "Si, marcar dañado",
      cancelLabel: "Cancelar",
      danger: true,
    });
    if (!ok) return;
    await this.patchLateAdditionStatus(order, item, "damaged");
    await this.markDamaged(order, item);
  }

  async removeItemFromMenu(order: Order, item: OrderItem) {
    this.closeProductMenus();
    await this.removeItem(order, item);
  }

  editItemFromMenu(item: OrderItem) {
    this.openEditItemModal(item);
  }

  scrollToSection(sectionId: "incidencias" | "productos" | "paquetes" | "bitacora") {
    document.getElementById(sectionId)?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  applyFocus(focus: string) {
    if (focus === "incidents" || focus === "incidents:new") {
      this.incidentsSection?.nativeElement.scrollIntoView({ behavior: "smooth", block: "start" });
      if (focus === "incidents:new") this.openIncidentModal();
    } else if (focus === "packages") {
      this.packagesSection?.nativeElement.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }

  packageCode(order: Order, pkg: PackageRecord): string {
    const qr = this.qrPlaceholder(order, pkg);
    return JSON.stringify(
      {
        orderId: order.order_id,
        packageId: pkg.package_id,
        status: this.packageStatus(pkg),
        label: this.packageDisplayLabel(order, pkg),
        qr,
        amountDue: pkg.amount_due,
      },
      null,
      0,
    );
  }

  qrPlaceholder(order: Order, pkg: PackageRecord): string {
    const existing = String((pkg as any).label_qr || "").trim();
    if (existing) return existing;
    return `QR:${order.order_id}:${pkg.package_id}`;
  }

  async copyQr(value: string) {
    const text = (value || "").trim();
    if (!text) return;
    await navigator.clipboard.writeText(text).catch(() => null);
    this.showActionToast("Copiado.");
  }

  backToList() {
    const fromQuery = String(this.route.snapshot.queryParamMap.get("from") || "").trim();
    if (fromQuery === "proveedores-operaciones") {
      const supplierId = String(this.route.snapshot.queryParamMap.get("supplierId") || "").trim();
      const groupKey = String(this.route.snapshot.queryParamMap.get("groupKey") || "").trim();
      this.router.navigate(["/main/proveedores-operaciones"], {
        queryParams: {
          from: "proveedores-operaciones",
          ...(supplierId ? { supplierId } : {}),
          ...(groupKey ? { groupKey } : {}),
          openGroup: 1,
        },
      });
      return;
    }

    const navState = (history.state || {}) as {
      from?: string;
      routeId?: string | null;
      scope?: string | null;
      drilldown?: string | null;
    };
    if (navState.from === "administracion") {
      const scope = String(navState.scope || "").trim();
      const drilldown = String(navState.drilldown || "").trim();
      this.router.navigate(["/main/administracion"], {
        queryParams: {
          ...(scope ? { scope } : {}),
          ...(drilldown ? { drilldown } : {}),
        },
      });
      return;
    }
    if (navState.from === "salidas") {
      const routeId = String(navState.routeId || "").trim();
      this.router.navigate(["/main/salidas"], {
        queryParams: {
          ...(routeId ? { routeId } : {}),
          openRoute: 1,
        },
      });
      return;
    }
    this.router.navigate(["/main/pedidos"]);
  }

  async addItem(order: Order | null) {
    if (!order) return;
    if (!this.canEditItems(order)) return;
    if (!this.isManualSource() && !this.selectedPreview()) {
      this.error.set("Selecciona un producto del catalogo o inventario, o usa captura manual.");
      return;
    }
    const title = this.newItemTitle().trim();
    if (!title) {
      this.error.set("Escribe el nombre del producto");
      return;
    }
    const qty = Math.max(1, this.newItemQty());
    if (this.newItemSource() === "inventario" && this.newItemInventoryId()) {
      const inv = this.inventoryById().get(this.newItemInventoryId()!);
      if (inv && inv.quantity_on_hand <= 0) {
        await this.showInventoryBlockedAlert(inv);
        this.selectedPreview.set(null);
        return;
      }
    }
    if (this.isClientaBelowCosto()) {
      await this.showClientaBelowCostoPopup();
      return;
    }
    const needsLateNote = this.requiresLateAdditionNote(order);
    const lateNote = needsLateNote ? await this.requestLateAdditionNote(order) : null;
    if (needsLateNote && !lateNote) return;

    const source = this.newItemSource();
    const state: OrderItemState = source === "inventario" ? "reservado_inventario" : "confirmando_proveedor";
    const lateMeta: Partial<OrderItem> | undefined = lateNote
      ? {
          late_addition: true,
          late_addition_note: lateNote,
          late_addition_status: "pending",
          late_addition_added_at: new Date().toISOString(),
          late_addition_added_in_status: order.status,
          late_addition_added_by: "admin",
        }
      : undefined;
    const item: OrderItem = this.buildOrderItemFromForm(`item-${Date.now()}`, source, state, lateMeta);
    const existingMatch = (order.items || []).find((row) => this.isSamePendingProduct(row, item));
    const canMergeExisting = !!existingMatch && this.canMergeIntoExistingRow(order, existingMatch) && !lateNote;
    if (existingMatch && canMergeExisting) {
      const nextItems = order.items.map((row) => {
        if (row.item_id !== existingMatch.item_id) return row;
        return {
          ...row,
          quantity: this.itemQuantity(row) + qty,
        };
      });
      await this.orders.updateItems(order.order_id, nextItems);
      await this.orders.logEvent(order.order_id, "ITEM_MERGED_QTY", `Cantidad actualizada: ${item.title}`, {
        itemId: existingMatch.item_id,
        addedQty: qty,
      });
      if (item.source === "inventario" && item.inventory_id) {
        const reserveKey = this.buildInventoryMutationKey("reserve", order.order_id, existingMatch.item_id, item.inventory_id, qty);
        await this.inventory.reserveStock({
          sku: item.inventory_id,
          qty,
          orderId: order.order_id,
          orderItemId: existingMatch.item_id,
          idempotencyKey: reserveKey,
        });
        await this.orders.logEvent(order.order_id, "INVENTORY_RESERVED", `Reserva inventario: ${item.title}`, {
          inventoryId: item.inventory_id,
          qty,
          idempotencyKey: reserveKey,
        });
      }
    } else {
      await this.orders.addItem(order.order_id, item);
      if (lateNote) {
        await this.orders.logEvent(order.order_id, "ITEM_ADDED_LATE", `Item agregado fuera de flujo: ${item.title}`, {
          itemId: item.item_id,
          source: item.source,
          note: lateNote,
          orderStatus: order.status,
        });
      } else {
        await this.orders.logEvent(order.order_id, "ITEM_ADDED", `Item agregado: ${item.title}`, {
          itemId: item.item_id,
          source: item.source,
        });
      }
      if (item.source === "inventario" && item.inventory_id) {
        const reserveKey = this.buildInventoryMutationKey("reserve", order.order_id, item.item_id, item.inventory_id, qty);
        await this.inventory.reserveStock({
          sku: item.inventory_id,
          qty,
          orderId: order.order_id,
          orderItemId: item.item_id,
          idempotencyKey: reserveKey,
        });
        await this.orders.logEvent(order.order_id, "INVENTORY_RESERVED", `Reserva inventario: ${item.title}`, {
          inventoryId: item.inventory_id,
          qty,
          idempotencyKey: reserveKey,
        });
      }
    }
    // Guardar al historial si es un item manual
    if (source === "manual") {
      void this.manualHistory.record({
        title: item.title,
        variant: item.variant || "",
        color: item.color || "",
        price_clienta: item.price_clienta ?? null,
        price_cost: item.price_cost ?? null,
      });
    }

    this.resetAddItemForm();
    if (lateNote) {
      this.addItemModalOpen.set(false);
    }
    await this.refreshEvents();
  }

  async convertManualItem(order: Order | null) {
    if (!order) return;
    if (!this.canEditItems(order)) return;
    const targetId = this.convertTargetItemId();
    if (!targetId) return;
    const target = (order.items || []).find((item) => item.item_id === targetId) || null;
    if (!target) {
      this.error.set("No encontramos el item manual a convertir.");
      return;
    }
    if (target.source !== "manual") {
      this.error.set("Solo se pueden convertir items manuales.");
      return;
    }
    if (!this.selectedPreview()) {
      this.error.set("Selecciona un producto de catalogo o inventario para convertir.");
      return;
    }
    const source = this.newItemSource();
    if (source === "manual") {
      this.error.set("El destino de conversion debe ser catalogo o inventario.");
      return;
    }
    const title = this.newItemTitle().trim();
    if (!title) {
      this.error.set("Escribe el nombre del producto");
      return;
    }
    const qty = Math.max(1, this.newItemQty());
    if (source === "inventario" && this.newItemInventoryId()) {
      const inv = this.inventoryById().get(this.newItemInventoryId()!);
      if (inv && inv.quantity_on_hand <= 0) {
        await this.showInventoryBlockedAlert(inv);
        this.selectedPreview.set(null);
        return;
      }
    }
    if (this.isClientaBelowCosto()) {
      await this.showClientaBelowCostoPopup();
      return;
    }
    const state: OrderItemState = source === "inventario" ? "reservado_inventario" : "confirmando_proveedor";
    const converted = this.buildOrderItemFromForm(target.item_id, source, state);
    const nextItems = (order.items || []).map((item) => (item.item_id === target.item_id ? converted : item));
    await this.orders.updateItems(order.order_id, nextItems);
    if (converted.source === "inventario" && converted.inventory_id) {
      const reserveKey = this.buildInventoryMutationKey("reserve", order.order_id, converted.item_id, converted.inventory_id, qty);
      await this.inventory.reserveStock({
        sku: converted.inventory_id,
        qty,
        orderId: order.order_id,
        orderItemId: converted.item_id,
        idempotencyKey: reserveKey,
      });
      await this.orders.logEvent(order.order_id, "INVENTORY_RESERVED", `Reserva inventario: ${converted.title}`, {
        inventoryId: converted.inventory_id,
        qty,
        idempotencyKey: reserveKey,
      });
    }
    await this.orders.logEvent(order.order_id, "ITEM_CONVERTED", `Item convertido: ${target.title}`, {
      itemId: target.item_id,
      from: "manual",
      to: converted.source,
      title: converted.title,
    });
    this.resetAddItemForm();
    this.addItemModalOpen.set(false);
    await this.refreshEvents();
    this.showActionToast("Item convertido.");
  }

  async updateExistingItem(order: Order | null) {
    if (!order) return;
    if (!this.canEditItems(order)) return;
    const targetId = this.editTargetItemId();
    if (!targetId) return;
    const live = this.orders.getById(order.order_id) || order;
    const target = (live.items || []).find((item) => item.item_id === targetId) || null;
    if (!target) {
      this.error.set("No encontramos el item a editar.");
      return;
    }

    const title = this.newItemTitle().trim();
    if (!title) {
      this.error.set("Escribe el nombre del producto.");
      return;
    }
    if (this.isClientaBelowCosto()) {
      await this.showClientaBelowCostoPopup();
      return;
    }

    const nextQty = Math.max(1, this.newItemQty());
    const packedQty = this.itemPackedQty(live, target.item_id);
    if (nextQty < packedQty) {
      this.error.set(`No puedes dejar ${nextQty} pieza(s): hay ${packedQty} ya empacada(s).`);
      return;
    }

    const nextState = target.confirmation_state || "pending";
    const nextConfirmedQty =
      nextState === "confirmed"
        ? Math.max(0, Math.min(nextQty, Number(target.confirmed_qty ?? nextQty)))
        : nextState === "out_of_stock"
          ? 0
          : null;

    const updated: OrderItem = {
      ...target,
      title,
      variant: this.newItemVariant().trim() || null,
      color: this.newItemColor().trim() || null,
      quantity: nextQty,
      price_public: this.newItemPricePublic(),
      price_clienta: this.newItemPriceClienta(),
      price_cost: this.newItemPriceCost(),
      discount_pct: this.newItemDiscount(),
      confirmed_qty: nextConfirmedQty,
      image_url: this.selectedPreview()?.image || target.image_url || null,
    };

    const nextItems = (live.items || []).map((item) => (item.item_id === target.item_id ? updated : item));
    await this.orders.updateItems(order.order_id, nextItems);

    if (target.source === "inventario" && target.inventory_id) {
      const delta = nextQty - this.itemQuantity(target);
      if (delta > 0) {
        const reserveKey = this.buildInventoryMutationKey("reserve", order.order_id, target.item_id, target.inventory_id, delta);
        await this.inventory.reserveStock({
          sku: target.inventory_id,
          qty: delta,
          orderId: order.order_id,
          orderItemId: target.item_id,
          idempotencyKey: reserveKey,
        });
        await this.orders.logEvent(order.order_id, "INVENTORY_RESERVED", `Reserva inventario: ${updated.title}`, {
          inventoryId: target.inventory_id,
          qty: delta,
          idempotencyKey: reserveKey,
        });
      } else if (delta < 0) {
        const releaseQty = Math.abs(delta);
        const releaseKey = this.buildInventoryMutationKey("release", order.order_id, target.item_id, target.inventory_id, releaseQty);
        await this.inventory.releaseReservation({
          sku: target.inventory_id,
          qty: releaseQty,
          orderId: order.order_id,
          orderItemId: target.item_id,
          idempotencyKey: releaseKey,
        });
        await this.orders.logEvent(order.order_id, "INVENTORY_RESERVATION_RELEASED", `Liberación inventario: ${updated.title}`, {
          inventoryId: target.inventory_id,
          qty: releaseQty,
          idempotencyKey: releaseKey,
        });
      }
    }

    await this.orders.logEvent(order.order_id, "ITEM_UPDATED", `Item editado: ${updated.title}`, {
      itemId: target.item_id,
      prevQty: this.itemQuantity(target),
      nextQty,
    });

    this.resetAddItemForm();
    this.addItemModalOpen.set(false);
    await this.refreshEvents();
    this.showActionToast("Producto actualizado.");
  }

  private buildOrderItemFromForm(
    itemId: string,
    source: "catalogo" | "inventario" | "manual",
    state: OrderItemState,
    extra?: Partial<OrderItem>,
  ): OrderItem {
    const base: OrderItem = {
      item_id: itemId,
      title: this.newItemTitle().trim(),
      variant: this.newItemVariant().trim() || null,
      color: this.newItemColor().trim() || null,
      quantity: Math.max(1, this.newItemQty()),
      source,
      state,
      confirmation_state: "pending",
      confirmed_qty: null,
      supplier_id: source === "manual" ? null : this.newItemSupplierId(),
      product_id: source === "manual" ? null : this.newItemProductId(),
      price_clienta: this.newItemPriceClienta(),
      price_public: this.newItemPricePublic(),
      price_cost: this.newItemPriceCost(),
      discount_pct: this.newItemDiscount(),
      inventory_id: source === "inventario" ? this.newItemInventoryId() : null,
      image_url: source === "manual" ? null : this.selectedPreview()?.image || null,
    };
    return { ...base, ...(extra || {}) };
  }

  private canMergeIntoExistingRow(order: Order, existing: OrderItem): boolean {
    if (existing.state === "cancelado" || existing.state === "devuelto") return false;
    if (existing.confirmation_state && existing.confirmation_state !== "pending") return false;
    if (this.itemPackedQty(order, existing.item_id) > 0) return false;
    return true;
  }

  private isSamePendingProduct(existing: OrderItem, incoming: OrderItem): boolean {
    // Detect rows that represent the same SKU/product+variant+color.
    // Late changes decide later if we merge or keep a separate line.
    if (existing.state === "cancelado" || existing.state === "devuelto") return false;
    if (existing.inventory_id && incoming.inventory_id) {
      return existing.inventory_id === incoming.inventory_id;
    }

    const sameVariant = this.isCompatibleVariant(existing.variant, incoming.variant);
    const sameColor = this.isCompatibleVariant(existing.color, incoming.color);

    if (existing.product_id && incoming.product_id && existing.product_id === incoming.product_id) {
      return sameVariant && sameColor;
    }

    return this.normalizeText(existing.title) === this.normalizeText(incoming.title)
      && sameVariant
      && sameColor;
  }

  private normalizeText(value: string | null | undefined): string {
    return (value || "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .trim()
      .toLowerCase();
  }

  private isCompatibleVariant(left: string | null | undefined, right: string | null | undefined): boolean {
    const a = this.normalizeText(left);
    const b = this.normalizeText(right);
    return a === b || !a || !b;
  }

  private async patchLateAdditionStatus(
    order: Order,
    item: OrderItem,
    status: "pending" | "arrived" | "missing" | "damaged",
  ): Promise<void> {
    if (!this.isLateAddedItem(item)) return;
    const live = this.orders.getById(order.order_id) || order;
    const nextItems = (live.items || []).map((row) =>
      row.item_id === item.item_id ? { ...row, late_addition_status: status } : row,
    );
    await this.orders.updateItems(order.order_id, nextItems);
  }

  private async ensureLateArrivalReservedInInventory(order: Order, item: OrderItem, qty: number): Promise<string | null> {
    if (qty <= 0) return item.inventory_id || null;
    if (item.source === "inventario" && item.inventory_id) {
      return item.inventory_id;
    }

    if (this.isSupplierManagedItem(item)) {
      const current = this.orders.getById(order.order_id) || order;
      const withConfirmed: OrderItem[] = (current.items || []).map((row): OrderItem =>
        row.item_id === item.item_id
          ? { ...row, confirmation_state: "confirmed" as const, confirmed_qty: qty }
          : row,
      );
      await this.orders.updateItems(order.order_id, withConfirmed);
      const refreshed = this.orders.getById(order.order_id) || { ...order, items: withConfirmed };
      await this.supplierOperations.upsertFromConfirmedOrder(refreshed, this.customerName(refreshed));
      await this.supplierOperations.updateStatus(this.supplierOpId(order, item), "recibido");
      const latestOp = this.supplierOperationForItem(order, item);
      return latestOp?.inventory_item_id || item.inventory_id || null;
    }

    const inventoryId = (item.inventory_id || "").trim() || this.buildLateArrivalInventoryId(item);
    const inboundKey = `late_inbound_${order.order_id}_${item.item_id}_${inventoryId}_${qty}`;
    await this.inventory.receiveInbound({
      sku: inventoryId,
      qty,
      supplierOperationId: `late-${order.order_id}-${item.item_id}`,
      lineId: item.item_id,
      idempotencyKey: inboundKey,
      title: item.title,
      supplier_id: item.supplier_id ?? null,
      variant_name: item.variant || null,
      color_name: item.color || null,
      image_url: item.image_url || null,
    });
    const reserveKey = this.buildInventoryMutationKey("reserve", order.order_id, item.item_id, inventoryId, qty);
    await this.inventory.reserveStock({
      sku: inventoryId,
      qty,
      orderId: order.order_id,
      orderItemId: item.item_id,
      idempotencyKey: reserveKey,
    });
    await this.orders.logEvent(order.order_id, "INVENTORY_RESERVED", `Reserva inventario (llegada manual): ${item.title}`, {
      itemId: item.item_id,
      inventoryId,
      qty,
      idempotencyKey: reserveKey,
    });
    return inventoryId;
  }

  private buildLateArrivalInventoryId(item: OrderItem): string {
    const seed = [
      item.supplier_id || "manual",
      item.product_id || item.title || "producto",
      item.variant || "",
      item.color || "",
    ].join("-");
    const slug = this.slugifyForInventory(seed || item.item_id).slice(0, 54) || "producto";
    return `inv-late-${slug}`;
  }

  private slugifyForInventory(value: string): string {
    return String(value || "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
  }

  private async reconcileSupplierOperationOnItemRemoval(order: Order, item: OrderItem): Promise<void> {
    const row = await this.supplierOperations.getByOrderItem(order.order_id, item.item_id);
    if (!row) return;

    const supplierName = row.supplier_name || this.supplierNameById(row.supplier_id) || "proveedor";
    const productName = item.title || row.title || "Este producto";

    if (row.status === "por_levantar") {
      await this.supplierOperations.deleteLine(row.op_id, { releaseReservation: true });
      return;
    }

    if (row.status === "levantado") {
      const canCancel = await this.showPopupConfirm(
        `"${productName}" ya esta solicitado con ${supplierName}.\n\n` +
        `¿Pudiste cancelarlo con proveedor?\n\n` +
        `Aceptar: Cancelar orden con proveedor.\n` +
        `Cancelar: No se pudo cancelar; cuando llegue entrara a inventario sin apartarse para este pedido.`,
        {
          title: "Confirmar cancelacion con proveedor",
          confirmLabel: "Si, se cancelo",
          cancelLabel: "No, sigue en camino",
        },
      );
      if (canCancel) {
        await this.supplierOperations.deleteLine(row.op_id, { releaseReservation: true });
      } else {
        await this.supplierOperations.detachLineFromOrder(row.op_id, { releaseReservation: true });
      }
      return;
    }

    if (row.status === "en_camino") {
      const willArrive = await this.showPopupConfirm(
        `"${productName}" esta marcado EN CAMINO con ${supplierName}.\n\n` +
        `¿Confirmas que si va a llegar?`,
        {
          title: "Producto en camino",
          confirmLabel: "Si, si llegara",
          cancelLabel: "No, cancelar con proveedor",
        },
      );
      if (willArrive) {
        await this.supplierOperations.detachLineFromOrder(row.op_id, { releaseReservation: true });
      } else {
        await this.supplierOperations.deleteLine(row.op_id, { releaseReservation: true });
      }
      return;
    }

    if (row.status === "recibido") {
      const wasReceived = await this.showPopupConfirm(
        `"${productName}" esta marcado como RECIBIDO en bodega.\n\n` +
        `¿Se recibio exitosamente?\n\n` +
        `Aceptar: Fue recibido.\n` +
        `Cancelar: Nunca se recibio; se revertira inventario si esta dado de alta por esta recepcion.`,
        {
          title: "Producto recibido en bodega",
          confirmLabel: "Si, fue recibido",
          cancelLabel: "No, revertir recepcion",
        },
      );
      if (wasReceived) {
        await this.supplierOperations.detachLineFromOrder(row.op_id, { releaseReservation: true });
      } else {
        await this.supplierOperations.deleteLine(row.op_id, {
          releaseReservation: true,
          rollbackReceivedInventory: true,
        });
      }
      return;
    }

    await this.supplierOperations.detachLineFromOrder(row.op_id, { releaseReservation: true });
  }

  async removeItem(order: Order | null, item: OrderItem) {
    if (!order) return;
    if (!this.canEditItems(order)) return;
    const packedQty = this.itemPackedQty(order, item.item_id);
    const prompt = packedQty > 0
      ? `Quitar "${item.title}" del pedido?\n\nSe sacarán ${packedQty} pieza(s) de las cajas antes de eliminarlo.`
      : `Quitar "${item.title}" del pedido?`;
    const ok = await this.showPopupConfirm(prompt, {
      title: "Quitar producto",
      confirmLabel: "Quitar",
      cancelLabel: "Cancelar",
      danger: true,
    });
    if (!ok) return;
    this.closeProductMenus();

    if (packedQty > 0) {
      await this.detachItemFromPackages(order, item, "PRODUCT_REMOVED");
    }

    await this.reconcileSupplierOperationOnItemRemoval(order, item);

    if (item.source === "inventario" && item.inventory_id) {
      const releaseKey = this.buildInventoryMutationKey("release", order.order_id, item.item_id, item.inventory_id, item.quantity);
      await this.inventory.releaseReservation({
        sku: item.inventory_id,
        qty: item.quantity,
        orderId: order.order_id,
        orderItemId: item.item_id,
        idempotencyKey: releaseKey,
      });
      await this.orders.logEvent(order.order_id, "INVENTORY_RESERVATION_RELEASED", `Liberación inventario: ${item.title}`, {
        inventoryId: item.inventory_id,
        qty: item.quantity,
        idempotencyKey: releaseKey,
      });
    }

    const live = this.orders.getById(order.order_id) || order;
    const nextItems = (live.items || []).filter((row) => row.item_id !== item.item_id);
    await this.orders.updateItems(order.order_id, nextItems);
    await this.orders.syncDerivedStatus(order.order_id).catch(() => null);
    await this.orders.logEvent(order.order_id, "ITEM_REMOVED", `Item removido: ${item.title}`, {
      itemId: item.item_id,
    });
    this.showActionToast(`"${item.title}" eliminado del pedido.`);
  }

  private async detachItemFromPackages(order: Order, item: OrderItem, reason: string): Promise<void> {
    const packedQty = this.itemPackedQty(order, item.item_id);
    if (packedQty <= 0) return;

    const nextPackages = (order.packages || [])
      .map((pkg) => {
        const nextEntries = this.packageItems(pkg).filter((entry) => entry.orderItemId !== item.item_id);
        return this.patchPackage(pkg, { items: nextEntries, item_ids: nextEntries.map((entry) => entry.orderItemId) });
      })
      .filter((pkg) => this.packageHasItems(pkg));

    await this.orders.updatePackages(order.order_id, nextPackages);
    this.syncActiveOpenBoxAfterPackages(nextPackages, this.activeOpenBoxId());
    await this.orders.logEvent(order.order_id, "ITEM_REMOVED_FROM_PACKAGES", `Producto removido de cajas: ${item.title}`, {
      itemId: item.item_id,
      packedQty,
      reason,
    });
  }

  async pickInventory(item: InventoryItem) {
    if (item.quantity_on_hand <= 0) {
      await this.showInventoryBlockedAlert(item);
      this.selectedPreview.set(null);
      this.newItemInventoryId.set(null);
      this.lockItemFields.set(false);
      this.showProductList.set(true);
      this.focusProductSearchInput();
      return;
    }
    const image = item.image_urls?.[0] || null;
    const costo = item.unit_price || null;
    const final = costo !== null ? Number((costo * 2).toFixed(2)) : null;
    this.newItemTitle.set(item.title);
    this.newItemVariant.set(item.variant_name || item.size_label || "");
    this.newItemColor.set(item.color_name || "");
    this.newItemPricePublic.set(final);
    this.newItemPriceClienta.set(this.computeClientaPrice(final));
    this.newItemPriceCost.set(costo);
    this.updatePriceDraftFromSignals();
    this.newItemSource.set("inventario");
    this.newItemSearch.set("");
    this.newItemInventoryId.set(item.inventory_id);
    this.newItemSupplierId.set(item.supplier_id || null);
    this.newItemProductId.set(item.inventory_id || null);
    this.showProductList.set(false);
    this.lockItemFields.set(true);
    this.catalogVariantOptions.set([]);
    this.catalogColorOptions.set([]);
    this.supplierDiscountPct.set(null);
    this.supplierDiscountLabel.set(null);
    this.selectedPreviewHasColorImage.set(Boolean(image));
    this.selectedPreview.set({
      title: item.title,
      variant: this.newItemVariant(),
      color: this.newItemColor(),
      image,
      source: "Inventario",
    });
    this.selectedCatalogDoc.set(null);
  }

  pickCatalog(doc: NormalizedListingDoc, variant: any, color: string) {
    const listing = doc.listing || { items: [] } as any;
    const variants = (listing.items || []).map((it: any) => it.variant_name || "Sin variante");
    const colors = this.getVariantColors(variant);
    const selectedColor = color || colors[0] || "";
    const prices = this.getVariantPriceSet(variant);
    const colorImage = this.resolveColorImage(doc, selectedColor);
    const image = colorImage || variant?.image_url || doc.cover_images?.[0] || doc.preview_image_url || null;
    this.newItemTitle.set(listing.title || "Producto sin nombre");
    this.newItemVariant.set(variant?.variant_name || variants[0] || "");
    this.newItemColor.set(selectedColor);
    this.newItemPricePublic.set(prices.final);
    this.newItemPriceClienta.set(this.computeClientaPrice(prices.final));
    this.newItemPriceCost.set(prices.costo);
    this.updatePriceDraftFromSignals();
    this.newItemSource.set("catalogo");
    this.newItemSearch.set("");
    this.newItemInventoryId.set(null);
    this.newItemSupplierId.set(doc.supplier_id || null);
    this.newItemProductId.set(doc.normalized_id || null);
    this.showProductList.set(false);
    this.lockItemFields.set(true);
    this.catalogVariantOptions.set([...new Set(variants)]);
    this.catalogColorOptions.set(colors);
    this.supplierDiscountPct.set(null);
    this.supplierDiscountLabel.set(null);
    this.selectedPreviewHasColorImage.set(Boolean(colorImage));
    this.selectedPreview.set({
      title: this.newItemTitle(),
      variant: this.newItemVariant(),
      color: this.newItemColor(),
      image,
      source: "Catálogo",
    });
    this.selectedCatalogDoc.set(doc);
  }

  closeProductListSoon() {
    if (this.suppressProductBlur()) {
      this.suppressProductBlur.set(false);
      return;
    }
    setTimeout(() => this.showProductList.set(false), 120);
  }

  beginProductPick() {
    this.suppressProductBlur.set(true);
  }

  onVariantChange(value: string) {
    this.newItemVariant.set(value);
    const doc = this.selectedCatalogDoc();
    if (!doc) return;
    const listing: any = doc.listing || { items: [] };
    const variant = (listing.items || []).find((it: any) => it.variant_name === value) || null;
    if (!variant) return;
    const prices = this.getVariantPriceSet(variant);
    this.newItemPricePublic.set(prices.final);
    this.newItemPriceClienta.set(this.computeClientaPrice(prices.final));
    this.newItemPriceCost.set(prices.costo);
    this.updatePriceDraftFromSignals();

    const colors = this.getVariantColors(variant);
    this.catalogColorOptions.set(colors);
    const currentColor = this.newItemColor().trim();
    if (colors.length > 0) {
      const nextColor = colors.find((c: string) => c.toLowerCase() === currentColor.toLowerCase()) || colors[0];
      this.newItemColor.set(nextColor);
    }
    const selectedColor = this.newItemColor().trim();
    const colorImage = this.resolveColorImage(doc, selectedColor);
    const image = colorImage || variant?.image_url || doc.cover_images?.[0] || doc.preview_image_url || null;
    const hasColorImage = Boolean(colorImage);
    this.selectedPreviewHasColorImage.set(hasColorImage);
    this.selectedPreview.update((prev) =>
      prev
        ? {
            ...prev,
            variant: value,
            color: selectedColor,
            image,
          }
        : prev
    );
  }

  onColorChange(value: string) {
    this.newItemColor.set(value);
    const doc = this.selectedCatalogDoc();
    if (!doc) return;
    const listing: any = doc.listing || { items: [] };
    const variant = (listing.items || []).find((it: any) => (it.variant_name || "") === this.newItemVariant()) || null;
    const colorImage = this.resolveColorImage(doc, value);
    const image = colorImage || variant?.image_url || doc.cover_images?.[0] || doc.preview_image_url || null;
    const hasColorImage = Boolean(colorImage);
    this.selectedPreviewHasColorImage.set(hasColorImage);
    this.selectedPreview.update((prev) =>
      prev
        ? {
            ...prev,
            color: value,
            image,
          }
        : prev
    );
  }

  private getVariantColors(variant: any): string[] {
    const fromColorStock = (variant?.color_stock || []).map((entry: any) => entry?.color_name);
    const fromColorNames = Array.isArray(variant?.color_names) ? variant.color_names : [];
    const fromLegacy = Array.isArray(variant?.colors) ? variant.colors : [];
    const all = [...fromColorStock, ...fromColorNames, ...fromLegacy]
      .map((value) => (typeof value === "string" ? value.trim() : ""))
      .filter(Boolean);
    return Array.from(new Set(all));
  }

  private resolveColorImage(doc: NormalizedListingDoc, colorName: string | null | undefined): string | null {
    const target = (colorName || "").trim().toLowerCase();
    if (!target) return null;
    return (
      (doc.product_colors || []).find((c) => (c.name || "").trim().toLowerCase() === target)?.image_url || null
    );
  }

  private getVariantPriceSet(variant: any): { final: number | null; clienta: number | null; costo: number | null } {
    const prices = variant?.prices;
    if (Array.isArray(prices)) {
      const amount = prices[0]?.amount;
      return {
        final: typeof amount === "number" ? amount : null,
        clienta: null,
        costo: null,
      };
    }
    if (prices && typeof prices === "object") {
      return {
        final: typeof prices.precio_final === "number" ? prices.precio_final : null,
        clienta: typeof prices.precio_clienta === "number" ? prices.precio_clienta : null,
        costo: typeof prices.precio_costo === "number" ? prices.precio_costo : null,
      };
    }
    return { final: null, clienta: null, costo: null };
  }

  priceDisplayValue(field: "final" | "clienta" | "costo"): string {
    if (this.priceInputFocused() === field) {
      return this.priceInputDraft()[field];
    }
    const value = this.getPriceValue(field);
    return this.formatThousands(value);
  }

  onPriceInputFocus(field: "final" | "clienta" | "costo") {
    this.priceInputFocused.set(field);
    const current = this.getPriceValue(field);
    this.priceInputDraft.update((draft) => ({
      ...draft,
      [field]: current === null ? "" : String(current),
    }));
  }

  onPriceInputChange(field: "final" | "clienta" | "costo", raw: string) {
    this.priceInputDraft.update((draft) => ({ ...draft, [field]: raw }));
    this.setPriceValue(field, this.parseMoney(raw));
  }

  onPriceInputBlur(field: "final" | "clienta" | "costo") {
    const raw = this.priceInputDraft()[field];
    this.setPriceValue(field, this.parseMoney(raw));
    this.priceInputFocused.set(null);
    this.updatePriceDraftFromSignals();
    if (field === "final" || field === "costo") {
      this.warnIfClientaBelowCosto();
    }
  }

  priceRuleInvalid(): boolean {
    return this.isClientaBelowCosto();
  }

  private updatePriceDraftFromSignals() {
    this.priceInputDraft.set({
      final: this.newItemPricePublic() === null ? "" : String(this.newItemPricePublic()),
      clienta: this.newItemPriceClienta() === null ? "" : String(this.newItemPriceClienta()),
      costo: this.newItemPriceCost() === null ? "" : String(this.newItemPriceCost()),
    });
  }

  private getPriceValue(field: "final" | "clienta" | "costo"): number | null {
    if (field === "final") return this.newItemPricePublic();
    if (field === "clienta") return this.newItemPriceClienta();
    return this.newItemPriceCost();
  }

  private setPriceValue(field: "final" | "clienta" | "costo", value: number | null) {
    if (field === "final") {
      this.newItemPricePublic.set(value);
      this.newItemPriceClienta.set(this.computeClientaPrice(value));
      return;
    }
    if (field === "clienta") {
      this.newItemPriceClienta.set(value);
      return;
    }
    this.newItemPriceCost.set(value);
  }

  private parseMoney(raw: string): number | null {
    const normalized = (raw || "").replace(/,/g, "").trim();
    if (!normalized) return null;
    const parsed = Number(normalized);
    if (!Number.isFinite(parsed)) return null;
    return Number(parsed.toFixed(2));
  }

  private formatThousands(value: number | null): string {
    if (value === null || value === undefined || Number.isNaN(value)) return "";
    return new Intl.NumberFormat("es-MX", {
      minimumFractionDigits: 0,
      maximumFractionDigits: 2,
    }).format(value);
  }

  private computeClientaPrice(finalPrice: number | null): number | null {
    if (finalPrice === null || finalPrice === undefined || Number.isNaN(finalPrice)) return null;
    return Number((finalPrice * 0.75).toFixed(2));
  }

  private isClientaBelowCosto(): boolean {
    const clienta = this.newItemPriceClienta();
    const costo = this.newItemPriceCost();
    if (clienta === null || costo === null) return false;
    return clienta < costo;
  }

  private warnIfClientaBelowCosto() {
    if (!this.isClientaBelowCosto()) return;
    void this.showClientaBelowCostoPopup();
  }

  formatCurrency(value: number | null): string {
    if (value === null || value === undefined || Number.isNaN(value)) return "";
    return new Intl.NumberFormat("es-MX", { style: "currency", currency: "MXN" }).format(value);
  }

  private async buildInventoryBlockedAlert(item: InventoryItem): Promise<{
    itemTitle: string;
    reservedBy: string;
    customerName: string;
    orderId: string;
  }> {
    const holder = this.findOrderHoldingInventory(item.inventory_id);
    const nameFromEvents = holder?.orderId ? await this.findReservedByFromEvents(holder.orderId) : null;
    return {
      itemTitle: item.title || "este articulo",
      reservedBy: this.toFirstName(nameFromEvents || holder?.reservedBy || "Admin"),
      customerName: holder?.customerName || "otra clienta",
      orderId: holder?.orderId || "otro pedido",
    };
  }

  private async showInventoryBlockedAlert(item: InventoryItem) {
    const now = Date.now();
    if (now - this.lastInventoryBlockedAlertAt < 600) return;
    this.lastInventoryBlockedAlertAt = now;
    const blocked = await this.buildInventoryBlockedAlert(item);
    await this.showPopupAlert(
      `No puedes anadir ${blocked.itemTitle} a este pedido ya que ${blocked.reservedBy} lo aparto para ${blocked.customerName} en el pedido ${blocked.orderId}.`,
      "Inventario reservado",
    );
    if (blocked.orderId && blocked.orderId !== "otro pedido") {
      await navigator.clipboard.writeText(blocked.orderId).catch(() => null);
    }
  }

  private focusProductSearchInput() {
    setTimeout(() => this.productSearchInput?.nativeElement.focus(), 0);
  }

  private findOrderHoldingInventory(inventoryId: string): { orderId: string; customerName: string; reservedBy: string } | null {
    const rows = this.orders.list();
    const closedStatuses: OrderStatus[] = ["entregado", "pagado", "cancelado", "devuelto"];
    const active = rows.find((order) => {
      if (closedStatuses.includes(order.status)) return false;
      return (order.items || []).some((it) =>
        it.source === "inventario" &&
        it.inventory_id === inventoryId &&
        it.state !== "cancelado" &&
        it.state !== "devuelto",
      );
    });
    const fallback = rows.find((order) =>
      (order.items || []).some((it) => it.source === "inventario" && it.inventory_id === inventoryId),
    );
    const picked = active || fallback;
    if (!picked) return null;
    const actor = [...(picked.timeline || [])].reverse().find((entry) => !!entry.actor)?.actor || null;
    return {
      orderId: picked.order_id,
      customerName: this.customerName(picked),
      reservedBy: String(actor || "Admin"),
    };
  }

  private async findReservedByFromEvents(orderId: string): Promise<string | null> {
    try {
      const snap = await getDocs(
        query(collection(FIRESTORE, "orders", orderId, "events"), orderBy("createdAt", "desc"), limit(20)),
      );
      for (const docSnap of snap.docs) {
        const data = docSnap.data() as any;
        const actorName = String(data?.actor?.name || data?.createdBy || "").trim();
        if (actorName && actorName.toLowerCase() !== "sistema") return actorName;
      }
      return null;
    } catch {
      return null;
    }
  }

  private toFirstName(fullName: string): string {
    const clean = String(fullName || "").trim();
    if (!clean) return "Admin";
    return clean.split(/\s+/)[0] || "Admin";
  }

  private toNameAndFirstSurname(value: string): string {
    const raw = String(value || "").trim();
    if (!raw) return "Sistema";

    const tokensFromEmail = raw.includes("@")
      ? raw.split("@")[0].split(/[._-]+/)
      : raw.split(/\s+/);

    const tokens = tokensFromEmail
      .map((token) => token.replace(/[^A-Za-z0-9ÁÉÍÓÚáéíóúÑñÜü]/g, "").trim())
      .filter(Boolean);

    if (tokens.length === 0) return raw;

    const particles = new Set(["de", "del", "la", "las", "los", "y"]);
    const firstName = this.toNameTokenCase(tokens[0]);
    const surnameRaw = tokens
      .slice(1)
      .find((token) => !particles.has(token.toLowerCase()))
      || tokens[1]
      || "";
    const surname = this.toNameTokenCase(surnameRaw);

    return `${firstName}${surname ? ` ${surname}` : ""}`.trim() || raw;
  }

  private toNameTokenCase(token: string): string {
    const clean = String(token || "").trim();
    if (!clean) return "";
    if (clean.length <= 3 && clean === clean.toUpperCase()) return clean;
    return `${clean[0].toUpperCase()}${clean.slice(1).toLowerCase()}`;
  }

  itemPriceLabel(item: OrderItem): string {
    const value = item.price_clienta ?? item.price_public ?? item.price_cost ?? null;
    if (value === null || value === undefined || Number.isNaN(value)) return "Sin precio";
    return this.formatCurrency(value);
  }

  private buildInventoryMutationKey(
    action: "reserve" | "release",
    orderId: string,
    orderItemId: string,
    inventoryId: string,
    qty: number,
  ): string {
    return `${action}_${orderId}_${orderItemId}_${inventoryId}_${Math.max(0, Math.trunc(qty))}`;
  }
}
