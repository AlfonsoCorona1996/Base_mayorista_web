import { TestBed } from "@angular/core/testing";
import { BarcodeProductLookupService } from "./barcode-product-lookup.service";
import { CatalogProductsService } from "./catalog-products.service";
import { InventoryService } from "./inventory.service";
import { NormalizedListingsService } from "./normalized-listings.service";

describe("BarcodeProductLookupService Catalogo v2", () => {
  it("consulta solo identificadores barcode/OCR y nunca cae al SKU legacy", async () => {
    const catalogProducts = jasmine.createSpyObj<CatalogProductsService>(
      "CatalogProductsService",
      ["searchCatalog", "getLegacyBySku"],
    );
    catalogProducts.searchCatalog.and.resolveTo([]);
    catalogProducts.getLegacyBySku.and.resolveTo({} as never);
    const inventory = jasmine.createSpyObj<InventoryService>("InventoryService", ["getBySku"]);
    inventory.getBySku.and.resolveTo(null);
    const listings = jasmine.createSpyObj<NormalizedListingsService>(
      "NormalizedListingsService",
      ["findValidatedByVariantSku"],
    );

    TestBed.configureTestingModule({
      providers: [
        BarcodeProductLookupService,
        { provide: CatalogProductsService, useValue: catalogProducts },
        { provide: InventoryService, useValue: inventory },
        { provide: NormalizedListingsService, useValue: listings },
      ],
    });

    const matches = await TestBed.inject(BarcodeProductLookupService).findMatches("SUP-001", "catalogo");

    expect(matches).toEqual([]);
    expect(catalogProducts.searchCatalog).toHaveBeenCalledWith("SUP-001", {
      businessId: "catalogo",
      types: ["barcode", "ocr_alias"],
      limit: 25,
      exact: true,
    });
    expect(catalogProducts.getLegacyBySku).not.toHaveBeenCalled();
    expect(inventory.getBySku).not.toHaveBeenCalled();
  });
});
