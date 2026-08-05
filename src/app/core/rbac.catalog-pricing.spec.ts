import { CAPABILITY_KEYS, buildRolePreset } from "./rbac.constants";

describe("permisos de precio del catálogo", () => {
  it("mantiene la venta bajo costo como una concesión explícita", () => {
    expect(CAPABILITY_KEYS).toContain("cap.orders.price_below_cost");
    expect(buildRolePreset("super_admin").capabilities["cap.orders.price_below_cost"]).toBeTrue();
    expect(buildRolePreset("admin").capabilities["cap.orders.price_below_cost"]).toBeFalse();
    expect(buildRolePreset("operativo").capabilities["cap.orders.price_below_cost"]).toBeFalse();
  });
});
