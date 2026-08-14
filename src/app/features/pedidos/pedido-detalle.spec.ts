import { signal, WritableSignal } from "@angular/core";
import { ComponentFixture, TestBed } from "@angular/core/testing";
import { ActivatedRoute, Router } from "@angular/router";
import PedidoDetallePage from "./pedido-detalle";
import { OrdersService } from "../../core/orders.service";
import { CustomersService } from "../../core/customers.service";
import { CustomerFollowupsService } from "../../core/customer-followups.service";
import { SuppliersService } from "../../core/suppliers.service";
import { RoutesService } from "../../core/routes.service";
import { LocalitiesService } from "../../core/localities.service";
import {
  InventoryItem,
  InventoryService,
  InventoryStockInsufficientError,
} from "../../core/inventory.service";
import { NormalizedListingDoc, NormalizedListingsService } from "../../core/normalized-listings.service";
import { CatalogProductsService } from "../../core/catalog-products.service";
import { CatalogImportJobsService } from "../../core/catalog-import-jobs.service";
import { BarcodeProductLookupService } from "../../core/barcode-product-lookup.service";
import { PhysicalBarcodeScannerService } from "../../core/physical-barcode-scanner.service";
import {
  SupplierOperationRow,
  SupplierOperationsService,
} from "../../core/supplier-operations.service";
import { ManualProductHistoryService } from "../../core/manual-product-history.service";
import { ReturnsService } from "../../core/returns.service";
import { FinanceService } from "../../core/finance.service";
import { BusinessScopeService } from "../../core/business-scope.service";
import { AuthzService } from "../../core/authz.service";
import { AuthService } from "../../core/auth.service";
import { SalesNoteRenderService } from "./sales-note-render.service";
import { RouteRunsService } from "../../services/route-runs.service";
import { ShipmentsService } from "../../core/shipments.service";
import { OperationalExpenseReportsService } from "../../core/operational-expense-reports.service";
import { UserAdminApiService } from "../../services/user-admin-api.service";
import type { Order, OrderItem } from "../../core/orders.service";
import type { CatalogProduct, CatalogProductSearchResult } from "../../core/catalog-products.service";

/**
 * Estas pruebas cubren la lógica aislada de selección, precios, inventario,
 * opción provisional, badge por producto y tabs.
 * No renderizan el template (no se llama a fixture.detectChanges())
 * para evitar disparar ngOnInit(), que dispara llamadas reales a servicios
 * (watch() de suscripciones, resolucion de ruta) fuera del alcance de estas
 * pruebas unitarias.
 */
