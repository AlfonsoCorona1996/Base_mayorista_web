// review.ts
import { Component, computed, inject, signal } from "@angular/core";
import { ActivatedRoute, Router } from "@angular/router";
import { FormsModule } from "@angular/forms";
import { NormalizedListingsService, NormalizedListingDoc } from "../../core/normalized-listings.service";
import { doc, getDoc } from "firebase/firestore";
import { FIRESTORE } from "../../core/firebase.providers"; // como lo tengas tú

@Component({
  standalone: true,
  selector: "app-review",
  imports: [FormsModule],
  templateUrl: "./review.html",
})
export default class ReviewPage {
  private route = inject(ActivatedRoute);
  private router = inject(Router);
  private svc = inject(NormalizedListingsService);

  id = this.route.snapshot.paramMap.get("id")!;

  loading = signal(false);
  error = signal<string | null>(null);

  doc = signal<NormalizedListingDoc | null>(null);
  draft = signal<NormalizedListingDoc | null>(null);

  // contexto RAW (solo lectura)
  rawText = signal<string>("");
  rawImages = signal<string[]>([]);

  // UX: imágenes excluidas
  excludedImages = signal<string[]>([]);

  visibleRawImages = computed(() => {
    const ex = new Set(this.excludedImages());
    return (this.rawImages() || []).filter(u => !!u && !ex.has(u));
  });

  coverUrl = computed(() => {
    const d = this.draft();
    const cover = d?.preview_image_url || null;
    const ex = new Set(this.excludedImages());
    if (cover && !ex.has(cover)) return cover;
    const first = this.visibleRawImages()[0] || null;
    return first;
  });

  async ngOnInit() {
    await this.load();
  }

  async load() {
    try {
      this.loading.set(true);
      this.error.set(null);

      const d = await this.svc.getById(this.id);
      this.doc.set(d);

      // copia editable
      const clone = structuredClone(d);
      // defaults
      clone.excluded_image_urls = clone.excluded_image_urls || [];
      clone.preview_image_url = clone.preview_image_url ?? null;

      this.draft.set(clone);
      this.excludedImages.set(clone.excluded_image_urls || []);

      // carga RAW para contexto (solo lectura)
      await this.loadRawContext(d.raw_post_id);

      // asegura cover si no hay
      if (!this.draft()!.preview_image_url) {
        const first = this.visibleRawImages()[0] || null;
        this.draft.set({ ...this.draft()!, preview_image_url: first });
      }
    } catch (e: any) {
      this.error.set(e?.message || String(e));
    } finally {
      this.loading.set(false);
    }
  }

  private async loadRawContext(rawPostId: string) {
    const rawRef = doc(FIRESTORE, "raw_posts", rawPostId);
    const snap = await getDoc(rawRef);
    if (!snap.exists()) return;

    const raw = snap.data() as any;
    this.rawText.set(raw?.message?.raw_text || "");

    const urls =
      (raw?.media?.images || [])
        .map((x: any) => x?.url)
        .filter(Boolean);

    this.rawImages.set(urls);
  }

  setCover(url: string) {
    if (!url) return;
    // si estaba excluida, la re-habilitamos
    const ex = new Set(this.excludedImages());
    if (ex.has(url)) {
      ex.delete(url);
      this.excludedImages.set(Array.from(ex));
    }
    this.draft.set({ ...this.draft()!, preview_image_url: url });
  }

  removeImage(url: string) {
    if (!url) return;

    const ex = new Set(this.excludedImages());
    ex.add(url);
    const nextExcluded = Array.from(ex);
    this.excludedImages.set(nextExcluded);

    // si quitaste la portada, muévete a otra visible
    const d = this.draft()!;
    if (d.preview_image_url === url) {
      const nextCover = this.visibleRawImages().filter(u => u !== url)[0] || null;
      this.draft.set({ ...d, preview_image_url: nextCover });
    }
  }

  async save() {
    try {
      const d = this.draft();
      if (!d) return;

      await this.svc.updateListing(this.id, {
        listing: d.listing,
        supplier_id: d.supplier_id ?? null,
        preview_image_url: d.preview_image_url ?? this.coverUrl(),
        excluded_image_urls: this.excludedImages(),
      });

      await this.load();
      alert("Guardado ✅");
    } catch (e: any) {
      alert("No se pudo guardar: " + (e?.message || String(e)));
    }
  }

  async validate() {
    try {
      // por ahora UID dummy (luego lo conectas con Auth)
      const uid = "admin";
      await this.svc.validate(this.id, uid);
      await this.router.navigateByUrl("/inbox");
    } catch (e: any) {
      this.error.set(e?.message || String(e));
    }
  }

  async discard() {
    if (!confirm("¿Eliminar este listing?")) return;
    try {
      await this.svc.discard(this.id);
      await this.router.navigateByUrl("/inbox");
    } catch (e: any) {
      this.error.set(e?.message || String(e));
    }
  }

  goInbox() {
    this.router.navigateByUrl("/inbox");
  }
}
