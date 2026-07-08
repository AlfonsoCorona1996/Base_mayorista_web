import { Injectable, signal } from "@angular/core";
import { environment } from "../../environments/environment";

export type FeatureFlag = "returnsV2" | "inventoryProductsV2" | "customerCrmV2";

@Injectable({ providedIn: "root" })
export class FeatureFlagsService {
  private state = signal<Record<FeatureFlag, boolean>>({
    returnsV2: this.initial("returnsV2"),
    inventoryProductsV2: this.initial("inventoryProductsV2"),
    customerCrmV2: this.initial("customerCrmV2"),
  });

  enabled(flag: FeatureFlag): boolean {
    return this.state()[flag];
  }

  set(flag: FeatureFlag, enabled: boolean): void {
    localStorage.setItem(`bm_feature_${flag}`, enabled ? "1" : "0");
    this.state.update((current) => ({ ...current, [flag]: enabled }));
  }

  private initial(flag: FeatureFlag): boolean {
    const override = typeof localStorage === "undefined" ? null : localStorage.getItem(`bm_feature_${flag}`);
    if (override === "1" || override === "0") return override === "1";
    return (environment as any).featureFlags?.[flag] !== false;
  }
}