describe("PedidoDetallePage - descuento Precio clienta y tabs", () => {
  let component: PedidoDetallePage;
  let fixture: ComponentFixture<PedidoDetallePage>;
  let inventoryRows: WritableSignal<InventoryItem[]>;
  let reserveStock: jasmine.Spy;
  let releaseReservation: jasmine.Spy;
  let loadInventory: jasmine.Spy;
  let addOrderItem: jasmine.Spy;
  let updateOrderItems: jasmine.Spy;
  let logOrderEvent: jasmine.Spy;
  let ordersGetById: jasmine.Spy;
  let syncDerivedStatus: jasmine.Spy;
  let supplierRows: WritableSignal<SupplierOperationRow[]>;
  let upsertSupplierOperations: jasmine.Spy;
  let receiveSupplierLine: jasmine.Spy;
  let loadSupplierOperations: jasmine.Spy;
  let getRawPostImageUrls: jasmine.Spy;

  const routeMock = {
    snapshot: { paramMap: { get: () => null }, queryParamMap: { get: () => null } },
    queryParamMap: { pipe: () => ({ subscribe: () => {} }) },
  };

  beforeEach(async () => {
    inventoryRows = signal<InventoryItem[]>([]);
    reserveStock = jasmine.createSpy("reserveStock").and.resolveTo();
    releaseReservation = jasmine.createSpy("releaseReservation").and.resolveTo();
    loadInventory = jasmine.createSpy("loadFromFirestore").and.resolveTo();
    addOrderItem = jasmine.createSpy("addItem").and.resolveTo();
    updateOrderItems = jasmine.createSpy("updateItems").and.resolveTo();
    logOrderEvent = jasmine.createSpy("logEvent").and.resolveTo();
    ordersGetById = jasmine.createSpy("getById").and.returnValue(null);
    syncDerivedStatus = jasmine.createSpy("syncDerivedStatus").and.resolveTo("recibido_qa");
    supplierRows = signal<SupplierOperationRow[]>([]);
    upsertSupplierOperations = jasmine.createSpy("upsertFromConfirmedOrder").and.resolveTo(0);
    receiveSupplierLine = jasmine.createSpy("receiveLineAndAllocate").and.resolveTo();
    loadSupplierOperations = jasmine.createSpy("loadFromFirestore").and.resolveTo();
    getRawPostImageUrls = jasmine.createSpy("getRawPostImageUrls").and.resolveTo([]);

    await TestBed.configureTestingModule({
      imports: [PedidoDetallePage],
      providers: [
        { provide: ActivatedRoute, useValue: routeMock },
        { provide: Router, useValue: { events: { pipe: () => ({ subscribe: () => {} }) } } },
        {
          provide: OrdersService,
          useValue: {
            addItem: addOrderItem,
            updateItems: updateOrderItems,
            logEvent: logOrderEvent,
            getById: ordersGetById,
            syncDerivedStatus,
            list: () => [],
          },
        },
        { provide: CustomersService, useValue: { getById: () => null } },
        { provide: CustomerFollowupsService, useValue: {} },
        { provide: SuppliersService, useValue: {} },
        { provide: RoutesService, useValue: {} },
        { provide: LocalitiesService, useValue: {} },
        {
          provide: InventoryService,
          useValue: {
            items: inventoryRows,
            reserveStock,
            releaseReservation,
            loadFromFirestore: loadInventory,
          },
        },
        { provide: NormalizedListingsService, useValue: { getRawPostImageUrls } },
        { provide: CatalogProductsService, useValue: {} },
        { provide: CatalogImportJobsService, useValue: { stop: () => {}, completedJobs: () => [] } },
        { provide: BarcodeProductLookupService, useValue: {} },
        { provide: PhysicalBarcodeScannerService, useValue: { activeMode: () => null, lastCode: () => null, stop: () => {} } },
        {
          provide: SupplierOperationsService,
          useValue: {
            rows: supplierRows,
            upsertFromConfirmedOrder: upsertSupplierOperations,
            receiveLineAndAllocate: receiveSupplierLine,
            loadFromFirestore: loadSupplierOperations,
          },
        },
        { provide: ManualProductHistoryService, useValue: {} },
        { provide: ReturnsService, useValue: {} },
        { provide: FinanceService, useValue: {} },
        { provide: BusinessScopeService, useValue: { unlockScope: () => {} } },
        { provide: AuthzService, useValue: { canCap: () => true } },
        { provide: AuthService, useValue: {} },
        { provide: SalesNoteRenderService, useValue: {} },
        { provide: RouteRunsService, useValue: {} },
        { provide: ShipmentsService, useValue: {} },
        { provide: OperationalExpenseReportsService, useValue: {} },
        { provide: UserAdminApiService, useValue: {} },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(PedidoDetallePage);
    component = fixture.componentInstance;
    // Deliberadamente NO se llama a fixture.detectChanges(): eso dispararia
    // ngOnInit() (watch() de servicios reales, resolucion de ruta), que no
    // aplica a pruebas de logica pura de descuento/tabs.
  });

  it("should create", () => {
    expect(component).toBeTruthy();
  });

  describe("inventario disponible al agregar productos", () => {
    function makeInventoryItem(
      inventoryId: string,
      available: number,
      overrides: Partial<InventoryItem> = {},
    ): InventoryItem {
      const reserved = Math.max(0, Math.trunc(Number(overrides.reserved_qty || 0)));
      return {
        inventory_id: inventoryId,
        business_id: "bm",
        title: "Sandalia de inventario",
        sku: inventoryId,
        product_id: inventoryId,
        variant_id: null,
        category_hint: null,
        supplier_id: null,
        variant_name: "24",
        color_name: "Rosa",
        size_label: "24",
        quantity_on_hand: available,
        on_hand_qty: available + reserved,
        reserved_qty: reserved,
        available_qty: available,
        in_review_qty: 0,
        damaged_qty: 0,
        unit_price: 50,
        notes: null,
        image_urls: [],
        source_reason: "ajuste_manual",
        ...overrides,
      };
    }

    function makeOrder(items: OrderItem[] = []): Order {
      return {
        order_id: "PED-001",
        business_id: "bm",
        status: "borrador",
        items,
        totals: {},
      } as Order;
    }

    async function selectInventory(item: InventoryItem): Promise<void> {
      inventoryRows.set([item]);
      await component.pickInventory(item);
    }

    it("excluye de las sugerencias los artículos sin piezas disponibles", () => {
      inventoryRows.set([
        makeInventoryItem("INV-AGOTADO", 0, { reserved_qty: 1, on_hand_qty: 1 }),
        makeInventoryItem("INV-DISPONIBLE", 2),
      ]);
      component.newItemSource.set("inventario");
      component.newItemSearch.set("sandalia");

      expect(component.inventorySuggestions().map((item) => item.inventory_id)).toEqual(["INV-DISPONIBLE"]);
      expect(component.unavailableInventoryMatchesCount()).toBe(1);
    });

    it("limita la cantidad a las piezas realmente disponibles", async () => {
      await selectInventory(makeInventoryItem("INV-2", 2));

      component.newItemQty.set(2);
      expect(component.newItemQuantityMax()).toBe(2);
      expect(component.canIncreaseNewItemQty()).toBeFalse();
      expect(component.newItemInventoryQuantityError()).toBeNull();

      component.newItemQty.set(3);
      expect(component.newItemInventoryQuantityError()).toContain("Solo hay 2");
      expect(component.addItemSubmitDisabled(makeOrder())).toBeTrue();
    });

    it("reserva inventario antes de agregar el renglón al pedido", async () => {
      const sequence: string[] = [];
      reserveStock.and.callFake(async () => {
        sequence.push("reserve");
      });
      addOrderItem.and.callFake(async () => {
        sequence.push("order");
      });
      await selectInventory(makeInventoryItem("INV-3", 3));
      spyOn(component, "refreshEvents").and.resolveTo();

      await component.addItem(makeOrder());

      expect(sequence).toEqual(["reserve", "order"]);
      expect(releaseReservation).not.toHaveBeenCalled();
    });

    it("libera la reserva si falla la actualización del pedido", async () => {
      const sequence: string[] = [];
      reserveStock.and.callFake(async () => {
        sequence.push("reserve");
      });
      addOrderItem.and.callFake(async () => {
        sequence.push("order");
        throw new Error("Pedido no disponible");
      });
      releaseReservation.and.callFake(async () => {
        sequence.push("release");
      });
      await selectInventory(makeInventoryItem("INV-4", 1));

      await expectAsync(component.addItem(makeOrder())).toBeRejectedWithError("Pedido no disponible");

      expect(sequence).toEqual(["reserve", "order", "release"]);
      expect(releaseReservation).toHaveBeenCalledTimes(1);
    });

    it("no modifica el pedido cuando otra operación tomó las piezas disponibles", async () => {
      reserveStock.and.rejectWith(new InventoryStockInsufficientError("INV-5", 0, 1));
      await selectInventory(makeInventoryItem("INV-5", 1));

      await expectAsync(component.addItem(makeOrder())).toBeRejectedWithError(/Ya no quedan piezas disponibles/);

      expect(addOrderItem).not.toHaveBeenCalled();
      expect(component.selectedInventoryAvailableQty()).toBe(0);
      expect(component.newItemInventoryQuantityError()).toContain("ya no tiene piezas");
    });

    it("no revierte pedido e inventario si solamente falla la bitácora", async () => {
      logOrderEvent.and.rejectWith(new Error("Bitácora no disponible"));
      await selectInventory(makeInventoryItem("INV-6", 1));
      spyOn(component, "refreshEvents").and.resolveTo();

      await component.addItem(makeOrder());

      expect(reserveStock).toHaveBeenCalledTimes(1);
      expect(addOrderItem).toHaveBeenCalledTimes(1);
      expect(releaseReservation).not.toHaveBeenCalled();
    });
  });

  describe("itemDiscountBadge (badge por producto en la lista)", () => {
    function makeItem(overrides: Partial<OrderItem>): OrderItem {
      return { price_public: null, price_clienta: null, ...overrides } as OrderItem;
    }

    it("returns null when there is no price_public", () => {
      const item = makeItem({ price_public: null, price_clienta: 100 });
      expect(component.itemDiscountBadge(item)).toBeNull();
    });

    it("returns null when price_clienta equals price_public (no discount)", () => {
      const item = makeItem({ price_public: 199, price_clienta: 199 });
      expect(component.itemDiscountBadge(item)).toBeNull();
    });

    it("returns null when price_clienta is above price_public", () => {
      const item = makeItem({ price_public: 199, price_clienta: 220 });
      expect(component.itemDiscountBadge(item)).toBeNull();
    });

    it("computes an integer percentage label when the discount is a round number", () => {
      const item = makeItem({ price_public: 200, price_clienta: 150 });
      expect(component.itemDiscountBadge(item)).toBe("25% dto. aplicado");
    });

    it("computes a decimal percentage label when the discount is not a round number", () => {
      const item = makeItem({ price_public: 300, price_clienta: 275 });
      expect(component.itemDiscountBadge(item)).toBe("8.3% dto. aplicado");
    });
  });

  describe("showClientaDiscountButton (visible cuando existe un precio base)", () => {
    function makeCatalogProduct(overrides: Partial<CatalogProduct> = {}): CatalogProduct {
      return {
        product_id: "prod-1",
        catalog_product_id: "prod-1",
        business_id: "catalogo",
        prices: { cost: 50, clienta: 80, currency: "MXN" },
        price_cost: 50,
        price_clienta: 80,
        ...overrides,
      } as CatalogProduct;
    }

    it("is hidden when no product/source has been chosen yet (cannot submit)", () => {
      expect(component.canSubmitNewItem()).toBeFalse();
      expect(component.showClientaDiscountButton()).toBeFalse();
    });

    it("is visible as soon as the form can be submitted (manual source)", () => {
      component.newItemSource.set("manual");
      component.newItemPricePublic.set(100);
      expect(component.canSubmitNewItem()).toBeTrue();
      expect(component.showClientaDiscountButton()).toBeTrue();
    });

    it("uses the original catalog sale price as the discount base", () => {
      component.newItemSource.set("manual");
      component.selectedCatalogProduct.set(makeCatalogProduct());
      expect(component.canSubmitNewItem()).toBeTrue();
      expect(component.clientaDiscountBasePrice()).toBe(80);
      expect(component.showClientaDiscountButton()).toBeTrue();
    });
  });

  describe("catalogBasePrice / pickCatalogProduct (sin precio publico)", () => {
    function makeCatalogProduct(overrides: Partial<CatalogProduct> = {}): CatalogProduct {
      return {
        product_id: "prod-1",
        catalog_product_id: "prod-1",
        business_id: "catalogo",
        name: "Producto de prueba",
        prices: { cost: 50, clienta: 80, currency: "MXN" },
        price_cost: 50,
        price_clienta: 80,
        ...overrides,
      } as CatalogProduct;
    }

    it("catalogBasePrice('clienta') reads prices.clienta and has no 'final' tier available", () => {
      component.selectedCatalogProduct.set(makeCatalogProduct());
      expect(component.catalogBasePrice("clienta")).toBe(80);
    });

    it("pickCatalogProduct never sets newItemPricePublic", () => {
      component.pickCatalogProduct(makeCatalogProduct());
      expect(component.newItemPricePublic()).toBeNull();
      expect(component.newItemPriceClienta()).toBe(80);
      expect(component.newItemPriceCost()).toBe(50);
      expect(component.catalogPriceTier()).toBe("clienta");
    });

    it("pickCatalogProduct falls back to manual tier when there is no clienta price", () => {
      component.pickCatalogProduct(makeCatalogProduct({ prices: { cost: 50, clienta: null, currency: "MXN" }, price_clienta: null }));
      expect(component.catalogPriceTier()).toBe("manual");
    });
  });

  describe("biblioteca de imágenes del producto", () => {
    it("incluye las fotos originales sin color y omite las excluidas", async () => {
      getRawPostImageUrls.and.resolveTo([
        "https://img.test/hueso.jpg",
        "https://img.test/detalle.jpg",
        "https://img.test/excluida.jpg",
        "https://img.test/detalle.jpg",
      ]);
      const variant = {
        variant_name: "Unitalla",
        sku: "SKU-1",
        stock_state: "in_stock" as const,
        notes: null,
        prices: [],
        color_names: ["Hueso"],
      };
      const doc = {
        schema_version: "normalized_v1.1",
        normalized_id: "producto-1",
        raw_post_id: "raw-1",
        supplier_id: "proveedor-1",
        cover_images: ["https://img.test/portada.jpg"],
        preview_image_url: "https://img.test/portada.jpg",
        product_colors: [{ name: "Hueso", image_url: "https://img.test/hueso.jpg" }],
        created_at: null,
        updated_at: null,
        listing: {
          title: "Playera estampada",
          category_hint: null,
          price_tiers_global: [],
          items: [variant],
        },
        workflow: { status: "validated", validated_by: null, validated_at: null },
        review: {
          preview_image_url: "https://img.test/portada.jpg",
          excluded_image_urls: ["https://img.test/excluida.jpg"],
          edited_at: null,
          edited_by: null,
        },
      } satisfies NormalizedListingDoc;

      component.pickCatalog(doc, variant, "Hueso");
      await fixture.whenStable();

      const images = component.addItemSelectionImages();
      expect(getRawPostImageUrls).toHaveBeenCalledOnceWith("raw-1");
      expect(images.map((image) => image.url)).toEqual([
        "https://img.test/hueso.jpg",
        "https://img.test/portada.jpg",
        "https://img.test/detalle.jpg",
      ]);
      expect(images.find((image) => image.url.endsWith("detalle.jpg"))?.color).toBeNull();
      expect(images.some((image) => image.url.endsWith("excluida.jpg"))).toBeFalse();
    });
  });

  describe("clientaDiscountSummary (leyenda en vivo)", () => {
    it("returns null when there is no final price yet", () => {
      component.newItemPricePublic.set(null);
      component.newItemPriceClienta.set(100);
      expect(component.clientaDiscountSummary()).toBeNull();
    });

    it("returns null when final and clienta prices are equal", () => {
      component.newItemPricePublic.set(199);
      component.newItemPriceClienta.set(199);
      expect(component.clientaDiscountSummary()).toBeNull();
    });

    it("describes the discount percentage and amount when clienta is below final", () => {
      component.newItemPricePublic.set(200);
      component.newItemPriceClienta.set(150);
      expect(component.clientaDiscountSummary()).toBe("25% de descuento sobre precio final ($50.00)");
    });

    it("describes an over-final price as such, not as a discount", () => {
      component.newItemPricePublic.set(200);
      component.newItemPriceClienta.set(230);
      const summary = component.clientaDiscountSummary();
      expect(summary).toContain("por encima del precio final");
    });
  });

  describe("selector de descuento: modo %, chips, personalizado y aplicar", () => {
    beforeEach(() => {
      component.newItemPricePublic.set(200);
      component.newItemPriceClienta.set(200);
    });

    it("defaults to percentage mode at 25%", () => {
      expect(component.clientaDiscountMode()).toBe("pct");
      expect(component.clientaDiscountPct()).toBe(25);
    });

    it("previews the discounted price for a given percentage chip", () => {
      component.setClientaDiscountPct(30);
      expect(component.previewClientaDiscount()).toBe(140);
    });

    it("clamps a custom percentage to the 0-100 range", () => {
      component.setClientaDiscountPct(150);
      expect(component.clientaDiscountPct()).toBe(100);

      component.setClientaDiscountPct(-10);
      expect(component.clientaDiscountPct()).toBe(0);
    });

    it("switches to fixed-amount mode and previews a flat discount", () => {
      component.setClientaDiscountMode("fixed");
      component.setClientaDiscountFixed(35);
      expect(component.clientaDiscountMode()).toBe("fixed");
      expect(component.previewClientaDiscount()).toBe(165);
    });

    it("never previews a negative price even if the fixed discount exceeds the final price", () => {
      component.setClientaDiscountMode("fixed");
      component.setClientaDiscountFixed(500);
      expect(component.previewClientaDiscount()).toBe(0);
    });

    it("applies the previewed discount to the real clienta price and closes the popover", () => {
      component.clientaDiscountOpen.set(true);
      component.setClientaDiscountPct(25);

      component.applyClientaDiscount();

      expect(component.newItemPriceClienta()).toBe(150);
      expect(component.clientaDiscountOpen()).toBeFalse();
      expect(component.clientaDiscountSummary()).toContain("25% de descuento sobre precio final");
    });

    it("does nothing when there is no final price to base the discount on", () => {
      component.newItemPricePublic.set(null);
      component.clientaDiscountOpen.set(true);

      component.applyClientaDiscount();

      expect(component.newItemPriceClienta()).toBe(200);
      expect(component.clientaDiscountOpen()).toBeTrue();
    });
  });

  describe("flujo completo de seleccion y opcion provisional", () => {
    function makeProduct(id: string, color: string, size: string): CatalogProduct {
      return {
        product_id: id,
        catalog_product_id: id,
        business_id: "catalogo",
        name: "Sandalia Winnie Pooh",
        color,
        size,
        sku: id,
        prices: { cost: 50, clienta: 100, currency: "MXN" },
        price_cost: 50,
        price_clienta: 100,
        sellable: true,
        image_url: `https://example.test/${color}.jpg`,
      } as CatalogProduct;
    }

    it("summarizes a grouped catalog result instead of exposing every combination as a search row", () => {
      const variants = [
        makeProduct("rosa-24", "Rosa", "24"),
        makeProduct("rosa-25", "Rosa", "25"),
        makeProduct("negro-24", "Negro", "24"),
      ];
      const result: CatalogProductSearchResult = {
        result_id: "sandalia",
        product: variants[0],
        group: null,
        bundle: null,
        variants,
        matched_identifier: null,
        requires_selection: true,
      };

      expect(component.catalogSearchResultRepresentative(result)?.product_id).toBe("rosa-24");
      expect(component.catalogSearchResultOptionSummary(result)).toBe("2 colores · 2 variantes · 3 combinaciones");
    });

    it("keeps provisional edits separate until they are explicitly confirmed", () => {
      component.newItemSource.set("catalogo");
      component.newItemVariant.set("24");
      component.newItemColor.set("Rosa");
      component.selectedPreview.set({
        title: "Sandalia Winnie Pooh",
        variant: "24",
        color: "Rosa",
        image: "https://example.test/rosa.jpg",
        source: "Catálogo",
      });
      component.onAddItemProvisionalEditorChange(true);

      expect(component.addItemProvisionalEditorOpen()).toBeTrue();

      component.onAddItemProvisionalApply({
        variant: "26",
        color: "Verde menta",
        imageId: "verde",
        imageUrl: "https://example.test/verde.jpg",
        uploadedFileName: null,
      });

      expect(component.newItemVariant()).toBe("26");
      expect(component.newItemColor()).toBe("Verde menta");
      expect(component.selectedPreview()?.image).toContain("verde.jpg");
      expect(component.addItemProvisionalOption()).not.toBeNull();
    });

    it("blocks the order action while the provisional editor has an unconfirmed draft", () => {
      spyOn(component, "canSubmitNewItem").and.returnValue(true);
      spyOn(component, "canEditItems").and.returnValue(true);

      component.onAddItemProvisionalEditorChange(true);
      expect(component.addItemSubmitDisabled(null)).toBeTrue();

      component.onAddItemProvisionalEditorChange(false);
      expect(component.addItemSubmitDisabled(null)).toBeFalse();
    });

    it("does not dismiss the product dialog while the item is being saved", () => {
      component.addItemModalOpen.set(true);
      component.addItemSaving.set(true);

      component.closeAddItemModal();

      expect(component.addItemModalOpen()).toBeTrue();
    });

    it("calculates a catalog discount from the original sale price", () => {
      const product = makeProduct("rosa-24", "Rosa", "24");
      component.newItemSource.set("catalogo");
      component.selectedCatalogProduct.set(product);
      component.newItemPriceClienta.set(100);
      component.setClientaDiscountPct(25);

      expect(component.previewClientaDiscount()).toBe(75);
      component.applyClientaDiscount();
      expect(component.newItemPriceClienta()).toBe(75);
      expect(component.newItemDiscount()).toBe(25);
      expect(component.catalogPriceTier()).toBe("manual");
    });
  });

  describe("recepción masiva de proveedor", () => {
    function makeSupplierOrder(itemCount: number): Order {
      const items: OrderItem[] = Array.from({ length: itemCount }, (_, index) => ({
        item_id: `item-${index + 1}`,
        title: `Producto ${index + 1}`,
        quantity: 1,
        confirmed_qty: 1,
        source: "catalogo",
        state: "inbound_in_transit",
        confirmation_state: "confirmed",
        supplier_id: "supplier-1",
        product_id: `product-${index + 1}`,
      }));
      return {
        order_id: "order-bulk",
        business_id: "bm",
        customer_id: "customer-1",
        route_id: null,
        status: "inbound_in_transit",
        created_at: "2026-08-13T00:00:00.000Z",
        updated_at: "2026-08-13T00:00:00.000Z",
        items,
        packages: [],
        timeline: [],
        packing: { status: "in_progress", packages_count: 0 },
        dispatch_request: { status: "none" },
        totals: { total_amount: itemCount, paid_amount: 0, balance_due: itemCount },
      };
    }

    function prepareBulkOrder(itemCount: number): Order {
      const order = makeSupplierOrder(itemCount);
      component.orderId.set(order.order_id);
      ordersGetById.and.returnValue(order);
      spyOn(component, "refreshEvents").and.resolveTo();
      return order;
    }

    it("muestra progreso mientras prepara y completa la recepción", async () => {
      prepareBulkOrder(3);
      let resolveUpsert!: (value: number) => void;
      upsertSupplierOperations.and.returnValue(new Promise<number>((resolve) => {
        resolveUpsert = resolve;
      }));

      const action = component.runProductBulkAction();

      expect(component.productBulkActionSaving()).toBeTrue();
      expect(component.productBulkActionProgress()).toEqual({ completed: 0, total: 3 });
      expect(component.productBulkActionProgressLabel()).toBe("Recibiendo 0 de 3...");
      expect(component.canRunProductBulkAction(component.order())).toBeFalse();

      resolveUpsert(3);
      await action;

      expect(component.productBulkActionSaving()).toBeFalse();
      expect(component.productBulkActionProgress()).toBeNull();
      expect(component.actionToast()).toContain("3 producto(s) recibido(s)");
    });

    it("procesa varias líneas a la vez y consolida actualizaciones y recargas", async () => {
      const order = prepareBulkOrder(6);
      let activeReceipts = 0;
      let maxConcurrentReceipts = 0;
      receiveSupplierLine.and.callFake(async () => {
        activeReceipts += 1;
        maxConcurrentReceipts = Math.max(maxConcurrentReceipts, activeReceipts);
        await Promise.resolve();
        activeReceipts -= 1;
      });

      await component.runProductBulkAction();

      expect(upsertSupplierOperations).toHaveBeenCalledTimes(1);
      expect(receiveSupplierLine).toHaveBeenCalledTimes(6);
      expect(maxConcurrentReceipts).toBeGreaterThan(1);
      expect(maxConcurrentReceipts).toBeLessThanOrEqual(4);
      expect(updateOrderItems).toHaveBeenCalledTimes(1);
      const updatedItems = updateOrderItems.calls.mostRecent().args[1] as OrderItem[];
      expect(updatedItems.every((item) => item.state === "recibido_qa")).toBeTrue();
      expect(syncDerivedStatus).toHaveBeenCalledOnceWith(order.order_id);
      expect(loadInventory).toHaveBeenCalledTimes(1);
      expect(loadSupplierOperations).toHaveBeenCalledTimes(1);
      expect(receiveSupplierLine.calls.first().args[2]).toEqual({
        refreshInventory: false,
        reloadSupplierOperations: false,
        syncOrderStatus: false,
      });
    });

    it("actualiza solamente las líneas exitosas y deja los fallos disponibles para reintento", async () => {
      prepareBulkOrder(3);
      receiveSupplierLine.and.callFake((lineId: string) => lineId.includes("item-2")
        ? Promise.reject(new Error("No se pudo apartar inventario"))
        : Promise.resolve());

      await component.runProductBulkAction();

      const updatedItems = updateOrderItems.calls.mostRecent().args[1] as OrderItem[];
      expect(updatedItems.find((item) => item.item_id === "item-1")?.state).toBe("recibido_qa");
      expect(updatedItems.find((item) => item.item_id === "item-2")?.state).toBe("inbound_in_transit");
      expect(updatedItems.find((item) => item.item_id === "item-3")?.state).toBe("recibido_qa");
      expect(component.actionError()).toContain("1 de 3 producto(s) no se pudieron recibir");
      expect(component.actionError()).toContain("No se pudo apartar inventario");
      expect(component.actionToast()).toContain("2 producto(s) recibido(s); 1 pendiente(s)");
      expect(component.popupAlertOpen()).toBeTrue();
      expect(component.popupAlertTitle()).toBe("Recepción incompleta");
    });
  });

  describe("empaque parcial", () => {
    function makePartialPackingOrder(): Order {
      return {
        order_id: "order-partial-packing",
        business_id: "bm",
        customer_id: "customer-1",
        route_id: null,
        status: "inbound_in_transit",
        created_at: "2026-08-13T00:00:00.000Z",
        updated_at: "2026-08-13T00:00:00.000Z",
        items: [
          {
            item_id: "inventory-ready",
            title: "Producto de inventario",
            quantity: 1,
            confirmed_qty: 1,
            source: "inventario",
            state: "reservado_inventario",
            confirmation_state: "confirmed",
            inventory_id: "inventory-1",
          },
          {
            item_id: "supplier-waiting",
            title: "Producto de proveedor",
            quantity: 1,
            confirmed_qty: 1,
            source: "catalogo",
            state: "inbound_in_transit",
            confirmation_state: "confirmed",
            supplier_id: "supplier-1",
            product_id: "product-1",
          },
        ],
        packages: [],
        timeline: [],
        packing: { status: "in_progress", packages_count: 0 },
        dispatch_request: { status: "none" },
        totals: { total_amount: 2, paid_amount: 0, balance_due: 2 },
      };
    }

    it("habilita Paquetes cuando existe al menos un producto empacable", () => {
      const order = makePartialPackingOrder();

      expect(component.unpackedItems(order).map((row) => row.item.item_id)).toEqual([
        "inventory-ready",
      ]);
      expect(component.packedCount(order)).toBe(0);
      expect(component.isPackingAvailable(order)).toBeTrue();
      expect(component.allowedCapabilities(order, "admin").canCreatePackages).toBeTrue();
      expect(component.isPackingWorkflowPhase(order)).toBeTrue();
    });

    it("mantiene Paquetes bloqueado cuando ningún producto está disponible", () => {
      const order = makePartialPackingOrder();
      order.items[0] = { ...order.items[0], confirmation_state: "pending" };

      expect(component.isPackingAvailable(order)).toBeFalse();
      expect(component.allowedCapabilities(order, "admin").canCreatePackages).toBeFalse();
    });

    it("impide terminar el empaque mientras haya productos esperando recepción", () => {
      const order = makePartialPackingOrder();
      order.packages = [
        {
          package_id: "package-1",
          label: "Caja 1",
          sequence: 1,
          total_packages: 1,
          state: "closed",
          status: "closed",
          amount_due: null,
          item_ids: ["inventory-ready"],
          items: [{ orderItemId: "inventory-ready", name: "Producto de inventario", qty: 1 }],
          closed_at: "2026-08-13T01:00:00.000Z",
          created_at: "2026-08-13T00:30:00.000Z",
        },
      ];

      expect(component.packBlockedCount(order)).toBe(1);
      expect(component.canFinishPacking(order)).toBeFalse();
      expect(component.isPackingComplete(order)).toBeFalse();
    });
  });

  describe("tabs: cambio de seccion activa", () => {
    it("defaults to the productos tab", () => {
      expect(component.activeTab()).toBe("productos");
    });

    it("switches the active tab", () => {
      component.setActiveTab("paquetes");
      expect(component.activeTab()).toBe("paquetes");
    });

    it("scrollToSection delegates to setActiveTab", () => {
      component.scrollToSection("incidencias");
      expect(component.activeTab()).toBe("incidencias");
    });

    it("applyFocus('packages') switches to the paquetes tab", () => {
      component.applyFocus("packages");
      expect(component.activeTab()).toBe("paquetes");
    });

    it("applyFocus('incidents') switches to the incidencias tab without opening the modal", () => {
      component.applyFocus("incidents");
      expect(component.activeTab()).toBe("incidencias");
      expect(component.incidentModalOpen()).toBeFalse();
    });

    it("applyFocus('incidents:new') switches tabs and opens the new-incident modal", () => {
      component.applyFocus("incidents:new");
      expect(component.activeTab()).toBe("incidencias");
      expect(component.incidentModalOpen()).toBeTrue();
    });
  });
});
