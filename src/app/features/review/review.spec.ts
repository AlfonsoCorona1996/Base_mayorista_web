import { TestBed } from "@angular/core/testing";
import { ElementRef } from '@angular/core';
import { ActivatedRoute, Router } from "@angular/router";
import { AuthService } from "../../core/auth.service";
import { CategoriesService } from "../../core/categories.service";
import type { NormalizedListingDocV3 } from "../../core/firestore-contracts";
import { NormalizedListingsService } from "../../core/normalized-listings.service";
import { SuppliersService } from "../../core/suppliers.service";
import ReviewPage from "./review";

function validDraft(): NormalizedListingDocV3 {
  return {
    schema_version: "normalized_v3.0",
    normalized_id: "listing-1",
    business_id: "bm",
    raw_post_id: "raw-1",
    supplier_id: "supplier-1",
    cover_images: [],
    product_colors: [],
    created_at: null,
    updated_at: null,
    listing: {
      title: "Producto listo",
      category_hint: "Calzado",
      items: [{
        variant_id: "variant-1",
        variant_name: "Unitalla",
        sku: "SKU-1",
        stock_state: "in_stock",
        notes: null,
        color_stock: [],
        prices: {
          precio_costo: 100,
          precio_final: 200,
          precio_clienta: 150,
          currency: "MXN",
        },
      }],
    },
    workflow: { status: "needs_review", validated_by: null, validated_at: null },
    review: { preview_image_url: null, excluded_image_urls: [], edited_at: null, edited_by: null },
  };
}

describe("ReviewPage publication", () => {
  it("guarda y publica en una sola llamada y bloquea el doble clic", async () => {
    let finishWrite!: () => void;
    const listings = jasmine.createSpyObj<NormalizedListingsService>("NormalizedListingsService", ["saveReviewDecision", "invalidateAllValidated"]);
    listings.saveReviewDecision.and.returnValue(new Promise<void>((resolve) => {
      finishWrite = resolve;
    }));
    const router = jasmine.createSpyObj<Router>("Router", ["navigateByUrl"]);
    router.navigateByUrl.and.returnValue(Promise.resolve(true));

    TestBed.configureTestingModule({
      providers: [
        ReviewPage,
        { provide: ElementRef, useValue: new ElementRef(document.createElement('app-review')) },
        { provide: ActivatedRoute, useValue: { snapshot: { paramMap: { get: () => "listing-1" } } } },
        { provide: Router, useValue: router },
        { provide: NormalizedListingsService, useValue: listings },
        { provide: AuthService, useValue: { uid: () => "user-1" } },
        { provide: CategoriesService, useValue: {} },
        { provide: SuppliersService, useValue: { getActive: () => [] } },
      ],
    });
    const page = TestBed.inject(ReviewPage);
    page.draft.set(validDraft());
    page.confirmCategory();

    const firstClick = page.validate();
    expect(page.publishing()).toBe(true);
    await page.validate();

    expect(listings.saveReviewDecision).toHaveBeenCalledTimes(1);
    const options = listings.saveReviewDecision.calls.mostRecent().args[3];
    expect(options).toEqual({ businessId: "bm", validatedBy: "user-1" });

    finishWrite();
    await firstClick;
    expect(page.publishing()).toBe(false);
    expect(router.navigateByUrl).toHaveBeenCalledWith("/main/validacion");
  });
});

function listingWithVariants(
  normalizedId: string,
  variants: Array<{ name: string; sku: string | null; colors?: string[] }>
): NormalizedListingDocV3 {
  const base = validDraft();
  base.normalized_id = normalizedId;
  base.supplier_id = "frodam";
  base.listing.title = "New Balance Modelo 9060";
  base.listing.items = variants.map((variant, index) => ({
    variant_id: `${normalizedId}-v${index + 1}`,
    variant_name: variant.name,
    sku: variant.sku,
    stock_state: "in_stock" as const,
    notes: null,
    color_stock: (variant.colors || []).map((color) => ({ color_name: color, stock_state: "in_stock" as const })),
    prices: { precio_costo: 299, precio_final: 599, precio_clienta: 449.25, currency: "MXN" },
  }));
  base.product_colors = Array.from(new Set(variants.flatMap((variant) => variant.colors || []))).map((name) => ({
    name,
    image_url: null,
  }));
  return base;
}

