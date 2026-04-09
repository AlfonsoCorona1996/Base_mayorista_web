// review.ts - Versión mejorada con UX completa
import { Component, computed, inject, signal, ChangeDetectionStrategy } from "@angular/core";
import { ActivatedRoute, Router } from "@angular/router";
import { FormsModule } from "@angular/forms";
import { NormalizedListingsService } from "../../core/normalized-listings.service";
import { AuthService } from "../../core/auth.service";
import { CategoriesService, Category } from "../../core/categories.service";
import { SuppliersService } from "../../core/suppliers.service";
import { doc, getDoc } from "firebase/firestore";
import { ref, uploadBytes, getDownloadURL } from "firebase/storage";
import { FIRESTORE, STORAGE } from "../../core/firebase.providers";
import type {
  ItemPricesV3,
  NormalizedItemV3,
  NormalizedListingDocV3,
  RawPost,
  StockState,
} from "../../core/firestore-contracts";
import { isNormalizedListingDocV3 } from "../../core/firestore-contracts";

type ReviewPopupKind = "info" | "success" | "warning" | "error";

interface ReviewPopupState {
  kind: ReviewPopupKind;
  title: string;
  message: string;
  confirmText: string;
  dismissible?: boolean;
}

interface MergeOptions {
  supplier: boolean;
  title: boolean;
  category: boolean;
  images: boolean;
  globalColors: boolean;
  appendVariants: boolean;
  updateExistingVariantStock: boolean;
  updateExistingVariantPrices: boolean;
  updateExistingVariantNotes: boolean;
}

interface MergePreview {
  newImages: number;
  newColors: number;
  newVariants: number;
  matchedVariants: number;
}

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  standalone: true,
  selector: "app-review",
  imports: [FormsModule],
  templateUrl: "./review.html",
  styleUrl: "./review.css",
})
export default class ReviewPage {
  private readonly requiredSchemaVersion = "normalized_v3.0";
  private route = inject(ActivatedRoute);
  private router = inject(Router);
  private svc = inject(NormalizedListingsService);
  private auth = inject(AuthService);
  private categoriesService = inject(CategoriesService);
  private suppliersService = inject(SuppliersService);

  id = this.route.snapshot.paramMap.get("id")!;

  loading = signal(false);
  error = signal<string | null>(null);

  doc = signal<NormalizedListingDocV3 | null>(null);
  draft = signal<NormalizedListingDocV3 | null>(null);

  // Contexto RAW (solo lectura)
  rawText = signal<string>("");
  rawImages = signal<string[]>([]);

  // UX: imágenes excluidas
  excludedImages = signal<string[]>([]);

  // Mapa: URL imagen → color asignado
  imageColors: Record<string, string> = {};
  private globalColorOriginalByIndex: Record<number, string> = {};

  // Categorías
  categorySearch = "";
  filteredCategories = signal<Category[]>([]);
  showCategoryDropdown = signal(false);
  categoryProposalSaving = signal(false);
  // Propuesta IA: el usuario puede editar la ruta antes de crearla
  editableCategoryProposal = signal<string>("");

  // Proveedores
  activeSuppliers = computed(() => this.suppliersService.getActive());

  // Modal para seleccionar imagen
  showImagePicker = signal(false);
  currentVariantIndex = -1;
  currentColorIndex = -1; // Índice del color que estamos editando
  
  // Upload de imágenes
  uploading = signal(false);
  uploadError = signal<string | null>(null);
  hasVariantColors = signal(false);
  useSharedPrices = signal(false);

  mergeTargetsLoading = signal(false);
  mergeTargetLoading = signal(false);
  mergeApplying = signal(false);
  mergeSearch = signal("");
  mergeTargets = signal<NormalizedListingDocV3[]>([]);
  mergeSelectedTargetId = signal<string | null>(null);
  mergeTargetDoc = signal<NormalizedListingDocV3 | null>(null);
  mergeOptions = signal<MergeOptions>({
    supplier: false,
    title: false,
    category: false,
    images: true,
    globalColors: true,
    appendVariants: true,
    updateExistingVariantStock: true,
    updateExistingVariantPrices: false,
    updateExistingVariantNotes: false,
  });

  popupState = signal<ReviewPopupState | null>(null);
  private popupResolver: ((value: boolean) => void) | null = null;

  readonly stockOptions: Array<{ value: StockState; label: string }> = [
    { value: "in_stock", label: "Disponible" },
    { value: "last_pair", label: "Ultima pieza" },
    { value: "out_of_stock", label: "Agotado" },
    { value: "unknown_qty", label: "Sin confirmar" },
  ];

  visibleRawImages = computed(() => {
    const ex = new Set(this.excludedImages());
    return (this.rawImages() || []).filter(u => !!u && !ex.has(u));
  });

  filteredMergeTargets = computed(() => {
    const source = this.draft();
    const query = (this.mergeSearch() || "").trim().toLowerCase();
    const sourceSupplier = (source?.supplier_id || "").trim().toLowerCase();

    const ranked = this.mergeTargets()
      .filter((entry) => entry.normalized_id !== this.id)
      .map((entry) => {
        const title = (entry.listing.title || "").trim();
        const supplier = (entry.supplier_id || "").trim();
        const haystack = `${entry.normalized_id} ${title} ${supplier}`.toLowerCase();
        const scoreSupplier = sourceSupplier && supplier.toLowerCase() === sourceSupplier ? 1 : 0;
        const scoreText = query && haystack.includes(query) ? 1 : 0;
        return {
          entry,
          score: scoreSupplier * 2 + scoreText,
          haystack,
        };
      })
      .filter((row) => !query || row.haystack.includes(query) || row.score > 0)
      .sort((a, b) => b.score - a.score || a.entry.normalized_id.localeCompare(b.entry.normalized_id))
      .map((row) => row.entry);

    return ranked;
  });

  mergePreview = computed<MergePreview | null>(() => {
    const source = this.draft();
    const target = this.mergeTargetDoc();
    if (!source || !target) return null;

    const sourceImages = this.collectDocumentImages(source);
    const targetImages = new Set(this.collectDocumentImages(target));
    const newImages = sourceImages.filter((url) => !targetImages.has(url)).length;

    const sourceColors = this.collectColorNames(source);
    const targetColors = new Set(this.collectColorNames(target));
    const newColors = sourceColors.filter((name) => !targetColors.has(name)).length;

    const targetIndex = this.buildVariantIndex(target.listing.items);
    let matchedVariants = 0;
    let newVariants = 0;

    source.listing.items.forEach((item) => {
      const key = this.variantMatchKey(item);
      if (!key) {
        newVariants += 1;
        return;
      }
      if (targetIndex.has(key)) {
        matchedVariants += 1;
      } else {
        newVariants += 1;
      }
    });

    return {
      newImages,
      newColors,
      newVariants,
      matchedVariants,
    };
  });

