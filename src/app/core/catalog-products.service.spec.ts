import { signal } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { of } from "rxjs";
import { UserAdminApiService } from "../services/user-admin-api.service";
import { BusinessScopeService } from "./business-scope.service";
import { CatalogProductsService } from "./catalog-products.service";

describe("CatalogProductsService Catalogo v2", () => {
  let service: CatalogProductsService;
  let api: jasmine.SpyObj<UserAdminApiService>;

  beforeEach(() => {
    api = jasmine.createSpyObj<UserAdminApiService>("UserAdminApiService", ["get", "post"]);
    TestBed.configureTestingModule({
      providers: [
        CatalogProductsService,
        { provide: UserAdminApiService, useValue: api },
        {
          provide: BusinessScopeService,
          useValue: {
            activeBusinessIds: signal(["catalogo"]),
            availableBusinessIds: () => ["catalogo"],
            canAccessBusiness: () => true,
          },
        },
      ],
    });
    service = TestBed.inject(CatalogProductsService);
  });

  it("normaliza un producto v2 sin convertir el supplier SKU en barcode", async () => {
    api.get.and.returnValue(of({
      ok: true,
      results: [{
        product: {
          schema_version: 2,
          product_id: "prod-stable-1",
          business_id: "catalogo",
          supplier_sku: "SUP-001",
          sku: "SUP-001",
          name: "Producto provisional",
          prices: { cost: 100, clienta: 130, currency: "MXN" },
        },
        variants: [],
        matched_identifier: {
          identifier_id: "supplier-sku-1",
          type: "supplier_sku",
          value: "SUP-001",
          normalized_value: "sup-001",
          scope: "variant",
        },
        requires_selection: false,
      }],
    }));

    const [result] = await service.searchCatalog("SUP-001");

    expect(result.product?.product_id).toBe("prod-stable-1");
    expect(result.product?.primary_barcode).toBeNull();
    expect(result.product?.supplier_sku).toBe("SUP-001");
    expect(result.product?.prices).toEqual({ cost: 100, clienta: 130, currency: "MXN" });
  });

  it("mantiene agrupadas las variantes y exige seleccion para un identificador de grupo", async () => {
    api.get.and.returnValue(of({
      ok: true,
      results: [{
        product: null,
        group: { group_id: "group-1", business_id: "catalogo", name: "Modelo 123" },
        variants: [
          { schema_version: 2, product_id: "variant-s", business_id: "catalogo", primary_barcode: "0001", name: "Modelo 123", size: "S", prices: { cost: 10, clienta: 15 } },
          { schema_version: 2, product_id: "variant-m", business_id: "catalogo", primary_barcode: "0002", name: "Modelo 123", size: "M", prices: { cost: 10, clienta: 15 } },
        ],
        matched_identifier: {
          identifier_id: "model-123",
          type: "model",
          value: "123",
          normalized_value: "123",
          scope: "group",
        },
        requires_selection: true,
      }],
    }));

    const [result] = await service.searchCatalog("123");

    expect(result.product).toBeNull();
    expect(result.group?.group_id).toBe("group-1");
    expect(result.requires_selection).toBeTrue();
    expect(result.variants.map((variant) => variant.product_id)).toEqual(["variant-s", "variant-m"]);
  });

  it("filtra provisionales solo cuando la búsqueda se usará para vender", async () => {
    api.get.and.returnValue(of({
      ok: true,
      results: [{
        product: null,
        group: { group_id: "group-1", business_id: "catalogo", name: "Modelo editorial" },
        variants: [
          { schema_version: 2, product_id: "sellable", business_id: "catalogo", name: "Vendible", sellable: true, prices: { cost: 10 } },
          { schema_version: 2, product_id: "provisional", business_id: "catalogo", name: "Provisional", sellable: false, prices: { cost: null } },
        ],
        matched_identifier: { type: "model", value: "MOD", normalized_value: "mod", scope: "group" },
        requires_selection: true,
      }],
    }));

    const [result] = await service.searchCatalog("MOD", { sellableOnly: true });

    expect(result.variants.map((variant) => variant.product_id)).toEqual(["sellable"]);

    const [administrativeResult] = await service.searchCatalog("MOD");
    expect(administrativeResult.variants.map((variant) => variant.product_id)).toEqual(["sellable", "provisional"]);
  });

  it("registra alias OCR mediante backend y no mediante Firestore", async () => {
    api.post.and.returnValue(of({
      ok: true,
      identifier: {
        identifier_id: "ocr-1",
        type: "ocr_alias",
        value: "ABC-987",
        normalized_value: "abc-987",
        scope: "variant",
        product_id: "prod-stable-1",
        revision: 1,
      },
    }));

    const identifier = await service.saveOcrAlias("prod-stable-1", "ABC-987");

    expect(api.post).toHaveBeenCalledWith(
      "/api/admin/catalog-products/prod-stable-1/identifiers",
      jasmine.objectContaining({ business_id: "catalogo", type: "ocr_alias", source: "scanner_ocr" }),
    );
    expect(identifier.type).toBe("ocr_alias");
    expect(identifier.product_id).toBe("prod-stable-1");
  });
});
