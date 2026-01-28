// review.ts - Versión mejorada con UX completa
import { Component, computed, inject, signal } from "@angular/core";
import { ActivatedRoute, Router } from "@angular/router";
import { FormsModule } from "@angular/forms";
import { NormalizedListingsService } from "../../core/normalized-listings.service";
import { AuthService } from "../../core/auth.service";
import { CategoriesService, Category } from "../../core/categories.service";
import { SuppliersService, Supplier } from "../../core/suppliers.service";
import { doc, getDoc } from "firebase/firestore";
import { FIRESTORE } from "../../core/firebase.providers";
import type { NormalizedListingDoc, RawPost, NormalizedItem, ItemPrice, PriceTierGlobal } from "../../core/firestore-contracts";

@Component({
  standalone: true,
  selector: "app-review",
  imports: [FormsModule],
  templateUrl: "./review.html",
  styleUrl: "./review.css",
})
export default class ReviewPage {
  private route = inject(ActivatedRoute);
  private router = inject(Router);
  private svc = inject(NormalizedListingsService);
  private auth = inject(AuthService);
  private categoriesService = inject(CategoriesService);
  private suppliersService = inject(SuppliersService);

  id = this.route.snapshot.paramMap.get("id")!;

  loading = signal(false);
  error = signal<string | null>(null);

  doc = signal<NormalizedListingDoc | null>(null);
  draft = signal<NormalizedListingDoc | null>(null);

  // Contexto RAW (solo lectura)
  rawText = signal<string>("");
  rawImages = signal<string[]>([]);

  // UX: imágenes excluidas
  excludedImages = signal<string[]>([]);

  // Mapa: URL imagen → color asignado
  imageColors: Record<string, string> = {};

  // Categorías
  categorySearch = "";
  filteredCategories = signal<Category[]>([]);
  showCategoryDropdown = signal(false);

  // Proveedores
  activeSuppliers = computed(() => this.suppliersService.getActive());

  // Modal para seleccionar imagen
  showImagePicker = signal(false);
  currentVariantIndex = -1;

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
    this.onCategorySearch(); // Inicializar lista
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
      if (!clone.review) {
        clone.review = {
          preview_image_url: null,
          excluded_image_urls: [],
          edited_at: null,
          edited_by: null
        };
      }
      clone.preview_image_url = clone.preview_image_url ?? null;

      this.draft.set(clone);
      this.excludedImages.set(clone.review.excluded_image_urls || []);

      // carga RAW para contexto (solo lectura)
      await this.loadRawContext(d.raw_post_id);

      // asegura cover si no hay
      if (!this.draft()!.preview_image_url) {
        const first = this.visibleRawImages()[0] || null;
        this.draft.set({ ...this.draft()!, preview_image_url: first });
      }