  private moneyFormatter = new Intl.NumberFormat("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  private priceInputBuffers: Record<string, string> = {};
  private sharedPriceInputBuffers: Record<"costo" | "final", string> = {
    costo: "",
    final: "",
  };
  private priceAlertShownByKey = new Set<string>();

  // ✅ Schema v1.1: Portada con fallback a v1
  coverUrl = computed(() => {
    const d = this.draft();
    if (!d) return null;
    
    // v1.1: Usar cover_images[0]
    if (d.cover_images && d.cover_images.length > 0) {
      return d.cover_images[0];
    }
    
    // v1: Fallback a preview_image_url
    const cover = d.preview_image_url || null;
    const ex = new Set(this.excludedImages());
    if (cover && !ex.has(cover)) return cover;
    
    const first = this.visibleRawImages()[0] || null;
    return first;
  });
  
  async ngOnInit() {
    await this.categoriesService.loadCategories();
    await this.load();
    await this.loadMergeTargets();
    this.onCategorySearch(); // Inicializar lista
  }

  async load() {
    try {
      this.loading.set(true);
      this.error.set(null);

      const d = await this.svc.getById(this.id);
      if (!this.isRequiredSchema(d)) {
        throw new Error(`Esquema no soportado. Se requiere ${this.requiredSchemaVersion}.`);
      }
      this.doc.set(d);

      // copia editable
      const clone = structuredClone(d) as NormalizedListingDocV3;
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

      // v3: Normalizar estructura editable de variantes/precios/colores
      this.normalizeV3Draft(clone);
      this.initializeSharedPriceInputs();

      // Inicializar colores desde variantes existentes (ahora con product_colors si es v1.1)
      this.initializeImageColors();
      
      // ✅ Agregar imágenes de product_colors a rawImages si no están ya
      this.syncProductColorsToRawImages();
      this.syncGlobalColorsToVariantsIfNeeded();

      // Inicializar búsqueda de categoría con la actual
      if (clone.listing.category_hint) {
        this.categorySearch = clone.listing.category_hint;
      } else if (clone.listing.category_proposed) {
        this.categorySearch = clone.listing.category_proposed;
      }

      // Inicializar propuesta editable de la IA
      this.editableCategoryProposal.set(
        String(clone.listing.category_proposed || "").trim()
      );

    } catch (e: any) {
      this.error.set(e?.message || String(e));
    } finally {
      this.loading.set(false);
    }
  }

  async loadMergeTargets() {
    this.mergeTargetsLoading.set(true);
    try {
      const rows: NormalizedListingDocV3[] = [];
      let cursor: any = null;
      const maxPages = 4;

      for (let pageIndex = 0; pageIndex < maxPages; pageIndex += 1) {
        const page = await this.svc.listValidated(100, cursor);
        (page.docs as unknown[]).forEach((entry) => {
          if (!this.isRequiredSchema(entry)) return;
          if (entry.normalized_id !== this.id) {
            rows.push(entry);
          }
        });

        if (!page.nextCursor) break;
        cursor = page.nextCursor;
      }

      this.mergeTargets.set(rows);
    } catch (error) {
      console.error("No se pudieron cargar candidatos para fusion", error);
      this.mergeTargets.set([]);
    } finally {
      this.mergeTargetsLoading.set(false);
    }
  }

  mergeOptionEnabled(key: keyof MergeOptions): boolean {
    return this.mergeOptions()[key];
  }

  onMergeOptionChange(key: keyof MergeOptions, checked: boolean) {
    const next: MergeOptions = {
      ...this.mergeOptions(),
      [key]: checked,
    };

    // Si agregamos variantes, necesitamos colores globales para mantener integridad.
    if (key === "appendVariants" && checked) {
      next.globalColors = true;
    }
    if (key === "globalColors" && !checked) {
      next.appendVariants = false;
    }

    this.mergeOptions.set(next);
  }

  mergeTargetLabel(entry: NormalizedListingDocV3): string {
    const title = (entry.listing.title || "").trim() || "(sin titulo)";
    const supplier = (entry.supplier_id || "").trim() || "sin proveedor";
    return `${title} | ${supplier} | ${entry.normalized_id}`;
  }

  async onMergeTargetChange(rawTargetId: string | null | undefined) {
    const targetId = (rawTargetId || "").trim() || null;
    this.mergeSelectedTargetId.set(targetId);

    if (!targetId) {
      this.mergeTargetDoc.set(null);
      return;
    }

    this.mergeTargetLoading.set(true);
    try {
      const loaded = await this.svc.getById(targetId);
      if (!this.isRequiredSchema(loaded)) {
        throw new Error(`El producto destino no usa esquema ${this.requiredSchemaVersion}.`);
      }

      const clone = structuredClone(loaded) as NormalizedListingDocV3;
      this.normalizeV3Draft(clone);
      this.mergeTargetDoc.set(clone);
    } catch (error: any) {
      this.mergeTargetDoc.set(null);
      this.showInfoPopup(error?.message || "No se pudo cargar el producto destino para fusion.", "Fusion", "error");
    } finally {
      this.mergeTargetLoading.set(false);
    }
  }

  async mergeIntoSelectedProduct() {
    const sourceDraft = this.draft();
    const targetId = this.mergeSelectedTargetId();

    if (!sourceDraft || !targetId) {
      this.showInfoPopup("Selecciona un producto validado destino para fusionar.", "Fusion", "warning");
      return;
    }

    if (!confirm("Se aplicara una fusion controlada al producto seleccionado. ¿Continuar?")) {
      return;
    }

    this.mergeApplying.set(true);
    try {
      let targetDoc = this.mergeTargetDoc();
      if (!targetDoc || targetDoc.normalized_id !== targetId) {
        const loaded = await this.svc.getById(targetId);
        if (!this.isRequiredSchema(loaded)) {
          throw new Error(`El producto destino no usa esquema ${this.requiredSchemaVersion}.`);
        }
        targetDoc = structuredClone(loaded) as NormalizedListingDocV3;
      }

      const merged = this.buildMergedDocument(sourceDraft, targetDoc, this.mergeOptions());

      await this.svc.updateListing(targetId, {
        supplier_id: merged.supplier_id ?? null,
        listing: merged.listing,
        preview_image_url: merged.preview_image_url ?? null,
        cover_images: merged.cover_images,
        product_colors: merged.product_colors,
      });

      const uid = this.auth.uid();
      if (uid) {
        await this.svc.reject(this.id, uid);
      }

      await this.router.navigateByUrl(`/main/catalogo/${targetId}`);
    } catch (error: any) {
      this.showInfoPopup(error?.message || "No se pudo fusionar el producto.", "Fusion", "error");
    } finally {
      this.mergeApplying.set(false);
    }
  }

  private buildMergedDocument(
    sourceDoc: NormalizedListingDocV3,
    targetDoc: NormalizedListingDocV3,
    options: MergeOptions
  ): NormalizedListingDocV3 {
    const incoming = structuredClone(sourceDoc) as NormalizedListingDocV3;
    const merged = structuredClone(targetDoc) as NormalizedListingDocV3;

    this.normalizeV3Draft(incoming);
    this.normalizeV3Draft(merged);

    if (options.supplier && incoming.supplier_id) {
      merged.supplier_id = incoming.supplier_id;
    }

    if (options.title) {
      const title = (incoming.listing.title || "").trim();
      if (title) {
        merged.listing.title = title;
      }
    }

    if (options.category) {
      const category = (incoming.listing.category_hint || "").trim();
      if (category) {
        merged.listing.category_hint = category;
      }
    }

    if (options.images) {
      const seed = this.normalizeImageArray([incoming.preview_image_url || null]);
      merged.cover_images = this.mergeStringArray(merged.cover_images || [], incoming.cover_images || [], seed);
      if (merged.cover_images.length > 0) {
        const currentPreview = (merged.preview_image_url || "").trim();
        merged.preview_image_url = currentPreview && merged.cover_images.includes(currentPreview)
          ? currentPreview
          : merged.cover_images[0];
      }
    }

    if (options.globalColors) {
      merged.product_colors = this.mergeProductColors(merged.product_colors || [], incoming.product_colors || []);
    }

    const targetIndex = this.buildVariantIndex(merged.listing.items);
    incoming.listing.items.forEach((sourceItem) => {
      const key = this.variantMatchKey(sourceItem);
      const targetItemIndex = key ? targetIndex.get(key) : undefined;

      if (targetItemIndex === undefined) {
        if (!options.appendVariants) return;

        const appended = this.cloneVariantForMerge(sourceItem);
        merged.listing.items.push(appended);

        const appendedIndex = merged.listing.items.length - 1;
        const appendedKey = this.variantMatchKey(appended);
        if (appendedKey && !targetIndex.has(appendedKey)) {
          targetIndex.set(appendedKey, appendedIndex);
        }
        return;
      }

      const targetItem = merged.listing.items[targetItemIndex];
      this.mergeVariantData(targetItem, sourceItem, options);
    });

    if (options.globalColors) {
      this.syncProductColorsFromVariantStock(merged);
      this.normalizeColorReferencesForSave(merged);
    } else {
      merged.listing.items.forEach((item) => {
        item.color_stock = this.normalizeColorStock(item.color_stock || [], item.stock_state);
      });
    }

    if (!merged.preview_image_url && merged.cover_images.length > 0) {
      merged.preview_image_url = merged.cover_images[0];
    }
    if (merged.cover_images.length === 0 && merged.preview_image_url) {
      merged.cover_images = [merged.preview_image_url];
    }

    this.ensureVariantSkus(merged);
    return merged;
  }

  private mergeVariantData(targetItem: NormalizedItemV3, sourceItem: NormalizedItemV3, options: MergeOptions) {
    if (options.updateExistingVariantStock) {
      const nextState = this.normalizeStockState(sourceItem.stock_state);
      if (nextState) {
        targetItem.stock_state = nextState;
      }
    }

    if (options.updateExistingVariantPrices) {
      const nextCost = this.toValidNumber(sourceItem.prices?.precio_costo);
      const nextFinal = this.toValidNumber(sourceItem.prices?.precio_final);
      targetItem.prices = {
        ...targetItem.prices,
        precio_costo: nextCost !== null ? nextCost : targetItem.prices?.precio_costo ?? null,
        precio_final: nextFinal !== null ? nextFinal : targetItem.prices?.precio_final ?? null,
        currency: (sourceItem.prices?.currency || targetItem.prices?.currency || "MXN").trim() || "MXN",
      };
    }

    if (options.updateExistingVariantNotes) {
      const notes = (sourceItem.notes || "").trim();
      if (notes) {
        targetItem.notes = notes;
      }
    }

    if (options.globalColors || options.updateExistingVariantStock) {
      const existingByColor = new Map(
        (targetItem.color_stock || []).map((entry) => [(entry.color_name || "").trim().toLowerCase(), entry])
      );

      (sourceItem.color_stock || []).forEach((sourceColor) => {
        const colorName = (sourceColor.color_name || "").trim();
        if (!colorName) return;

        const key = colorName.toLowerCase();
        const existing = existingByColor.get(key);

        if (!existing) {
          if (!options.globalColors) return;
          targetItem.color_stock.push({
            color_name: colorName,
            stock_state: this.normalizeStockState(sourceColor.stock_state) || targetItem.stock_state || "in_stock",
          });
          return;
        }

        if (options.updateExistingVariantStock) {
          existing.stock_state = this.normalizeStockState(sourceColor.stock_state) || existing.stock_state;
        }
      });
    }

    targetItem.color_stock = this.normalizeColorStock(targetItem.color_stock || [], targetItem.stock_state);
    this.recalculateVariantPrices(targetItem);
  }

  private cloneVariantForMerge(item: NormalizedItemV3): NormalizedItemV3 {
    const cloned = structuredClone(item) as NormalizedItemV3;
    cloned.variant_name = (cloned.variant_name || "").trim() || null;
    cloned.sku = (cloned.sku || "").trim().toUpperCase() || null;
    cloned.notes = (cloned.notes || "").trim() || null;
    cloned.stock_state = this.normalizeStockState(cloned.stock_state) || "in_stock";
    cloned.color_stock = this.normalizeColorStock(cloned.color_stock || [], cloned.stock_state);
    this.recalculateVariantPrices(cloned);
    return cloned;
  }

  private normalizeColorStock(
    entries: Array<{ color_name: string; stock_state: StockState }>,
    fallbackState: StockState | null | undefined
  ): Array<{ color_name: string; stock_state: StockState }> {
    const normalized = new Map<string, { color_name: string; stock_state: StockState }>();
    const fallback = this.normalizeStockState(fallbackState) || "in_stock";

    entries.forEach((entry) => {
      const name = (entry.color_name || "").trim();
      if (!name) return;
      const key = name.toLowerCase();
      if (normalized.has(key)) return;

      normalized.set(key, {
        color_name: name,
        stock_state: this.normalizeStockState(entry.stock_state) || fallback,
      });
    });

    return Array.from(normalized.values());
  }

  private mergeStringArray(...groups: Array<Array<string | null | undefined>>): string[] {
    const unique = new Set<string>();
    const out: string[] = [];

    groups.forEach((group) => {
      (group || []).forEach((value) => {
        const normalized = (value || "").trim();
        if (!normalized || unique.has(normalized)) return;
        unique.add(normalized);
        out.push(normalized);
      });
    });

    return out;
  }

  private mergeProductColors(base: Array<{ name: string; image_url: string | null }>, incoming: Array<{ name: string; image_url: string | null }>) {
    const map = new Map<string, { name: string; image_url: string | null }>();

    [...(base || []), ...(incoming || [])].forEach((entry) => {
      const name = (entry.name || "").trim();
      if (!name) return;
      const key = name.toLowerCase();
      const imageUrl = (entry.image_url || "").trim() || null;
      const existing = map.get(key);

      if (!existing) {
        map.set(key, { name, image_url: imageUrl });
        return;
      }

      if (!existing.image_url && imageUrl) {
        existing.image_url = imageUrl;
      }
    });

    return Array.from(map.values());
  }

  private collectDocumentImages(doc: NormalizedListingDocV3): string[] {
    return this.mergeStringArray(
      doc.cover_images || [],
      [doc.preview_image_url || null],
      (doc.product_colors || []).map((entry) => entry.image_url || null),
    );
  }

  private collectColorNames(doc: NormalizedListingDocV3): string[] {
    const names = new Set<string>();

    (doc.product_colors || []).forEach((entry) => {
      const name = (entry.name || "").trim().toLowerCase();
      if (name) names.add(name);
    });

    doc.listing.items.forEach((item) => {
      (item.color_stock || []).forEach((entry) => {
        const name = (entry.color_name || "").trim().toLowerCase();
        if (name) names.add(name);
      });
    });

    return Array.from(names.values());
  }

  private syncProductColorsFromVariantStock(doc: NormalizedListingDocV3) {
    const current = this.mergeProductColors(doc.product_colors || [], []);
    const map = new Map(current.map((entry) => [(entry.name || "").trim().toLowerCase(), entry]));

    doc.listing.items.forEach((item) => {
      (item.color_stock || []).forEach((entry) => {
        const name = (entry.color_name || "").trim();
        if (!name) return;
        const key = name.toLowerCase();
        if (!map.has(key)) {
          map.set(key, { name, image_url: null });
        }
      });
    });

    doc.product_colors = Array.from(map.values());
  }

  private buildVariantIndex(items: NormalizedItemV3[]): Map<string, number> {
    const map = new Map<string, number>();
    items.forEach((item, index) => {
      const key = this.variantMatchKey(item);
      if (!key || map.has(key)) return;
      map.set(key, index);
    });
    return map;
  }

  private variantMatchKey(item: NormalizedItemV3): string | null {
    const sku = (item.sku || "").trim().toUpperCase();
    if (sku) return `sku:${sku}`;

    const name = (item.variant_name || "").trim().toLowerCase();
    if (name) return `name:${name}`;

    const variantId = (item.variant_id || "").trim().toLowerCase();
    if (variantId) return `id:${variantId}`;

    return null;
  }

  private normalizeImageArray(values: Array<string | null | undefined>): string[] {
    return this.mergeStringArray(values || []);
  }

  private initializeImageColors() {
    const d = this.draft();
    if (!d) return;

    console.log('🎨 Inicializando colores desde Firestore...');
    console.log('Schema version:', d.schema_version);
    console.log('Product colors:', d.product_colors);

    // ✅ PRIORIDAD 1: Schema v1.1 - Cargar desde product_colors
    if (d.product_colors && d.product_colors.length > 0) {
      console.log('✅ Cargando desde product_colors (v1.1)');
      d.product_colors.forEach(color => {
        if (color.image_url && color.name) {
          this.imageColors[color.image_url] = color.name;
          console.log(`  ✓ ${color.name} → ${color.image_url.substring(0, 50)}...`);
        }
      });
      console.log('✅ Colores inicializados:', Object.keys(this.imageColors).length);
      return;
    }

    console.log('✅ Colores inicializados:', Object.keys(this.imageColors).length);
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
  
  /**
   * Sincroniza las imágenes de product_colors a rawImages
   * Para que se muestren en la galería
   */
  private syncProductColorsToRawImages() {
    const d = this.draft();
    if (!d || !d.product_colors) return;

    console.log('🔄 Sincronizando product_colors a rawImages...');
    
    const currentRaw = this.rawImages();
    const newUrls = new Set(currentRaw);

    d.product_colors.forEach(color => {
      if (color.image_url && !newUrls.has(color.image_url)) {
        newUrls.add(color.image_url);
        console.log(`  + Agregando ${color.name}: ${color.image_url.substring(0, 50)}...`);
      }
    });

    this.rawImages.set(Array.from(newUrls));
    console.log(`✅ rawImages actualizado: ${this.rawImages().length} imágenes totales`);
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
    d.listing.category_proposed = null;
    this.categorySearch = cat.fullPath;
    this.showCategoryDropdown.set(false);
    this.draft.set({ ...d });
  }

  /** Segmentos del breadcrumb de la propuesta editable */
  categoryProposalSegments(): string[] {
    return this.editableCategoryProposal()
      .split(">")
      .map((s) => s.trim())
      .filter(Boolean);
  }

  async acceptCategoryProposal() {
    const d = this.draft();
    if (!d) return;

    // Usar la ruta editable (el usuario pudo haberla modificado)
    const proposedPath = this.editableCategoryProposal().trim();
    if (!proposedPath) {
      this.showInfoPopup("Escribe la ruta de la nueva categoría antes de crearla.", "Categoría requerida", "warning");
      return;
    }

    this.categoryProposalSaving.set(true);
    try {
      const finalPath = await this.ensureCategoryPathExists(proposedPath);
      d.listing.category_hint = finalPath;
      d.listing.category_proposed = null;
      this.categorySearch = finalPath;
      this.editableCategoryProposal.set("");
      this.showCategoryDropdown.set(false);
      this.draft.set({ ...d });
      this.showInfoPopup(
        `Categoría "${finalPath}" creada y asignada correctamente.`,
        "Categoría registrada",
        "success"
      );
    } catch (error: any) {
      this.showInfoPopup(error?.message || "No se pudo registrar la categoria propuesta.", "Error al crear categoría", "error");
    } finally {
      this.categoryProposalSaving.set(false);
    }
  }

  dismissCategoryProposal() {
    const d = this.draft();
    if (!d) return;
    d.listing.category_proposed = null;
    this.editableCategoryProposal.set("");
    this.draft.set({ ...d });
  }

  chooseExistingCategoryFromProposal() {
    const proposal = this.editableCategoryProposal().trim();
    const leaf = proposal.split(">").map((s) => s.trim()).filter(Boolean).pop() || proposal;
    this.categorySearch = leaf || this.categorySearch;
    this.onCategorySearch();
    this.showCategoryDropdown.set(true);
  }

  // ==========================================================================
  // PROVEEDORES
  // ==========================================================================
  onSupplierChange() {
    const d = this.draft();
    if (!d) return;

    this.rebuildVariantSkusForSupplier(d);
    this.draft.set({ ...d });
    console.log("Proveedor cambiado:", d.supplier_id);
  }

  // ==========================================================================
  // IMÁGENES
  // ==========================================================================

  setCover(url: string | null) {
    const d = this.draft();
    if (!d) return;

    // si estaba excluida, la re-habilitamos
    if (url) {
      const ex = new Set(this.excludedImages());
      if (ex.has(url)) {
        ex.delete(url);
        this.excludedImages.set(Array.from(ex));
      }
    }

    d.preview_image_url = url ?? null;
    d.cover_images = url ? [url] : [];
    this.draft.set({ ...d });
  }

  removeImage(url: string) {
    if (!url) return;

    const ex = new Set(this.excludedImages());
    ex.add(url);
    const nextExcluded = Array.from(ex);
    this.excludedImages.set(nextExcluded);

    const d = this.draft()!;
    
    // Si quitaste la portada, muévete a otra visible
    if (this.coverUrl() === url) {
      const nextCover = this.visibleRawImages().filter(u => u !== url)[0] || null;
      d.preview_image_url = nextCover;
      d.cover_images = nextCover ? [nextCover] : [];
    }

    this.draft.set({ ...d });
    console.log("🗑️ Imagen eliminada de galería:", url);
  }

  openCoverSelector() {
    this.currentVariantIndex = -2; // Valor especial para indicar "selección de portada"
    this.currentColorIndex = -1;
    this.showImagePicker.set(true);
  }

  /**
   * COLORES GLOBALES: Agrega un color global CON imagen
   */
  addGlobalColorWithImage() {
    // Simplemente abrir el selector de imágenes disponibles
    // El color se agregará con el nombre que tenga en imageColors
    this.currentVariantIndex = -3; // Valor especial para "agregar color global"
    this.currentColorIndex = -1;
    this.showImagePicker.set(true);
  }

  /**
   * COLORES GLOBALES: Agrega un color global SIN imagen
   */
  addGlobalColorWithoutImage() {
    const colorName = prompt("Nombre del color (ej: multicolor, estampado):");
    if (!colorName) return;

    const d = this.draft();
    if (!d) return;

    if (!d.product_colors) d.product_colors = [];
    d.product_colors.push({
      name: colorName.trim(),
      image_url: null
    });
    this.addColorReferencesToSharedItems(d, colorName, null);
    this.ensureGlobalColorsInAllVariants(d);
    this.syncGlobalColorsToVariantsIfNeeded();

    this.draft.set({ ...d });
    console.log("✅ Color global sin imagen creado:", colorName);
  }

  removeGlobalColorAt(index: number) {
    const d = this.draft();
    if (!d || !d.product_colors || index < 0 || index >= d.product_colors.length) return;

    const removed = d.product_colors[index];
    if (!confirm(`¿Eliminar el color global "${removed.name}"?`)) return;

    d.product_colors.splice(index, 1);
    this.removeColorReferencesFromItems(d, removed.name);
    this.syncGlobalColorsToVariantsIfNeeded();
    this.draft.set({ ...d });
  }

  hasColorImage(url: string | null | undefined): boolean {
    return !!url && /^https?:\/\//.test(url);
  }

  touchDraft() {
    const d = this.draft();
    if (!d) return;
    this.draft.set({ ...d });
  }

  onGlobalColorFocus(index: number, name: string | null | undefined) {
    this.globalColorOriginalByIndex[index] = (name || "").trim();
  }

  onGlobalColorBlur(index: number) {
    const d = this.draft();
    if (!d) return;

    const previousName = (this.globalColorOriginalByIndex[index] || "").trim();
    const currentName = (d.product_colors?.[index]?.name || "").trim();

    if (previousName && currentName && previousName !== currentName) {
      d.listing.items.forEach((item) => {
        item.color_stock = item.color_stock.map((entry) =>
          (entry.color_name || "").trim() === previousName
            ? { ...entry, color_name: currentName }
            : entry
        );
      });
    } else if (previousName && !currentName) {
      this.removeColorReferencesFromItems(d, previousName);
    }

    const seen = new Set<string>();
    d.product_colors = (d.product_colors || [])
      .map((color) => ({
        name: (color.name || "").trim(),
        image_url: color.image_url ?? null,
      }))
      .filter((color) => {
        if (!color.name || seen.has(color.name)) return false;
        seen.add(color.name);
        return true;
      });

    const validNames = new Set(d.product_colors.map((color) => color.name));
    d.listing.items.forEach((item) => {
      item.color_stock = item.color_stock.filter((entry) => validNames.has((entry.color_name || "").trim()));
    });

    this.ensureGlobalColorsInAllVariants(d);
    this.syncGlobalColorsToVariantsIfNeeded();
    this.draft.set({ ...d });
    delete this.globalColorOriginalByIndex[index];
  }

  toggleVariantColors(checked: boolean) {
    this.hasVariantColors.set(checked);
    const d = this.draft();
    if (!d) return;

    if (checked) {
      d.listing.items.forEach((item) => {
        const parentState = this.normalizeStockState(item.stock_state) || "in_stock";
        item.color_stock = (item.color_stock || []).map((entry) => ({
          ...entry,
          stock_state: parentState,
        }));
      });
      this.draft.set({ ...d });
      return;
    }

    if (!checked) {
      this.syncGlobalColorsToVariantsIfNeeded();
      this.draft.set({ ...d });
    }
  }

  private removeColorReferencesFromItems(d: NormalizedListingDocV3, colorName: string) {
    const target = (colorName || "").trim();
    if (!target) return;

    d.listing.items.forEach((item) => {
      item.color_stock = item.color_stock.filter((entry) => (entry?.color_name || "").trim() !== target);
    });
  }

  private addColorReferencesToSharedItems(
    d: NormalizedListingDocV3,
    colorName: string,
    _imageUrl: string | null
  ) {
    const name = (colorName || "").trim();
    if (!name) return;

    d.listing.items.forEach((item) => {
      const exists = item.color_stock.some((x) => (x?.color_name || "").trim() === name);
      if (!exists) {
        item.color_stock.push({
          color_name: name,
          stock_state: this.normalizeStockState(item.stock_state) || "in_stock",
        });
      }
    });
  }

  private syncGlobalColorsToVariantsIfNeeded() {
    if (this.hasVariantColors()) return;
    const d = this.draft();
    if (!d) return;

    const globalNames = (d.product_colors || [])
      .map((color) => (color.name || "").trim())
      .filter(Boolean);

    d.listing.items.forEach((item) => {
      const existingByName = new Map(
        (item.color_stock || []).map((entry) => [entry.color_name.trim(), entry.stock_state])
      );
      const fallbackState = this.normalizeStockState(item.stock_state) || "in_stock";
      item.color_stock = globalNames.map((name) => ({
        color_name: name,
        stock_state: existingByName.get(name) || fallbackState,
      }));
    });
  }

  private ensureGlobalColorsInAllVariants(d: NormalizedListingDocV3) {
    const globalNames = (d.product_colors || [])
      .map((color) => (color.name || "").trim())
      .filter(Boolean);

    d.listing.items.forEach((item) => {
      const existing = new Set((item.color_stock || []).map((entry) => (entry.color_name || "").trim()));
      const parentState = this.normalizeStockState(item.stock_state) || "in_stock";

      globalNames.forEach((name) => {
        if (existing.has(name)) return;
        item.color_stock.push({
          color_name: name,
          stock_state: parentState,
        });
      });
    });
  }

  private normalizeColorReferencesForSave(d: NormalizedListingDocV3) {
    const normalizedColors = (d.product_colors || [])
      .map(c => ({
        name: (c.name || "").trim(),
        image_url: c.image_url ?? null
      }))
      .filter(c => c.name !== "");

    d.product_colors = normalizedColors;
    const validNames = new Set(normalizedColors.map(c => c.name));

    d.listing.items.forEach((item) => {
      const seen = new Set<string>();
      const normalizedStock = item.color_stock
        .map((entry) => ({
          color_name: (entry?.color_name || "").trim(),
          stock_state: this.normalizeStockState(entry?.stock_state) || "unknown_qty",
        }))
        .filter((entry) => {
          if (!entry.color_name || !validNames.has(entry.color_name)) return false;
          if (seen.has(entry.color_name)) return false;
          seen.add(entry.color_name);
          return true;
        });

      item.color_stock = normalizedStock;
    });
  }

  private toSkuToken(value: string | null | undefined, fallback: string, maxLen = 10): string {
    const normalized = (value || "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toUpperCase()
      .replace(/[^A-Z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");

    if (!normalized) return fallback;
    return normalized.slice(0, maxLen);
  }

  private ensureVariantSkus(d: NormalizedListingDocV3) {
    const supplierToken = this.toSkuToken(d.supplier_id, "SUP", 6);
    const listingToken = this.toSkuToken(d.normalized_id, "LIST", 8);
    const used = new Set<string>();

    // Reservar SKU ya existentes (y normalizarlos)
    d.listing.items.forEach(item => {
      if (!item.sku) return;
      const clean = item.sku.trim().toUpperCase();
      if (!clean) return;
      item.sku = clean;
      used.add(clean);
    });

    d.listing.items.forEach((item, index) => {
      if (item.sku && item.sku.trim() !== "") return;

      const variantToken = this.toSkuToken(item.variant_name, `VAR${index + 1}`, 10);
      const base = `${supplierToken}-${listingToken}-${variantToken}`;
      let candidate = base;
      let seq = 2;

      while (used.has(candidate)) {
        candidate = `${base}-${seq}`;
        seq++;
      }

      item.sku = candidate;
      used.add(candidate);
    });
  }

  private rebuildVariantSkusForSupplier(d: NormalizedListingDocV3): void {
    const supplierToken = this.toSkuToken(d.supplier_id, "SUP", 6);
    const listingToken = this.toSkuToken(d.normalized_id, "LIST", 8);
    const used = new Set<string>();

    d.listing.items.forEach((item, index) => {
      const cleanSku = (item.sku || "").trim().toUpperCase();
      const skuParts = cleanSku ? cleanSku.split("-").filter(Boolean) : [];
      const tail =
        skuParts.length >= 2
          ? skuParts.slice(1).join("-")
          : `${listingToken}-${this.toSkuToken(item.variant_name, `VAR${index + 1}`, 10)}`;

      const base = `${supplierToken}-${tail}`;
      let candidate = base;
      let seq = 2;

      while (used.has(candidate)) {
        candidate = `${base}-${seq}`;
        seq++;
      }

      item.sku = candidate;
      used.add(candidate);
    });
  }

  private isRequiredSchema(doc: unknown): doc is NormalizedListingDocV3 {
    return isNormalizedListingDocV3(doc) && doc.schema_version === this.requiredSchemaVersion;
  }

  private normalizeV3Draft(d: NormalizedListingDocV3): void {
    if (!Array.isArray(d.cover_images)) {
      d.cover_images = d.preview_image_url ? [d.preview_image_url] : [];
    }
    if (!Array.isArray(d.product_colors)) {
      d.product_colors = [];
    }

    d.listing.items.forEach((item, index: number) => {
      if (!item.variant_id || `${item.variant_id}`.trim() === "") {
        item.variant_id = item.sku || item.variant_name || `variant_${index + 1}`;
      }

      const names = new Set<string>();
      item.color_stock = item.color_stock
        .map((entry) => ({
          color_name: (entry?.color_name || "").trim(),
          stock_state: this.normalizeStockState(entry?.stock_state) || "unknown_qty",
        }))
        .filter((entry) => {
          if (!entry.color_name || names.has(entry.color_name)) return false;
          names.add(entry.color_name);
          return true;
        });

      const normalizedState = this.normalizeStockState(item.stock_state);
      item.stock_state = !normalizedState || normalizedState === "unknown_qty" ? "in_stock" : normalizedState;

      const price = item.prices as ItemPricesV3;
      const fallbackCurrency =
        typeof price?.currency === "string" && price.currency.trim() ? price.currency.trim() : "MXN";
      const costo = this.toValidNumber(price?.precio_costo);
      const precioFinalFromDoc = this.toValidNumber(price?.precio_final);
      const precioFinal = precioFinalFromDoc ?? (costo !== null ? this.roundMoney(costo * 2) : null);

      item.prices = {
        precio_costo: costo,
        precio_final: precioFinal,
        precio_clienta: null,
        currency: fallbackCurrency,
      };

      this.recalculateVariantPrices(item);
    });
  }

  private initializeSharedPriceInputs(): void {
    const d = this.draft();
    if (!d || d.listing.items.length === 0) {
      this.sharedPriceInputBuffers = { costo: "", final: "" };
      this.useSharedPrices.set(false);
      return;
    }

    const first = d.listing.items[0];
    this.sharedPriceInputBuffers = {
      costo: this.formatNumberOnly(first.prices?.precio_costo),
      final: this.formatNumberOnly(first.prices?.precio_final),
    };
    this.useSharedPrices.set(this.allVariantsShareSamePrices(d));
  }

  private allVariantsShareSamePrices(d: NormalizedListingDocV3): boolean {
    if (!d.listing.items || d.listing.items.length < 2) return false;
    const first = d.listing.items[0];
    const firstCost = this.toValidNumber(first.prices?.precio_costo);
    const firstFinal = this.toValidNumber(first.prices?.precio_final);

    return d.listing.items.every((item) => {
      const itemCost = this.toValidNumber(item.prices?.precio_costo);
      const itemFinal = this.toValidNumber(item.prices?.precio_final);
      return itemCost === firstCost && itemFinal === firstFinal;
    });
  }

  toggleSharedPrices(checked: boolean): void {
    this.useSharedPrices.set(checked);
    if (!checked) return;
    this.applySharedPricesToAllVariantsFromFirst();
  }

  private applySharedPricesToAllVariantsFromFirst(): void {
    const d = this.draft();
    if (!d || d.listing.items.length === 0) return;
    const first = d.listing.items[0];
    const sharedCost = this.toValidNumber(first.prices?.precio_costo);
    const sharedFinal = this.toValidNumber(first.prices?.precio_final);
    this.applySharedPricesToAllVariants(sharedCost, sharedFinal);
  }

  private applySharedPricesToAllVariants(
    costo: number | null,
    finalPrice: number | null,
    options?: { preserveSharedInputBuffers?: boolean }
  ): void {
    const d = this.draft();
    if (!d) return;

    d.listing.items.forEach((item, index) => {
      item.prices = {
        ...item.prices,
        precio_costo: costo,
        precio_final: finalPrice,
        currency: item.prices?.currency || "MXN",
      };
      this.recalculateVariantPrices(item);
      this.priceInputBuffers[this.priceBufferKey(index, "costo")] = this.formatNumberOnly(costo);
      this.priceInputBuffers[this.priceBufferKey(index, "final")] = this.formatNumberOnly(finalPrice);
    });

    if (!options?.preserveSharedInputBuffers) {
      this.sharedPriceInputBuffers = {
        costo: this.formatNumberOnly(costo),
        final: this.formatNumberOnly(finalPrice),
      };
    }
    this.draft.set({ ...d });
  }

  private recalculateVariantPrices(item: NormalizedItemV3): void {
    const cost = this.toValidNumber(item.prices?.precio_costo);
    const finalPrice = this.toValidNumber(item.prices?.precio_final);
    const clientPrice = finalPrice !== null ? this.roundMoney(finalPrice * 0.75) : null;
    item.prices = {
      precio_costo: cost,
      precio_final: finalPrice,
      precio_clienta: clientPrice,
      currency: item.prices?.currency || "MXN",
    };
  }

  private toValidNumber(value: unknown): number | null {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
    return this.roundMoney(value);
  }

  private roundMoney(value: number): number {
    return Math.round(value * 100) / 100;
  }

  onPriceInputChange(variantIndex: number, field: "costo" | "final", rawValue: string) {
    const d = this.draft();
    if (!d) return;
    const item = d.listing.items[variantIndex];
    if (!item) return;

    this.priceInputBuffers[this.priceBufferKey(variantIndex, field)] = rawValue;
    const parsed = this.parsePriceInput(rawValue);

    item.prices = {
      ...item.prices,
      precio_costo: field === "costo" ? parsed : item.prices.precio_costo,
      precio_final: field === "final" ? parsed : item.prices.precio_final,
      currency: item.prices?.currency || "MXN",
    };
    this.recalculateVariantPrices(item);
    this.draft.set({ ...d });
  }

  onSharedPriceInputChange(field: "costo" | "final", rawValue: string): void {
    this.sharedPriceInputBuffers[field] = rawValue;
    const parsed = this.parsePriceInput(rawValue);

    const d = this.draft();
    if (!d || d.listing.items.length === 0) return;
    const first = d.listing.items[0];
    const firstCost = this.toValidNumber(first.prices?.precio_costo);
    const firstFinal = this.toValidNumber(first.prices?.precio_final);
    const nextCost = field === "costo" ? parsed : firstCost;
    const nextFinal = field === "final" ? parsed : firstFinal;
    this.applySharedPricesToAllVariants(nextCost, nextFinal, {
      preserveSharedInputBuffers: true,
    });
  }

  onPriceInputBlur(variantIndex: number, field: "costo" | "final") {
    const d = this.draft();
    if (!d) return;
    const item = d.listing.items[variantIndex];
    if (!item) return;

    const value = field === "costo" ? item.prices.precio_costo : item.prices.precio_final;
    const key = this.priceBufferKey(variantIndex, field);
    this.priceInputBuffers[key] = this.formatNumberOnly(value);
    this.notifyPriceLossIfNeeded(variantIndex, item);
  }

  onSharedPriceInputBlur(field: "costo" | "final"): void {
    const d = this.draft();
    if (!d || d.listing.items.length === 0) return;
    const first = d.listing.items[0];
    const value = field === "costo" ? first.prices?.precio_costo : first.prices?.precio_final;
    this.sharedPriceInputBuffers[field] = this.formatNumberOnly(value);

    d.listing.items.forEach((item, index) => this.notifyPriceLossIfNeeded(index, item));
  }

  getPriceInputValue(variantIndex: number, field: "costo" | "final"): string {
    const key = this.priceBufferKey(variantIndex, field);
    if (Object.prototype.hasOwnProperty.call(this.priceInputBuffers, key)) {
      return this.priceInputBuffers[key];
    }

    const d = this.draft();
    if (!d) return "";
    const item = d.listing.items[variantIndex];
    if (!item) return "";
    const value = field === "costo" ? item.prices.precio_costo : item.prices.precio_final;
    return this.formatNumberOnly(value);
  }

  getSharedPriceInputValue(field: "costo" | "final"): string {
    return this.sharedPriceInputBuffers[field] || "";
  }

  getSharedClientPriceValue(): string {
    const d = this.draft();
    if (!d || d.listing.items.length === 0) return "";
    const first = d.listing.items[0];
    return this.formatMoney(first.prices?.precio_clienta, first.prices?.currency || "MXN");
  }

  isSharedPriceLossRisk(): boolean {
    const d = this.draft();
    if (!d) return false;
    return d.listing.items.some((item) => this.isPriceLossRisk(item));
  }

  private parsePriceInput(rawValue: string): number | null {
    const cleaned = (rawValue || "").replace(/,/g, "").trim();
    if (!cleaned) return null;
    const parsed = Number(cleaned);
    if (!Number.isFinite(parsed) || parsed < 0) return null;
    return this.roundMoney(parsed);
  }

  private formatNumberOnly(value: number | null | undefined): string {
    if (typeof value !== "number" || !Number.isFinite(value)) return "";
    return this.moneyFormatter.format(value);
  }

  private priceBufferKey(variantIndex: number, field: "costo" | "final"): string {
    return `${variantIndex}:${field}`;
  }

  isPriceLossRisk(item: NormalizedItemV3): boolean {
    const cost = this.toValidNumber(item.prices?.precio_costo);
    const client = this.toValidNumber(item.prices?.precio_clienta);
    return cost !== null && client !== null && client < cost;
  }

  private notifyPriceLossIfNeeded(variantIndex: number, item: NormalizedItemV3): void {
    const key = `variant_${variantIndex}`;
    if (this.isPriceLossRisk(item)) {
      if (!this.priceAlertShownByKey.has(key)) {
        this.priceAlertShownByKey.add(key);
        this.showInfoPopup("Precio clienta no puede ser menor a precio costo. Eso significa perdidas.", "Regla de precios", "warning");
      }
      return;
    }
    this.priceAlertShownByKey.delete(key);
  }

  /**
   * VARIANTES: Asigna un color global a una variante específica
   */
  assignColorToVariant(variantIndex: number) {
    const d = this.draft();
    if (!d) return;

    // Obtener colores disponibles (de product_colors v1.1)
    const availableColors = (d.product_colors || [])
      .map(c => ({ url: c.image_url || "", name: c.name || "Sin nombre" }));

    if (availableColors.length === 0) {
      this.showInfoPopup("Primero debes crear colores en la seccion Colores Globales del Producto.", "Faltan colores", "warning");
      return;
    }

    // Guardar el índice de variante y abrir modal
    this.currentVariantIndex = variantIndex;
    this.currentColorIndex = -1; // Indicar que es para agregar nuevo
    this.showImagePicker.set(true);
  }

  getGlobalColorOptions(): Array<{ name: string; image_url: string | null }> {
    const d = this.draft();
    if (!d) return [];
    return (d.product_colors || [])
      .map((color) => ({
        name: (color.name || "").trim(),
        image_url: color.image_url ?? null,
      }))
      .filter((color) => color.name.length > 0);
  }

  assignGlobalColorToCurrentVariant(colorName: string) {
    const d = this.draft();
    if (!d || this.currentVariantIndex < 0) return;

    const variant = d.listing.items[this.currentVariantIndex];
    const normalizedName = (colorName || "").trim();
    if (!normalizedName) return;

    const exists = variant.color_stock.some((entry) => entry.color_name === normalizedName);
    if (!exists) {
      variant.color_stock.push({
        color_name: normalizedName,
        stock_state: this.normalizeStockState(variant.stock_state) || "in_stock",
      });
    }

    this.draft.set({ ...d });
    this.closeImagePicker();
  }

  // ==========================================================================
  // VARIANTES
  // ==========================================================================

  addVariant() {
    const d = this.draft();
    if (!d) return;

    const newVariant: NormalizedItemV3 = {
      variant_id: `variant_${d.listing.items.length + 1}`,
      variant_name: null,
      sku: null,
      stock_state: "unknown_qty",
      notes: null,
      color_stock: [],
      prices: {
        precio_costo: null,
        precio_clienta: null,
        precio_final: null,
        currency: "MXN",
      },
    };

    newVariant.stock_state = "in_stock";

    d.listing.items.push(newVariant);
    if (this.useSharedPrices()) {
      const sharedCost = this.parsePriceInput(this.sharedPriceInputBuffers.costo);
      const sharedFinal = this.parsePriceInput(this.sharedPriceInputBuffers.final);
      newVariant.prices = {
        ...newVariant.prices,
        precio_costo: sharedCost,
        precio_final: sharedFinal,
        currency: newVariant.prices?.currency || "MXN",
      };
      this.recalculateVariantPrices(newVariant);
    }
    this.syncGlobalColorsToVariantsIfNeeded();
    this.draft.set({ ...d });
  }

  removeVariant(index: number) {
    const d = this.draft();
    if (!d || d.listing.items.length <= 1) {
      this.showInfoPopup("Debe haber al menos una variante.", "Accion bloqueada", "warning");
      return;
    }

    if (confirm("¿Eliminar esta variante?")) {
      d.listing.items.splice(index, 1);
      this.draft.set({ ...d });
    }
  }

  /**
   * Elimina un color (y su imagen) de una variante
   */
  removeColorFromVariant(variantIndex: number, colorIndex: number) {
    const d = this.draft();
    if (!d) return;

    const variant = d.listing.items[variantIndex];

    const current = variant.color_stock[colorIndex];
    if (!current) return;

    if (confirm(`¿Eliminar el color "${current.color_name}"?`)) {
      variant.color_stock.splice(colorIndex, 1);
      this.draft.set({ ...d });
    }
  }

  assignImageToColor(imageUrl: string) {
    const d = this.draft();
    if (!d) return;

    // Caso especial 1: Selección de portada
    if (this.currentVariantIndex === -2) {
      this.setCover(imageUrl);
      this.closeImagePicker();
      console.log("🖼️ Portada actualizada:", imageUrl);
      return;
    }

    // Caso especial 2: Agregar color global con imagen
    if (this.currentVariantIndex === -3) {
      const colorName = (prompt("Nombre del color para esta imagen:") || "").trim();
      if (!colorName) return;

      if (!d.product_colors) d.product_colors = [];
      d.product_colors.push({
        name: colorName,
        image_url: imageUrl
      });
      this.addColorReferencesToSharedItems(d, colorName, imageUrl);
      this.ensureGlobalColorsInAllVariants(d);

      this.draft.set({ ...d });
      this.closeImagePicker();
      console.log("✅ Color global con imagen agregado:", colorName);
      return;
    }

    // Caso normal: Asignar color global a una variante
    if (this.currentVariantIndex >= 0) {
      const variant = d.listing.items[this.currentVariantIndex];

      // Si es agregar nuevo (currentColorIndex === -1)
      if (this.currentColorIndex === -1) {
        // Si una imagen pertenece a varios colores globales, permitir elegir cuál
        const options = (d.product_colors || [])
          .filter(c => (c.image_url || "") === imageUrl)
          .map(c => c.name)
          .filter(Boolean);

        let colorName = "";
        if (options.length === 0) {
          this.showInfoPopup("Solo puedes asignar colores globales existentes.", "Color no disponible", "warning");
          return;
        }
        if (options.length === 1) {
          colorName = options[0];
        } else if (options.length > 1) {
          const menu = options.map((name, i) => `${i + 1}. ${name}`).join("\n");
          const pick = prompt(`Esta imagen tiene varios colores.\nElige uno por número:\n${menu}`, "1");
          const idx = Number(pick);
          colorName = Number.isInteger(idx) && idx >= 1 && idx <= options.length
            ? options[idx - 1]
            : options[0];
        }

        const exists = variant.color_stock.some((entry) => entry.color_name === colorName);
        if (!exists) {
          variant.color_stock.push({
            color_name: colorName,
            stock_state: variant.stock_state || "in_stock",
          });
        }
      } else {
        // Cambiar color existente
        const firstMatch = (d.product_colors || []).find(c => (c.image_url || "") === imageUrl)?.name;
        const replacement = firstMatch || this.imageColors[imageUrl] || "Sin nombre";
        const target = variant.color_stock[this.currentColorIndex];
        if (target) {
          target.color_name = replacement;
        }
      }

      this.draft.set({ ...d });
      this.closeImagePicker();
      console.log("✅ Color asignado a variante");
    }
  }

  closeImagePicker() {
    this.showImagePicker.set(false);
    this.currentVariantIndex = -1;
    this.currentColorIndex = -1;
    this.uploadError.set(null);
  }

  /**
   * Sube una nueva imagen a Firebase Storage
   */
  async uploadNewImage(event: Event) {
    const input = event.target as HTMLInputElement;
    if (!input.files || input.files.length === 0) {
      console.log('❌ No hay archivo seleccionado');
      return;
    }

    const file = input.files[0];
    console.log('📁 Archivo seleccionado:', file.name, 'Tamaño:', file.size, 'bytes');
    
    // Validar tipo
    if (!file.type.startsWith('image/')) {
      this.uploadError.set('⚠️ Solo se permiten imágenes');
      console.error('❌ Tipo inválido:', file.type);
      return;
    }

    // Validar tamaño (máx 5MB)
    if (file.size > 5 * 1024 * 1024) {
      this.uploadError.set('⚠️ La imagen no puede pesar más de 5MB');
      console.error('❌ Archivo muy grande:', (file.size / 1024 / 1024).toFixed(2), 'MB');
      return;
    }

    try {
      this.uploading.set(true);
      this.uploadError.set(null);
      console.log('⏳ Iniciando upload...');

      // Generar nombre único
      const timestamp = Date.now();
      const randomStr = Math.random().toString(36).substring(7);
      const fileName = `${timestamp}_${randomStr}_${file.name}`;
      console.log('📝 Nombre de archivo:', fileName);

      const storageRef = ref(STORAGE, `product-images/${fileName}`);
      console.log('📤 Subiendo a Firebase Storage...');

      // Subir imagen
      const uploadResult = await uploadBytes(storageRef, file);
      console.log('✅ Upload completado:', uploadResult.metadata.fullPath);

      // Obtener URL
      console.log('🔗 Obteniendo URL pública...');
      const downloadURL = await getDownloadURL(storageRef);
      console.log('✅ URL obtenida:', downloadURL);

      // Agregar a rawImages y imageColors
      const currentRaw = this.rawImages();
      this.rawImages.set([...currentRaw, downloadURL]);
      console.log('✅ Agregada a rawImages, total:', this.rawImages().length);
      
      // Solicitar nombre del color
      const colorName = prompt('Nombre del color para esta imagen:') || 'Nuevo color';
      this.imageColors[downloadURL] = colorName;
      console.log('✅ Color asignado:', colorName);

      // Si estamos en modo de agregar color global, seleccionar automáticamente
      if (this.currentVariantIndex === -3) {
        const d = this.draft();
        if (d) {
          if (!d.product_colors) d.product_colors = [];
          d.product_colors.push({
            name: colorName.trim() || "Nuevo color",
            image_url: downloadURL
          });
          this.addColorReferencesToSharedItems(d, colorName, downloadURL);
          this.syncGlobalColorsToVariantsIfNeeded();
          this.draft.set({ ...d });
        }
        this.closeImagePicker();
      }

      this.uploading.set(false);
      this.showInfoPopup(`Imagen subida exitosamente: ${colorName}`, "Carga completada", "success");

      // Limpiar input
      input.value = '';

    } catch (error: any) {
      console.error('❌ ERROR SUBIENDO IMAGEN:', error);
      console.error('Error code:', error.code);
      console.error('Error message:', error.message);
      
      let errorMsg = '❌ Error al subir la imagen';
      
      if (error.code === 'storage/unauthorized') {
        errorMsg = '🔒 Error de permisos. Verifica las reglas de Firebase Storage';
      } else if (error.code === 'storage/canceled') {
        errorMsg = '⚠️ Upload cancelado';
      } else if (error.code === 'storage/unknown') {
        errorMsg = '❌ Error desconocido. Verifica tu conexión a internet';
      } else if (error.message) {
        errorMsg = `❌ ${error.message}`;
      }
      
      this.uploadError.set(errorMsg);
      this.uploading.set(false);
      this.showInfoPopup(errorMsg, "Error", "error");
    }
  }

  // ==========================================================================
  // ACCIONES FINALES
  // ==========================================================================

  async save() {
    try {
      const d = this.draft();
      if (!d) return;
      if (!this.isRequiredSchema(d)) {
        throw new Error(`Esquema no soportado. Se requiere ${this.requiredSchemaVersion}.`);
      }

      const cover = d.cover_images?.[0] ?? d.preview_image_url ?? null;
      d.preview_image_url = cover;
      d.cover_images = cover ? [cover] : [];

      // Validar que tenga al menos una variante
      if (d.listing.items.length === 0) {
        this.showInfoPopup("Agrega al menos una variante antes de guardar.", "Validacion", "warning");
        return;
      }

      d.listing.items.forEach((item) => {
        this.recalculateVariantPrices(item);
      });

      const invalidPrices = d.listing.items.some(
        (item) =>
          typeof item.prices.precio_costo === "number" &&
          typeof item.prices.precio_clienta === "number" &&
          item.prices.precio_clienta < item.prices.precio_costo
      );
      if (invalidPrices) {
        this.showInfoPopup("Regla de precios invalida: precio final x 0.75 no puede ser menor a precio costo.", "Validacion", "warning");
        return;
      }

      // v3: mantener integridad entre product_colors y items.color_stock
      this.normalizeColorReferencesForSave(d);
      // SKU por variante/talla (solo si está vacío)
      this.ensureVariantSkus(d);

      await this.svc.updateListing(this.id, {
        listing: d.listing,
        supplier_id: d.supplier_id ?? null,
        preview_image_url: d.preview_image_url,
        cover_images: d.cover_images,
        product_colors: d.product_colors,
      });

      // Actualizar review con excluded_image_urls
      await this.svc.updateReview(this.id, {
        excluded_image_urls: this.excludedImages(),
      });

      await this.load();
      this.showInfoPopup("Guardado correctamente.", "Exito", "success");
    } catch (e: any) {
      this.showInfoPopup("No se pudo guardar: " + (e?.message || String(e)), "Error al guardar", "error");
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
        this.showInfoPopup("Selecciona un proveedor.", "Validacion", "warning");
        return;
      }

      if (!d.listing.title) {
        this.showInfoPopup("Agrega un titulo.", "Validacion", "warning");
        return;
      }

      if (!d.listing.category_hint) {
        this.showInfoPopup("Selecciona una categoria.", "Validacion", "warning");
        return;
      }

      if (d.listing.items.length === 0) {
        this.showInfoPopup("Agrega al menos una variante.", "Validacion", "warning");
        return;
      }

      // Validar que cada variante tenga precio de costo y respete margen mínimo
      const invalidVariants = d.listing.items.filter(
        (item) =>
          !item.prices ||
          typeof item.prices.precio_costo !== "number" ||
          item.prices.precio_costo <= 0 ||
          typeof item.prices.precio_clienta !== "number" ||
          item.prices.precio_clienta < item.prices.precio_costo
      );

      if (invalidVariants.length > 0) {
        this.showInfoPopup("Todas las variantes deben tener precio costo valido y precio clienta mayor o igual al costo.", "Validacion", "warning");
        return;
      }

      // Guardar antes de validar
      await this.save();

      // Validar
      await this.svc.validate(this.id, uid);
      await this.router.navigateByUrl("/main/validacion");
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
      await this.router.navigateByUrl("/main/validacion");
    } catch (e: any) {
      this.error.set(e?.message || String(e));
    }
  }

  goInbox() {
    this.router.navigateByUrl("/main/validacion");
  }

  private async ensureCategoryPathExists(fullPathInput: string): Promise<string> {
    const segments = String(fullPathInput || "")
      .split(">")
      .map((segment) => segment.trim())
      .filter(Boolean);

    if (segments.length === 0) {
      throw new Error("La propuesta de categoria no es valida.");
    }

    await this.categoriesService.loadCategories();

    let parentId: string | null = null;
    let currentPath = "";

    for (const segment of segments) {
      currentPath = currentPath ? `${currentPath} > ${segment}` : segment;

      let existing = this.categoriesService.getByPath(currentPath);
      if (!existing) {
        await this.categoriesService.addCategory(segment, parentId);
        existing = this.categoriesService.getByPath(currentPath);
      }

      if (!existing) {
        throw new Error(`No se pudo crear/obtener la categoria: ${currentPath}`);
      }

      parentId = existing.id;
    }

    return currentPath;
  }
  
  // ============================================================================
  // MÉTODOS DE UTILIDAD V3
  // ============================================================================

  getColorImage(colorName: string): string | null {
    const d = this.draft();
    if (!d) return null;
    
    const color = d.product_colors?.find(c => c.name === colorName);
    return color?.image_url || null;
  }
  
  private normalizeStockState(value: unknown): StockState | null {
    if (typeof value !== "string") return null;
    const valid: StockState[] = ["in_stock", "last_pair", "out_of_stock", "unknown_qty"];
    return valid.includes(value as StockState) ? (value as StockState) : null;
  }

  private openPopup(config: ReviewPopupState): Promise<boolean> {
    return new Promise((resolve) => {
      this.popupResolver = resolve;
      this.popupState.set(config);
    });
  }

  closePopupFromBackdrop() {
    const popup = this.popupState();
    if (!popup?.dismissible) return;
    this.resolvePopup(true);
  }

  confirmPopup() {
    this.resolvePopup(true);
  }

  private resolvePopup(value: boolean) {
    const resolver = this.popupResolver;
    this.popupResolver = null;
    this.popupState.set(null);
    resolver?.(value);
  }

  private showInfoPopup(message: string, title = "Aviso", kind: ReviewPopupKind = "info") {
    void this.openPopup({
      kind,
      title,
      message,
      confirmText: "Aceptar",
      dismissible: true,
    });
  }


  formatMoney(value: number | null | undefined, currency = "MXN"): string {
    if (typeof value !== "number" || !Number.isFinite(value)) return "--";
    return `${currency} ${this.moneyFormatter.format(value)}`;
  }
}

