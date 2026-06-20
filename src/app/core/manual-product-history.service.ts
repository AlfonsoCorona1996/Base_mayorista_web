import { Injectable, signal } from "@angular/core";
import { FIRESTORE } from "./firebase.providers";
import {
  collection,
  deleteDoc,
  doc,
  getDocs,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
} from "firebase/firestore";
import { BusinessScopeService } from "./business-scope.service";
import { BusinessId, normalizeBusinessId } from "./rbac.constants";

export interface ManualProductEntry {
  id: string;
  business_id: BusinessId;
  title: string;
  variant: string;
  color: string;
  image_url: string | null;
  price_public: number | null;
  price_clienta: number | null;
  price_cost: number | null;
  used_count: number;
  last_used_at: string;
  created_at: string;
}

@Injectable({ providedIn: "root" })
export class ManualProductHistoryService {
  private colRef = collection(FIRESTORE, "manual_product_suggestions");
  constructor(private businessScope: BusinessScopeService) {}

  readonly entries = signal<ManualProductEntry[]>([]);
  readonly loading = signal(false);

  async load(businessId?: BusinessId): Promise<void> {
    this.loading.set(true);
    try {
      // Fetch all docs and sort in client-side to avoid index-dependent failures.
      const businessIds = businessId ? [normalizeBusinessId(businessId)] : this.businessScope.activeBusinessIds();
      const snap = await getDocs(query(this.colRef, where("business_id", "in", businessIds)));
      const rows = snap.docs
        .map((d) => this.normalize(d.id, d.data()))
        .sort((a, b) => {
          if (a.used_count !== b.used_count) return b.used_count - a.used_count;
          const aTime = Date.parse(a.last_used_at || "");
          const bTime = Date.parse(b.last_used_at || "");
          return (Number.isFinite(bTime) ? bTime : 0) - (Number.isFinite(aTime) ? aTime : 0);
        });
      this.entries.set(rows);
    } finally {
      this.loading.set(false);
    }
  }

  /**
   * Global manual-history suggestions.
   * - Empty query: top global by usage/recency.
   * - With query: search in title/variant/color.
   * Returns up to 20 rows.
   */
  search(queryText: string, businessId?: BusinessId): ManualProductEntry[] {
    const q = this.normalizeSearchValue(queryText);
    const active = businessId ? [normalizeBusinessId(businessId)] : this.businessScope.activeBusinessIds();
    const rows = this.entries().filter((entry) => active.includes(entry.business_id || "bm"));
    if (!q) return rows.slice(0, 20);

    return rows
      .filter((e) => this.normalizeSearchValue([e.title, e.variant, e.color].join(" ")).includes(q))
      .slice(0, 20);
  }

  /**
   * Register one manual product usage (create/update suggestion row).
   */
  async record(
    entry: Pick<ManualProductEntry, "title" | "variant" | "color" | "image_url" | "price_public" | "price_clienta" | "price_cost">,
    businessId?: BusinessId,
  ): Promise<void> {
    const title = entry.title?.trim();
    if (!title) return;

    const resolvedBusinessId = normalizeBusinessId(businessId || this.businessScope.writeBusinessId());
    const normalized = this.normalizeSearchValue(title);
    const existing = this.entries().find((e) => e.business_id === resolvedBusinessId && this.normalizeSearchValue(e.title) === normalized);
    const imageUrl = this.normalizeImageUrl(entry.image_url);

    const now = new Date().toISOString();

    if (existing) {
      const ref = doc(this.colRef, existing.id);
      const nextImageUrl = imageUrl ?? existing.image_url ?? null;
      const nextVariant = entry.variant || existing.variant;
      const nextColor = entry.color || existing.color;
      const nextPricePublic = entry.price_public ?? existing.price_public;
      const nextPriceClienta = entry.price_clienta ?? existing.price_clienta;
      const nextPriceCost = entry.price_cost ?? existing.price_cost;
      await updateDoc(ref, {
        used_count: existing.used_count + 1,
        last_used_at: serverTimestamp(),
        price_public: nextPricePublic,
        price_clienta: nextPriceClienta,
        price_cost: nextPriceCost,
        variant: nextVariant,
        color: nextColor,
        image_url: nextImageUrl,
      });

      this.entries.update((rows) =>
        rows.map((r) =>
          r.id === existing.id
            ? {
                ...r,
                used_count: r.used_count + 1,
                last_used_at: now,
                price_public: nextPricePublic,
                price_clienta: nextPriceClienta,
                price_cost: nextPriceCost,
                variant: nextVariant,
                color: nextColor,
                image_url: nextImageUrl,
              }
            : r,
        ),
      );
    } else {
      const id = `mp_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
      const newEntry: ManualProductEntry = {
        id,
        business_id: resolvedBusinessId,
        title,
        variant: entry.variant || "",
        color: entry.color || "",
        image_url: imageUrl,
        price_public: entry.price_public ?? null,
        price_clienta: entry.price_clienta ?? null,
        price_cost: entry.price_cost ?? null,
        used_count: 1,
        last_used_at: now,
        created_at: now,
      };

      await setDoc(doc(this.colRef, id), {
        ...newEntry,
        business_id: resolvedBusinessId,
        last_used_at: serverTimestamp(),
        created_at: serverTimestamp(),
      });

      this.entries.update((rows) => [newEntry, ...rows]);
    }
  }

  async delete(id: string): Promise<void> {
    await deleteDoc(doc(this.colRef, id));
    this.entries.update((rows) => rows.filter((r) => r.id !== id));
  }

  private normalize(id: string, data: any): ManualProductEntry {
    return {
      id,
      business_id: normalizeBusinessId(data.business_id),
      title: String(data.title ?? ""),
      variant: String(data.variant ?? ""),
      color: String(data.color ?? ""),
      image_url: this.normalizeImageUrl(data.image_url),
      price_public: data.price_public != null ? Number(data.price_public) : null,
      price_clienta: data.price_clienta != null ? Number(data.price_clienta) : null,
      price_cost: data.price_cost != null ? Number(data.price_cost) : null,
      used_count: Number(data.used_count ?? 1),
      last_used_at: data.last_used_at?.toDate?.()?.toISOString?.() ?? data.last_used_at ?? "",
      created_at: data.created_at?.toDate?.()?.toISOString?.() ?? data.created_at ?? "",
    };
  }

  private normalizeImageUrl(value: unknown): string | null {
    if (typeof value !== "string") return null;
    const trimmed = value.trim();
    return trimmed || null;
  }

  private normalizeSearchValue(value: string | null | undefined): string {
    return String(value || "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .trim();
  }
}
