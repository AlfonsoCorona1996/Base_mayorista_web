// review.ts - Versión mejorada con UX completa
import { Component, computed, inject, signal } from "@angular/core";
import { ActivatedRoute, Router } from "@angular/router";
import { FormsModule } from "@angular/forms";
import { NormalizedListingsService } from "../../core/normalized-listings.service";
import { AuthService } from "../../core/auth.service";
import { CategoriesService, Category } from "../../core/categories.service";
import { SuppliersService, Supplier } from "../../core/suppliers.service";
import { doc, getDoc } from "firebase/firestore";
import { ref, uploadBytes, getDownloadURL } from "firebase/storage";
import { FIRESTORE, STORAGE } from "../../core/firebase.providers";
import type { NormalizedListingDoc, RawPost, NormalizedItem, ItemPrice, PriceTierGlobal, ProductColor } from "../../core/firestore-contracts";

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
  currentColorIndex = -1; // Índice del color que estamos editando
  
  // Upload de imágenes
  uploading = signal(false);
  uploadError = signal<string | null>(null);

  // ¿Las variantes tienen colores diferentes? (DEFAULT: false)
  hasVariantColors = signal(false);

  visibleRawImages = computed(() => {
    const ex = new Set(this.excludedImages());
    return (this.rawImages() || []).filter(u => !!u && !ex.has(u));
  });

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
  
  // ✅ Schema v1.1: Colores globales del producto
  globalColors = computed(() => {
    const d = this.draft();
    if (!d) return [];
    
    // v1.1: Usar product_colors si existe
    if (d.product_colors && d.product_colors.length > 0) {
      return d.product_colors;
    }
    
    // v1: Construir desde imageColors (estado actual del componente)
    const colors: ProductColor[] = [];
    
    for (const [url, name] of Object.entries(this.imageColors)) {
      if (name && name.trim() !== '') {
        colors.push({ name, image_url: url });
      }
    }
    
    return colors;
  });

  async ngOnInit() {
    // Asegurar que las categorías estén cargadas
    await this.categoriesService.loadCategories();
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

      // Migrar datos antiguos al nuevo formato si es necesario
      this.migrateToNewFormat();
      
      // ✅ Normalizar a v1.1 en memoria PRIMERO (compatible con v1)
      this.normalizeToV1_1(clone);

      // Inicializar colores desde variantes existentes (ahora con product_colors si es v1.1)
      this.initializeImageColors();
      
      // ✅ Agregar imágenes de product_colors a rawImages si no están ya
      this.syncProductColorsToRawImages();

      // Auto-detectar si hay colores y activar checkbox
      // NO detectar colores automáticamente - usuario decide si marca el checkbox
      // this.detectAndActivateColors();

      // Inicializar búsqueda de categoría con la actual
      if (clone.listing.category_hint) {
        this.categorySearch = clone.listing.category_hint;
      }

      // Normalizar descuentos globales y sincronizar con precios
      this.normalizeGlobalDiscounts();
      this.syncGlobalDiscountsToVariants();

    } catch (e: any) {
      this.error.set(e?.message || String(e));
    } finally {
      this.loading.set(false);
    }
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

    // FALLBACK: Schema v1 - Extraer colores de variantes existentes
    console.log('⚠️ product_colors no encontrado, usando fallback v1');
    d.listing.items.forEach(item => {
      // Manejar formato nuevo (arrays)
      if (item.colors && item.image_urls) {
        item.colors.forEach((color, index) => {
          const url = item.image_urls![index];
          if (url && color) {
            this.imageColors[url] = color;
          }
        });
      }
      
      // LEGACY: Manejar formato antiguo (strings)
      if (item.image_url && item.color) {
        this.imageColors[item.image_url] = item.color;
      }
    });
    console.log('✅ Colores inicializados (v1):', Object.keys(this.imageColors).length);
  }

  /**
   * Migra datos antiguos (color, image_url) al formato nuevo (colors[], image_urls[])
   */
  private migrateToNewFormat() {
    const d = this.draft();
    if (!d) return;

    let migrated = false;

    d.listing.items.forEach(item => {
      // Si tiene formato antiguo pero no el nuevo, migrar
      if ((item.color || item.image_url) && (!item.colors || !item.image_urls)) {
        item.colors = item.color ? [item.color] : [];
        item.image_urls = item.image_url ? [item.image_url] : [];
        migrated = true;
      }

      // Asegurar que siempre haya arrays (aunque vacíos)
      if (!item.colors) item.colors = [];
      if (!item.image_urls) item.image_urls = [];
    });

    if (migrated) {
      console.log("✅ Datos migrados al nuevo formato (colors[], image_urls[])");
      this.draft.set({ ...d });
    }
  }

  /**
   * Detecta si hay colores en las variantes y activa el checkbox automáticamente
   */
  /**
   * Normaliza datos v1 a v1.1 en memoria (sin guardar)
   * Esto permite compatibilidad hacia atrás con datos antiguos
   */
  private normalizeToV1_1(doc: NormalizedListingDoc): void {
    // Si ya es v1.1 y tiene product_colors, no hacer nada
    if (doc.schema_version === "normalized_v1.1" && doc.product_colors) {
      console.log("✅ Documento ya es v1.1, no requiere normalización");
      return;
    }

    console.log("🔄 Normalizando datos v1 → v1.1 en memoria...");
    console.log("📊 Datos actuales del documento:");
    console.log("  - Schema:", doc.schema_version);
    console.log("  - preview_image_url:", doc.preview_image_url);
    console.log("  - Items:", doc.listing.items.length);
    
    // Debug: ver qué tiene el primer item
    const firstItem = doc.listing.items[0];
    if (firstItem) {
      console.log("  - Primer item tiene colors:", firstItem.colors);
      console.log("  - Primer item tiene image_urls:", firstItem.image_urls);
      console.log("  - Primer item tiene color_names:", firstItem.color_names);
    }

    // 1. Construir cover_images desde preview_image_url
    if (!doc.cover_images || doc.cover_images.length === 0) {
      if (doc.preview_image_url) {
        doc.cover_images = [doc.preview_image_url];
        console.log("  ✓ cover_images creado desde preview_image_url");
      } else {
        doc.cover_images = [];
        console.log("  ⚠️ No hay preview_image_url, cover_images vacío");
      }
    }

    // 2. Construir product_colors desde imageColors actuales o desde items
    if (!doc.product_colors || doc.product_colors.length === 0) {
      const colorMap = new Map<string, string | null>();

      // Intentar desde imageColors del componente (probablemente vacío aún)
      for (const [url, name] of Object.entries(this.imageColors)) {
        if (name && name.trim() !== '') {
          colorMap.set(name, url);
        }
      }
      console.log(`  - Colores desde imageColors: ${colorMap.size}`);

      // Si no hay colores en imageColors, extraer del primer item (v1)
      if (colorMap.size === 0) {
        console.log("  - Intentando extraer colores del primer item...");
        if (firstItem?.colors && firstItem?.image_urls) {
          console.log(`  - Primer item tiene ${firstItem.colors.length} colores`);
          firstItem.colors.forEach((color, i) => {
            if (color && color.trim() !== '') {
              const url = firstItem.image_urls![i] || null;
              colorMap.set(color, url);
              console.log(`    ✓ ${color} → ${url?.substring(0, 50) || 'null'}`);
            }
          });
        } else {
          console.log("  ❌ Primer item NO tiene colors o image_urls");
        }
      }

      doc.product_colors = Array.from(colorMap.entries()).map(([name, url]) => ({
        name,
        image_url: url
      }));
      
      console.log(`  ✓ product_colors creado con ${doc.product_colors.length} colores`);
    }

    // 3. Construir color_names para cada item
    doc.listing.items.forEach(item => {
      if (!item.color_names || item.color_names.length === 0) {
        if (item.colors && item.colors.length > 0) {
          item.color_names = [...item.colors];
        } else {
          item.color_names = [];
        }
      }
    });

    console.log("✅ Normalización completada:", {
      cover_images: doc.cover_images.length,
      product_colors: doc.product_colors.length,
      items_with_color_names: doc.listing.items.filter(i => i.color_names && i.color_names.length > 0).length
    });
  }

  private detectAndActivateColors() {
    const d = this.draft();
    if (!d) return;

    // Verificar si alguna variante tiene colores
    const hasColors = d.listing.items.some(item => 
      (item.color_names && item.color_names.length > 0) ||
      (item.colors && item.colors.length > 0 && item.colors.some(c => c && c.trim() !== ''))
    );

    if (hasColors) {
      console.log("✅ Colores detectados - activando checkbox automáticamente");
      this.hasVariantColors.set(true);
    }
  }

  /**
   * Toggle checkbox de colores e inicializa arrays si es necesario
   */
  toggleVariantColors(checked: boolean) {
    this.hasVariantColors.set(checked);

    if (checked) {
      const d = this.draft();
      if (!d) return;

      const cover = d.cover_images?.[0] ?? d.preview_image_url ?? null;
      d.preview_image_url = cover;
      d.cover_images = cover ? [cover] : [];

      // Inicializar colores vacíos si no existen
      d.listing.items.forEach(item => {
        if (!item.colors || item.colors.length === 0) {
          item.colors = [""];
          item.image_urls = [""];
        }
      });

      this.draft.set({ ...d });
      console.log("✅ Checkbox activado - arrays de colores inicializados");
    }
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

    // 🔄 Eliminar esta imagen de todas las variantes que la usan
    d.listing.items.forEach(item => {
      if (item.image_urls && item.colors) {
        // Encontrar todos los índices donde está esta imagen
        const indicesToRemove: number[] = [];
        item.image_urls.forEach((imgUrl, index) => {
          if (imgUrl === url) {
            indicesToRemove.push(index);
          }
        });

        // Eliminar en orden inverso para no afectar los índices
        indicesToRemove.reverse().forEach(index => {
          item.image_urls!.splice(index, 1);
          item.colors!.splice(index, 1);
        });
      }
    });

    this.draft.set({ ...d });
    console.log("🗑️ Imagen eliminada de galería y variantes:", url);
  }

  /**
   * Se llama cuando el usuario edita un color en la galería de imágenes
   * Sincroniza los cambios con las variantes que usan esa imagen
   */
  onColorChanged() {
    console.log("✅ Colores actualizados en galería:", this.imageColors);
    
    const d = this.draft();
    if (!d) return;

    // Actualizar colores en todas las variantes que usan las imágenes modificadas
    d.listing.items.forEach(item => {
      if (item.image_urls && item.colors) {
        item.image_urls.forEach((url, index) => {
          if (url && this.imageColors[url]) {
            // Actualizar el nombre del color si la imagen tiene uno en la galería
            item.colors![index] = this.imageColors[url];
          }
        });
      }
    });

    this.draft.set({ ...d });
    console.log("🔄 Colores sincronizados en variantes");
  }

  /**
   * Imágenes de colores (independientes de la portada)
   */
  visibleColorImages = computed(() => {
    return this.visibleRawImages();
  });

  /**
   * Abre modal para seleccionar/cambiar la imagen de portada
   */
  openCoverSelector() {
    this.currentVariantIndex = -2; // Valor especial para indicar "selección de portada"
    this.currentColorIndex = -1;
    this.showImagePicker.set(true);
  }

  /**
   * Elimina una imagen de color (NO la portada)
   */
  removeColorImage(url: string) {
    if (!url) return;
    if (url === this.coverUrl()) {
      alert("No puedes eliminar la imagen de portada desde aquí. Usa el botón 'Cambiar Portada'.");
      return;
    }

    if (confirm("¿Eliminar esta imagen de color?\n\nSe eliminará también de todas las variantes que la usen.")) {
      this.removeImage(url); // Usa el método existente
    }
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

  private removeColorReferencesFromItems(d: NormalizedListingDoc, colorName: string) {
    const target = (colorName || "").trim();
    if (!target) return;

    d.listing.items.forEach(item => {
      // v1.1 canonical references
      if (item.color_names) {
        item.color_names = item.color_names.filter(name => (name || "").trim() !== target);
      }

      // v1 arrays used by el frontend actual
      if (item.colors) {
        if (item.image_urls) {
          const nextColors: string[] = [];
          const nextImages: string[] = [];

          item.colors.forEach((name, index) => {
            if ((name || "").trim() !== target) {
              nextColors.push(name);
              nextImages.push(item.image_urls![index] || "");
            }
          });

          item.colors = nextColors;
          item.image_urls = nextImages;
        } else {
          item.colors = item.colors.filter(name => (name || "").trim() !== target);
        }
      }

      // legacy scalar
      if (item.color && item.color.trim() === target) {
        item.color = null;
      }
    });
  }

  private addColorReferencesToSharedItems(d: NormalizedListingDoc, colorName: string, imageUrl: string | null) {
    const name = (colorName || "").trim();
    if (!name) return;

    // Si el usuario trabaja por variante, no forzar propagación global.
    if (this.hasVariantColors()) return;

    // Solo propagar automáticamente cuando todas las variantes comparten el mismo set actual.
    const sets = d.listing.items.map(item => {
      const names = Array.from(new Set([
        ...(item.colors || []).map(x => (x || "").trim()).filter(Boolean),
        ...(item.color_names || []).map(x => (x || "").trim()).filter(Boolean),
      ])).sort();
      return names.join("|");
    });
    if (sets.length > 1 && new Set(sets).size > 1) return;

    d.listing.items.forEach(item => {
      if (!item.colors) item.colors = [];
      if (!item.color_names) item.color_names = [];
      if (!item.image_urls) item.image_urls = [];

      const existsInColors = item.colors.some(x => (x || "").trim() === name);
      if (!existsInColors) {
        item.colors.push(name);
        item.image_urls.push(imageUrl || "");
      }

      const existsInColorNames = item.color_names.some(x => (x || "").trim() === name);
      if (!existsInColorNames) {
        item.color_names.push(name);
      }
    });
  }

  private normalizeColorReferencesForSave(d: NormalizedListingDoc) {
    const normalizedColors = (d.product_colors || [])
      .map(c => ({
        name: (c.name || "").trim(),
        image_url: c.image_url ?? null
      }))
      .filter(c => c.name !== "");

    d.product_colors = normalizedColors;
    const validNames = new Set(normalizedColors.map(c => c.name));

    d.listing.items.forEach(item => {
      const sourceNames = [
        ...(item.colors || []),
        ...(item.color_names || []),
      ];

      const sourceImages = Array.isArray(item.image_urls) ? item.image_urls : [];
      const nextColors: string[] = [];
      const nextImages: string[] = [];
      const seen = new Set<string>();

      sourceNames.forEach((rawName, index) => {
        const name = (rawName || "").trim();
        if (!name || !validNames.has(name)) return;
        if (seen.has(name)) return;
        seen.add(name);
        nextColors.push(name);
        if (sourceImages.length > 0) {
          nextImages.push(sourceImages[index] || "");
        }
      });

      item.colors = nextColors;
      item.color_names = Array.from(new Set(nextColors));

      if (Array.isArray(item.image_urls)) {
        item.image_urls = sourceImages.length > 0 ? nextImages : [];
      }

      if (item.color && !validNames.has(item.color)) {
        item.color = null;
      }
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

  private ensureVariantSkus(d: NormalizedListingDoc) {
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
      alert("⚠️ Primero debes crear colores en la sección 'Colores Globales del Producto' más arriba.");
      return;
    }

    // Guardar el índice de variante y abrir modal
    this.currentVariantIndex = variantIndex;
    this.currentColorIndex = -1; // Indicar que es para agregar nuevo
    this.showImagePicker.set(true);
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
      colors: [],       // NUEVO: array vacío
      image_urls: [],   // NUEVO: array vacío
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

  /**
   * Agrega un nuevo color (con su imagen) a una variante - Abre modal para seleccionar
   */
  addColorToVariant(variantIndex: number) {
    const d = this.draft();
    if (!d) return;

    const variant = d.listing.items[variantIndex];
    
    // Asegurar que existan los arrays
    if (!variant.colors) variant.colors = [];
    if (!variant.image_urls) variant.image_urls = [];

    // Agregar slot vacío temporalmente
    const newIndex = variant.colors.length;
    variant.colors.push("");
    variant.image_urls.push("");
    this.draft.set({ ...d });

    // Abrir modal para seleccionar imagen
    this.pickImageForColor(variantIndex, newIndex);
  }

  /**
   * Elimina un color (y su imagen) de una variante
   */
  removeColorFromVariant(variantIndex: number, colorIndex: number) {
    const d = this.draft();
    if (!d) return;

    const variant = d.listing.items[variantIndex];
    
    if (!variant.colors || !variant.image_urls) return;
    if (variant.colors.length <= 1) {
      alert("Debe haber al menos un color");
      return;
    }

    if (confirm(`¿Eliminar el color "${variant.colors[colorIndex]}"?`)) {
      variant.colors.splice(colorIndex, 1);
      variant.image_urls.splice(colorIndex, 1);
      this.draft.set({ ...d });
    }
  }

  /**
   * Mueve un color hacia arriba en la lista
   */
  moveColorUp(variantIndex: number, colorIndex: number) {
    if (colorIndex === 0) return; // Ya está al inicio

    const d = this.draft();
    if (!d) return;

    const variant = d.listing.items[variantIndex];
    if (!variant.colors || !variant.image_urls) return;

    // Intercambiar color
    [variant.colors[colorIndex], variant.colors[colorIndex - 1]] = 
    [variant.colors[colorIndex - 1], variant.colors[colorIndex]];

    // Intercambiar imagen
    [variant.image_urls[colorIndex], variant.image_urls[colorIndex - 1]] = 
    [variant.image_urls[colorIndex - 1], variant.image_urls[colorIndex]];

    this.draft.set({ ...d });
  }

  /**
   * Mueve un color hacia abajo en la lista
   */
  moveColorDown(variantIndex: number, colorIndex: number) {
    const d = this.draft();
    if (!d) return;

    const variant = d.listing.items[variantIndex];
    if (!variant.colors || !variant.image_urls) return;
    if (colorIndex === variant.colors.length - 1) return; // Ya está al final

    // Intercambiar color
    [variant.colors[colorIndex], variant.colors[colorIndex + 1]] = 
    [variant.colors[colorIndex + 1], variant.colors[colorIndex]];

    // Intercambiar imagen
    [variant.image_urls[colorIndex], variant.image_urls[colorIndex + 1]] = 
    [variant.image_urls[colorIndex + 1], variant.image_urls[colorIndex]];

    this.draft.set({ ...d });
  }

  /**
   * Selecciona una imagen de la galería para un color específico
   */
  pickImageForColor(variantIndex: number, colorIndex: number) {
    this.currentVariantIndex = variantIndex;
    this.currentColorIndex = colorIndex;
    this.showImagePicker.set(true);
  }

  /**
   * Asigna una imagen a un color específico
   */
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

      this.draft.set({ ...d });
      this.closeImagePicker();
      console.log("✅ Color global con imagen agregado:", colorName);
      return;
    }

    // Caso normal: Asignar color global a una variante
    if (this.currentVariantIndex >= 0) {
      const variant = d.listing.items[this.currentVariantIndex];
      
      // Asegurar arrays
      if (!variant.colors) variant.colors = [];
      if (!variant.image_urls) variant.image_urls = [];

      // Si es agregar nuevo (currentColorIndex === -1)
      if (this.currentColorIndex === -1) {
        // Si una imagen pertenece a varios colores globales, permitir elegir cuál
        const options = (d.product_colors || [])
          .filter(c => (c.image_url || "") === imageUrl)
          .map(c => c.name)
          .filter(Boolean);

        let colorName = "Sin nombre";
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

        variant.colors.push(colorName);
        variant.image_urls.push(imageUrl);
      } else {
        // Cambiar color existente
        const firstMatch = (d.product_colors || []).find(c => (c.image_url || "") === imageUrl)?.name;
        variant.colors[this.currentColorIndex] = firstMatch || this.imageColors[imageUrl] || "Sin nombre";
        variant.image_urls[this.currentColorIndex] = imageUrl;
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
          this.draft.set({ ...d });
        }
        this.closeImagePicker();
      }

      this.uploading.set(false);
      alert(`✅ Imagen subida exitosamente: ${colorName}`);

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
      alert(errorMsg);
    }
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
  // SINCRONIZACIÓN DE DESCUENTOS GLOBALES → PRECIOS
  // ==========================================================================

  /**
   * Calcula el precio con descuento aplicado
   */
  calculateDiscountedPrice(basePrice: number, discountPercent: number): number {
    if (!basePrice || !discountPercent) return basePrice;
    return Math.round(basePrice * (1 - discountPercent / 100) * 100) / 100;
  }

  /**
   * Sincroniza los descuentos globales con los precios de todas las variantes
   * Crea/actualiza precios automáticamente basados en price_tiers_global
   */
  syncGlobalDiscountsToVariants() {
    const d = this.draft();
    if (!d) return;

    // Para cada variante
    d.listing.items.forEach(variant => {
      // Obtener precio público (base)
      const publicoPrice = variant.prices.find(p => p.tier_name === "publico");
      if (!publicoPrice?.amount) return;

      // Para cada tier global
      d.listing.price_tiers_global.forEach(tier => {
        // Saltar "publico" (es el precio base)
        if (tier.tier_name === "publico") return;

        // Buscar si ya existe este tier en los precios de la variante
        let existingPrice = variant.prices.find(p => p.tier_name === tier.tier_name);

        if (tier.discount_percent !== null && tier.discount_percent !== undefined) {
          // Calcular nuevo precio
          const newAmount = this.calculateDiscountedPrice(publicoPrice.amount!, tier.discount_percent);

          if (existingPrice) {
            // Actualizar precio existente
            existingPrice.amount = newAmount;
          } else {
            // Crear nuevo precio
            variant.prices.push({
              amount: newAmount,
              currency: "MXN",
              tier_name: tier.tier_name
            });
          }
        } else {
          // Si no hay descuento, eliminar el precio si existe
          if (existingPrice) {
            const index = variant.prices.indexOf(existingPrice);
            variant.prices.splice(index, 1);
          }
        }
      });
    });

    this.draft.set({ ...d });
  }

  /**
   * Normaliza los descuentos globales (asegura que "publico" sea 0%)
   */
  normalizeGlobalDiscounts() {
    const d = this.draft();
    if (!d) return;

    // Asegurar que "publico" tenga 0% de descuento
    const publicoTier = d.listing.price_tiers_global.find(t => t.tier_name === "publico");
    if (publicoTier) {
      publicoTier.discount_percent = 0;
    }

    this.draft.set({ ...d });
  }

  // ==========================================================================
  // ACCIONES FINALES
  // ==========================================================================

  async save() {
    try {
      const d = this.draft();
      if (!d) return;

      const cover = d.cover_images?.[0] ?? d.preview_image_url ?? null;
      d.preview_image_url = cover;
      d.cover_images = cover ? [cover] : [];

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

      // v1.1: mantener integridad entre product_colors y items.color_names/colors
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
  
  // ============================================================================
  // MÉTODOS DE UTILIDAD PARA SCHEMA v1.1
  // ============================================================================
  
  /**
   * Obtiene los nombres de colores de una variante (v1.1 compatible)
   */
  getItemColorNames(item: NormalizedItem): string[] {
    // Priorizar color_names (v1.1)
    if (item.color_names && item.color_names.length > 0) {
      return item.color_names;
    }
    
    // Fallback a colors (v1)
    return item.colors || [];
  }
  
  /**
   * Obtiene la imagen de un color específico desde product_colors
   */
  getColorImage(colorName: string): string | null {
    const d = this.draft();
    if (!d) return null;
    
    const color = d.product_colors?.find(c => c.name === colorName);
    return color?.image_url || null;
  }
  
  /**
   * Actualiza un color global (se refleja en todos los items que lo usen)
   */
  updateGlobalColorName(oldName: string, newName: string) {
    const d = this.draft();
    if (!d) return;
    
    // Actualizar en product_colors
    const color = d.product_colors?.find(c => c.name === oldName);
    if (color) {
      color.name = newName;
    }
    
    // Actualizar referencias en todos los items
    d.listing.items.forEach(item => {
      if (item.color_names) {
        const index = item.color_names.indexOf(oldName);
        if (index !== -1) {
          item.color_names[index] = newName;
        }
      }
    });
    
    this.draft.set({ ...d });
  }
  
  /**
   * Agrega un nuevo color global
   */
  addGlobalColorWithDetails(name: string, imageUrl: string | null) {
    const d = this.draft();
    if (!d) return;
    
    if (!d.product_colors) {
      d.product_colors = [];
    }
    
    d.product_colors.push({
      name: name,
      image_url: imageUrl
    });
    
    this.draft.set({ ...d });
  }
  
  /**
   * Elimina un color global y todas sus referencias
   */
  removeGlobalColorByName(colorName: string) {
    const d = this.draft();
    if (!d) return;
    
    // Remover de product_colors
    if (d.product_colors) {
      d.product_colors = d.product_colors.filter(c => c.name !== colorName);
    }
    
    // Remover referencias en items
    this.removeColorReferencesFromItems(d, colorName);
    
    this.draft.set({ ...d });
  }
}