describe("ReviewPage colores y precios con contexto original inaccesible", () => {
  function setup(source: NormalizedListingDocV3) {
    // El servicio conserva un tipo de retorno legacy; Review valida v3 al recibirlo.
    type ReviewListings = Pick<NormalizedListingsService, "saveReviewDecision" | "invalidateAllValidated"> & {
      getById(id: string): Promise<NormalizedListingDocV3>;
    };
    const listings = jasmine.createSpyObj<ReviewListings>("listings", ["getById", "saveReviewDecision", "invalidateAllValidated"]);
    listings.getById.and.resolveTo(source);
    listings.saveReviewDecision.and.resolveTo();
    TestBed.configureTestingModule({ providers: [
      ReviewPage,
      { provide: ElementRef, useValue: new ElementRef(document.createElement("app-review")) },
      { provide: ActivatedRoute, useValue: { snapshot: { paramMap: { get: () => source.normalized_id } } } },
      { provide: Router, useValue: { navigateByUrl: async () => true } },
      { provide: NormalizedListingsService, useValue: listings },
      { provide: AuthService, useValue: { uid: () => "user-1" } },
      { provide: CategoriesService, useValue: {} },
      { provide: SuppliersService, useValue: { getActive: () => [] } },
    ] });
    const page = TestBed.inject(ReviewPage);
    // Interceptar solo la lectura remota: ejecutar la inicialización real completa.
    const rawRead = spyOn(page as unknown as { loadRawContext(id: string): Promise<void> }, "loadRawContext")
      .and.rejectWith(new Error("Missing or insufficient permissions."));
    return { page, listings, rawRead };
  }

  function partialListing() {
    const source = listingWithVariants("listing-1", [
      { name: "CH", sku: "CH", colors: ["rosa"] },
      { name: "M", sku: "M", colors: ["rosa"] },
      { name: "G", sku: "G", colors: ["rosa"] },
    ]);
    source.product_colors = ["rosa", "gris", "azul", "beige", "café"].map(name => ({ name, image_url: `https://example.test/${name}.jpg` }));
    source.listing.items.forEach((item, index) => {
      item.prices = { precio_final: index === 0 ? 360 : null, precio_costo: index === 0 ? 180 : null, precio_clienta: null, currency: "MXN" };
    });
    return source;
  }

  it("inicializa las 15 combinaciones y el precio compartido aunque raw_posts deniegue lectura", async () => {
    const source = partialListing();
    const { page } = setup(source);
    await page.load();
    expect(page.error()).toBeNull();
    expect(page.rawContextError()).toContain("No se pudo cargar");
    expect(page.loading()).toBeFalse();
    expect(page.useSharedPrices()).toBeTrue();
    expect(page.rawImages().length).toBe(5);
    for (const item of page.draft()!.listing.items) {
      expect(item.color_stock.map(color => color.color_name)).toEqual(["rosa", "gris", "azul", "beige", "café"]);
      expect(item.prices).toEqual({ precio_final: 360, precio_costo: 180, precio_clienta: 270, currency: "MXN" });
    }
    expect(source.listing.items[1].prices.precio_final).toBeNull();
  });

  it("reconcilia colores antes de guardar y publica todas las combinaciones", async () => {
    const { page, listings } = setup(partialListing());
    await page.load();
    page.draft()!.listing.items[1].color_stock = [];
    page.confirmCategory();
    await page.validate();
    const patch = listings.saveReviewDecision.calls.mostRecent().args[1];
    const listing = patch.listing as NormalizedListingDocV3["listing"];
    expect(listing.items.every(item => item.color_stock.length === 5)).toBeTrue();
    expect(listing.items.every(item => item.prices.precio_final === 360)).toBeTrue();
  });

  it("en una extracción nueva no reparte colores por talla: todas las tallas llevan todos los colores", async () => {
    const source = listingWithVariants("listing-bomber", [
      { name: "CH", sku: "CH", colors: ["beige"] },
      { name: "M", sku: "M", colors: ["vino"] },
      { name: "G", sku: "G", colors: ["café"] },
    ]);
    source.product_colors = ["beige", "vino", "café", "camel"].map(name => ({ name, image_url: `https://example.test/${name}.jpg` }));
    const { page, listings } = setup(source);
    await page.load();
    expect(page.hasVariantColors()).toBeFalse();
    await page.save();
    const items = (listings.saveReviewDecision.calls.mostRecent().args[1].listing as NormalizedListingDocV3["listing"]).items;
    for (const item of items) {
      expect(item.color_stock.map(color => color.color_name)).toEqual(["beige", "vino", "café", "camel"]);
    }
  });

  it("conserva precios diferentes y colores específicos por talla que una persona ya guardó", async () => {
    const source = partialListing();
    source.review = { preview_image_url: null, excluded_image_urls: [], edited_at: { seconds: 1 }, edited_by: "user-1" };
    source.listing.items[1].prices = { precio_final: 400, precio_costo: 200, precio_clienta: 300, currency: "MXN" };
    source.listing.items[1].color_stock = [{ color_name: "azul", stock_state: "out_of_stock" }];
    const { page, listings } = setup(source);
    await page.load();
    expect(page.useSharedPrices()).toBeFalse();
    expect(page.hasVariantColors()).toBeTrue();
    await page.save();
    const listing = listings.saveReviewDecision.calls.mostRecent().args[1].listing as NormalizedListingDocV3["listing"];
    const items = listing.items;
    expect(items[1].prices.precio_final).toBe(400);
    expect(items[2].prices.precio_final).toBeNull();
    expect(items[1].color_stock).toEqual([{ color_name: "azul", stock_state: "out_of_stock" }]);
    expect(items[0].color_stock.length).toBe(1);
  });

  it("encuentra el precio común aunque la primera variante no tenga precio", async () => {
    const source = partialListing();
    [source.listing.items[0].prices, source.listing.items[2].prices] = [source.listing.items[2].prices, source.listing.items[0].prices];
    const { page } = setup(source);
    await page.load();
    expect(page.useSharedPrices()).toBeTrue();
    expect(page.draft()!.listing.items.every(item => item.prices.precio_final === 360)).toBeTrue();
  });

  it("no inventa precios cuando ninguna variante tiene importe", async () => {
    const source = partialListing();
    source.listing.items[0].prices = { ...source.listing.items[1].prices };
    const { page } = setup(source);
    await page.load();
    expect(page.useSharedPrices()).toBeTrue();
    expect(page.getSharedPriceInputValue("final")).toBe("");
    expect(page.draft()!.listing.items.every(item => item.prices.precio_final === null)).toBeTrue();
  });

  it("reintenta solo el contexto sin pisar precios editados ni imágenes por color", async () => {
    const { page, rawRead } = setup(partialListing());
    await page.load();
    page.onSharedPriceInputChange("final", "500");
    rawRead.and.callFake(async () => { page.rawText.set("Texto recuperado"); page.rawImages.set(["https://example.test/original.jpg"]); });
    await page.retryRawContext();
    expect(page.rawContextError()).toBeNull();
    expect(page.rawText()).toBe("Texto recuperado");
    expect(page.rawImages().length).toBe(6);
    expect(page.draft()!.listing.items.every(item => item.prices.precio_final === 500)).toBeTrue();
  });
});

