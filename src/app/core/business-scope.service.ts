import { Injectable, computed, effect, inject, signal } from "@angular/core";
import {
  BUSINESS_IDS,
  BusinessId,
  BusinessScope,
  businessLabel,
  businessShortLabel,
  normalizeBusinessId,
} from "./rbac.constants";
import { AuthzService } from "./authz.service";

@Injectable({ providedIn: "root" })
export class BusinessScopeService {
  private readonly storageKey = "business.scope.v1";
  private authz = inject(AuthzService);
  private requestedScope = signal<BusinessScope>(this.loadStoredScope());
  private scopeLockSignal = signal<{ businessId: BusinessId; reason: string } | null>(null);

  memberships = computed(() => this.authz.effectiveUserSig()?.businessMemberships || {});

  availableBusinessIds = computed<BusinessId[]>(() => {
    const memberships = this.memberships();
    const ids = BUSINESS_IDS.filter((id) => memberships[id]?.enabled);
    return ids.length > 0 ? ids : ["bm"];
  });

  showSwitcher = computed(() => this.availableBusinessIds().length > 1);
  scopeLock = computed(() => this.scopeLockSignal());
  isScopeLocked = computed(() => this.scopeLockSignal() !== null);

  scope = computed<BusinessScope>(() => {
    const lock = this.scopeLockSignal();
    if (lock) return lock.businessId;
    const requested = this.requestedScope();
    const available = this.availableBusinessIds();
    if (requested === "both") return available.length > 1 ? "both" : available[0];
    return available.includes(requested) ? requested : available[0];
  });

  activeBusinessIds = computed<BusinessId[]>(() => {
    const scope = this.scope();
    if (scope === "both") return this.availableBusinessIds();
    return [scope];
  });

  isBothMode = computed(() => this.scope() === "both");

  writeBusinessId = computed<BusinessId>(() => {
    const scope = this.scope();
    if (scope === "catalogo") return "catalogo";
    return this.availableBusinessIds()[0] || "bm";
  });

  constructor() {
    effect(() => {
      const next = this.scope();
      if (typeof window === "undefined") return;
      window.localStorage.setItem(this.storageKey, next);
    });
  }

  setScope(value: BusinessScope): void {
    if (this.scopeLockSignal()) return;
    this.requestedScope.set(value);
  }

  lockScope(businessId: BusinessId, reason: string): void {
    const normalized = normalizeBusinessId(businessId);
    if (!this.canAccessBusiness(normalized)) return;
    this.scopeLockSignal.set({ businessId: normalized, reason: reason.trim() || this.businessShortLabel(normalized) });
  }

  unlockScope(reason?: string): void {
    const current = this.scopeLockSignal();
    if (!current) return;
    if (reason && current.reason !== reason) return;
    this.scopeLockSignal.set(null);
  }

  canAccessBusiness(value: BusinessId): boolean {
    return this.availableBusinessIds().includes(value);
  }

  businessLabel(value: BusinessId): string {
    return businessLabel(value);
  }

  businessShortLabel(value: BusinessId): string {
    return businessShortLabel(value);
  }

  businessClass(value: BusinessId | string | null | undefined): string {
    return normalizeBusinessId(value) === "catalogo" ? "business-catalogo" : "business-bm";
  }

  resolveBusinessId(value: unknown): BusinessId {
    return normalizeBusinessId(value);
  }

  private loadStoredScope(): BusinessScope {
    if (typeof window === "undefined") return "bm";
    const raw = window.localStorage.getItem(this.storageKey);
    if (raw === "both" || raw === "catalogo" || raw === "bm") return raw;
    return "bm";
  }
}
