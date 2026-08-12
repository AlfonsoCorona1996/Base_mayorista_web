import { ComponentFixture, TestBed } from "@angular/core/testing";
import { ActivatedRoute, Router } from "@angular/router";
import PedidoDetallePage from "./pedido-detalle";
import { OrdersService } from "../../core/orders.service";
import { CustomersService } from "../../core/customers.service";
import { CustomerFollowupsService } from "../../core/customer-followups.service";
import { SuppliersService } from "../../core/suppliers.service";
import { RoutesService } from "../../core/routes.service";
import { LocalitiesService } from "../../core/localities.service";
import { InventoryService } from "../../core/inventory.service";
import { NormalizedListingsService } from "../../core/normalized-listings.service";
import { CatalogProductsService } from "../../core/catalog-products.service";
import { CatalogImportJobsService } from "../../core/catalog-import-jobs.service";
import { BarcodeProductLookupService } from "../../core/barcode-product-lookup.service";
import { PhysicalBarcodeScannerService } from "../../core/physical-barcode-scanner.service";
import { SupplierOperationsService } from "../../core/supplier-operations.service";
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
import type { OrderItem } from "../../core/orders.service";
import type { CatalogProduct, CatalogProductSearchResult } from "../../core/catalog-products.service";

/**
 * Estas pruebas cubren solo la LOGICA nueva/modificada de esta ronda de
 * fidelidad literal al prototipo: selección agrupada, opción provisional,
 * descuento de "Precio clienta" en diálogo, badge por producto y tabs.
 * No renderizan el template (no se llama a fixture.detectChanges())
 * para evitar disparar ngOnInit(), que dispara llamadas reales a servicios
 * (watch() de suscripciones, resolucion de ruta) fuera del alcance de estas
 * pruebas unitarias.
 */
describe("PedidoDetallePage - descuento Precio clienta y tabs", () => {
  let component: PedidoDetallePage;
  let fixture: ComponentFixture<PedidoDetallePage>;

  const routeMock = {
    snapshot: { paramMap: { get: () => null }, queryParamMap: { get: () => null } },
    queryParamMap: { pipe: () => ({ subscribe: () => {} }) },
  };

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [PedidoDetallePage],
      providers: [
        { provide: ActivatedRoute, useValue: routeMock },
        { provide: Router, useValue: { events: { pipe: () => ({ subscribe: () => {} }) } } },
        { provide: OrdersService, useValue: {} },
        { provide: CustomersService, useValue: {} },
        { provide: CustomerFollowupsService, useValue: {} },
        { provide: SuppliersService, useValue: {} },
        { provide: RoutesService, useValue: {} },
        { provide: LocalitiesService, useValue: {} },
        { provide: InventoryService, useValue: {} },
        { provide: NormalizedListingsService, useValue: {} },
        { provide: CatalogProductsService, useValue: {} },
        { provide: CatalogImportJobsService, useValue: { stop: () => {}, completedJobs: () => [] } },
        { provide: BarcodeProductLookupService, useValue: {} },
        { provide: PhysicalBarcodeScannerService, useValue: { activeMode: () => null, lastCode: () => null, stop: () => {} } },
        { provide: SupplierOperationsService, useValue: {} },
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
