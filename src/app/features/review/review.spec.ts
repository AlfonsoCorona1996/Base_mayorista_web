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