      // Inicializar colores desde variantes existentes
      this.initializeImageColors();

    } catch (e: any) {
      this.error.set(e?.message || String(e));
    } finally {
      this.loading.set(false);
    }
  }

  private initializeImageColors() {
    const d = this.draft();
    if (!d) return;

    // Extraer colores de variantes existentes
    d.listing.items.forEach(item => {
      if (item.image_url && item.color) {
        this.imageColors[item.image_url] = item.color;
      }
    });
  }

  private async loadRawContext(rawPostId: string) {
    const rawRef = doc(FIRESTORE, "raw_posts", rawPostId);
    const snap = await getDoc(rawRef);
    if (!snap.exists()) return;

    const raw = snap.data() as RawPost;
    this.rawText.set(raw?.message?.raw_text || "");

    const urls =
      (raw?.media?.images || [])
        .map((x) => x?.url)
        .filter((url): url is string => Boolean(url));

    this.rawImages.set(urls);
  }

  // ==========================================================================
  // CATEGORÍAS
  // ==========================================================================

  onCategorySearch() {
    const results = this.categoriesService.search(this.categorySearch);
    this.filteredCategories.set(results.slice(0, 10)); // Top 10
  }

  selectCategory(cat: Category) {
    const d = this.draft();
    if (!d) return;

    d.listing.category_hint = cat.fullPath;
    this.categorySearch = cat.fullPath;
    this.showCategoryDropdown.set(false);
    this.draft.set({ ...d });
  }

  // ==========================================================================
  // PROVEEDORES
  // ==========================================================================

  onSupplierChange() {
    // Aquí podrías cargar configuración específica del proveedor
    console.log("Proveedor cambiado:", this.draft()?.supplier_id);
  }

  // ==========================================================================
  // IMÁGENES
  // ==========================================================================

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

  // ==========================================================================
  // VARIANTES
  // ==========================================================================

  addVariant() {
    const d = this.draft();
    if (!d) return;

    const newVariant: NormalizedItem = {
      variant_name: null,
      sku: null,
      stock_state: "unknown_qty",
      notes: null,
      color: null,
      image_url: null,
      prices: [
        {
          amount: null,
          currency: "MXN",
          tier_name: "publico"
        }
      ]
    };

    d.listing.items.push(newVariant);
    this.draft.set({ ...d });
  }

  removeVariant(index: number) {
    const d = this.draft();
    if (!d || d.listing.items.length <= 1) {
      alert("Debe haber al menos una variante");
      return;
    }

    if (confirm("¿Eliminar esta variante?")) {
      d.listing.items.splice(index, 1);
      this.draft.set({ ...d });
    }
  }

  pickImageForVariant(index: number) {
    this.currentVariantIndex = index;
    this.showImagePicker.set(true);
  }

  assignImageToVariant(imageUrl: string) {
    const d = this.draft();
    if (!d || this.currentVariantIndex < 0) return;

    const variant = d.listing.items[this.currentVariantIndex];
    variant.image_url = imageUrl;

    // Auto-asignar color si ya lo tiene la imagen
    if (this.imageColors[imageUrl]) {
      variant.color = this.imageColors[imageUrl];
    }

    this.draft.set({ ...d });
    this.closeImagePicker();
  }

  closeImagePicker() {
    this.showImagePicker.set(false);
    this.currentVariantIndex = -1;
  }

  // ==========================================================================
  // PRECIOS
  // ==========================================================================

  addPriceToVariant(variantIndex: number) {
    const d = this.draft();
    if (!d) return;

    const variant = d.listing.items[variantIndex];
    variant.prices.push({
      amount: null,
      currency: "MXN",
      tier_name: ""
    });

    this.draft.set({ ...d });
  }

  removePriceFromVariant(variantIndex: number, priceIndex: number) {
    const d = this.draft();
    if (!d) return;

    const variant = d.listing.items[variantIndex];
    if (variant.prices.length <= 1) {
      alert("Debe haber al menos un precio");
      return;
    }

    variant.prices.splice(priceIndex, 1);
    this.draft.set({ ...d });
  }

  // ==========================================================================
  // DESCUENTOS GLOBALES
  // ==========================================================================

  addGlobalDiscount() {
    const d = this.draft();
    if (!d) return;

    d.listing.price_tiers_global.push({
      tier_name: "",
      discount_percent: null,
      notes: null
    });

    this.draft.set({ ...d });
  }

  removeGlobalDiscount(index: number) {
    const d = this.draft();
    if (!d || d.listing.price_tiers_global.length <= 1) {
      alert("Debe haber al menos un tier de precio");
      return;
    }

    d.listing.price_tiers_global.splice(index, 1);
    this.draft.set({ ...d });
  }

  // ==========================================================================
  // ACCIONES FINALES
  // ==========================================================================

  async save() {
    try {
      const d = this.draft();
      if (!d) return;

      // Validar que tenga al menos una variante
      if (d.listing.items.length === 0) {
        alert("Agrega al menos una variante antes de guardar");
        return;
      }

      // Actualizar colores en imageColors desde variantes
      d.listing.items.forEach(item => {
        if (item.image_url && item.color) {
          this.imageColors[item.image_url] = item.color;
        }
      });

      await this.svc.updateListing(this.id, {
        listing: d.listing,
        supplier_id: d.supplier_id ?? null,
        preview_image_url: d.preview_image_url ?? this.coverUrl(),
      });

      // Actualizar review con excluded_image_urls
      await this.svc.updateReview(this.id, {
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
      const uid = this.auth.uid();
      if (!uid) {
        this.error.set("Usuario no autenticado");
        return;
      }

      const d = this.draft();
      if (!d) return;

      // Validaciones pre-validación
      if (!d.supplier_id) {
        alert("Selecciona un proveedor");
        return;
      }

      if (!d.listing.title) {
        alert("Agrega un título");
        return;
      }

      if (!d.listing.category_hint) {
        alert("Selecciona una categoría");
        return;
      }

      if (d.listing.items.length === 0) {
        alert("Agrega al menos una variante");
        return;
      }

      // Validar que cada variante tenga precio
      const invalidVariants = d.listing.items.filter(
        item => !item.prices.some(p => p.amount && p.amount > 0)
      );

      if (invalidVariants.length > 0) {
        alert("Todas las variantes deben tener al menos un precio válido");
        return;
      }

      // Guardar antes de validar
      await this.save();

      // Validar
      await this.svc.validate(this.id, uid);
      await this.router.navigateByUrl("/inbox");
    } catch (e: any) {
      this.error.set(e?.message || String(e));
    }
  }

  async reject() {
    if (!confirm("¿Rechazar este listing? (No se borrará, quedará marcado como rechazado)")) return;
    try {
      // ✅ FIX: Obtener UID real y usar reject() en lugar de discard()
      const uid = this.auth.uid();
      if (!uid) {
        this.error.set("Usuario no autenticado");
        return;
      }
      
      await this.svc.reject(this.id, uid);
      await this.router.navigateByUrl("/inbox");
    } catch (e: any) {
      this.error.set(e?.message || String(e));
    }
  }

  goInbox() {
    this.router.navigateByUrl("/inbox");
  }
}
