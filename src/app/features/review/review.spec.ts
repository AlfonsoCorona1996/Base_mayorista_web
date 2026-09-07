import { TestBed } from "@angular/core/testing";
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
    const listings = jasmine.createSpyObj<NormalizedListingsService>("NormalizedListingsService", ["saveReviewDecision"]);
    listings.saveReviewDecision.and.returnValue(new Promise<void>((resolve) => {
      finishWrite = resolve;
    }));
    const router = jasmine.createSpyObj<Router>("Router", ["navigateByUrl"]);
    router.navigateByUrl.and.returnValue(Promise.resolve(true));

    TestBed.configureTestingModule({
      providers: [
        ReviewPage,
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

describe("ReviewPage fusion controlada", () => {
  function buildPage(): ReviewPage {
    TestBed.configureTestingModule({
      providers: [
        ReviewPage,
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