describe("ReviewPage fusion controlada", () => {
  function buildPage(): ReviewPage {
    TestBed.configureTestingModule({
      providers: [
        ReviewPage,
        { provide: ElementRef, useValue: new ElementRef(document.createElement('app-review')) },
        { provide: ActivatedRoute, useValue: { snapshot: { paramMap: { get: () => "listing-source" } } } },
        { provide: Router, useValue: jasmine.createSpyObj<Router>("Router", ["navigateByUrl"]) },
        { provide: NormalizedListingsService, useValue: {} },
        { provide: AuthService, useValue: { uid: () => "user-1" } },
        { provide: CategoriesService, useValue: {} },
        { provide: SuppliersService, useValue: { getActive: () => [] } },
      ],
    });
    return TestBed.inject(ReviewPage);
  }

  it("empata variantes por nombre aunque el destino ya tenga SKU generado", () => {
    const page = buildPage();

    const target = listingWithVariants("71e8913c", [
      { name: "22", sku: "FRODAM-71E8913C-22", colors: ["negro"] },
      { name: "23", sku: "FRODAM-71E8913C-23", colors: ["negro"] },
      { name: "24", sku: "FRODAM-71E8913C-24", colors: ["negro"] },
    ]);
    // El borrador en validacion trae SKU propios (se generan con su normalized_id),
    // asi que nunca coinciden con los del destino: el empate tiene que caer al nombre.
    const source = listingWithVariants("listing-source", [
      { name: "23", sku: "FRODAM-LISTINGS-23", colors: ["nuez"] },
      { name: "24", sku: "FRODAM-LISTINGS-24", colors: ["nuez"] },
      { name: "25", sku: "FRODAM-LISTINGS-25", colors: ["nuez"] },
    ]);

    const merged = (page as any).buildMergedDocument(source, target, page.mergeOptions());

    expect(merged.listing.items.map((item: any) => item.variant_name)).toEqual(["22", "23", "24", "25"]);
    expect(merged.listing.items[1].sku).toBe("FRODAM-71E8913C-23");
    expect(merged.listing.items[1].color_stock.map((entry: any) => entry.color_name)).toEqual(["negro", "nuez"]);
  });

  it("cuenta variantes coincidentes en la vista previa antes de fusionar", () => {
    const page = buildPage();

    page.draft.set(listingWithVariants("listing-source", [
      { name: "23", sku: null },
      { name: "99", sku: null },
    ]));
    page.mergeTargetDoc.set(listingWithVariants("71e8913c", [
      { name: "23", sku: "FRODAM-71E8913C-23" },
    ]));

    const preview = page.mergePreview();
    expect(preview?.matchedVariants).toBe(1);
    expect(preview?.newVariants).toBe(1);
  });
});
