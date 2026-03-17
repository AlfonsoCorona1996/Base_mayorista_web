import { ChangeDetectionStrategy, Component, computed, inject, signal } from "@angular/core";
import { PublicCatalogService, PublicLandingCatalog } from "./public-catalog.service";

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  standalone: true,
  selector: "app-public-home",
  templateUrl: "./public-home.html",
  styleUrl: "./public-home.css",
})
export default class PublicHomePage {
  private readonly publicCatalog = inject(PublicCatalogService);

  readonly whatsappDisplayNumber = "+52 33 1859 7241";
  readonly whatsappHref = `https://wa.me/523318597241?text=${encodeURIComponent(
    "Hola, quiero informes y catálogo de Base Mayorista.",
  )}`;

  menuOpen = signal(false);
  loading = signal(true);
  error = signal<string | null>(null);
  catalog = signal<PublicLandingCatalog>({
    featuredProducts: [],
    sections: [],
    heroImages: [],
  });

  sections = computed(() => this.catalog().sections);
  featuredProducts = computed(() => this.catalog().featuredProducts);
  hasProducts = computed(() => this.featuredProducts().length > 0);
  heroImageSlots = computed(() => {
    const unique = Array.from(new Set(this.catalog().heroImages.filter((image) => image.trim().length > 0)));
    if (unique.length >= 3) return unique.slice(0, 3);
    if (unique.length === 2) return [unique[0], unique[1], "/BaseMayoristaLogo.png"];
    if (unique.length === 1) return [unique[0], "/BaseMayoristaLogo.png", "/BM _BN.png"];
    return [];
  });

  constructor() {
    void this.loadCatalog();
  }

  toggleMenu() {
    this.menuOpen.update((value) => !value);
  }

  closeMenu() {
    this.menuOpen.set(false);
  }

  async reloadCatalog() {
    await this.loadCatalog();
  }

  private async loadCatalog() {
    this.loading.set(true);
    this.error.set(null);

    try {
      const data = await this.publicCatalog.loadLandingCatalog(36);
      this.catalog.set(data);
    } catch (error) {
      this.error.set(this.mapErrorMessage(error));
      this.catalog.set({
        featuredProducts: [],
        sections: [],
        heroImages: [],
      });
    } finally {
      this.loading.set(false);
    }
  }

  private mapErrorMessage(error: unknown): string {
    const code = this.errorCode(error);
    if (code.includes("permission-denied")) {
      return "El catálogo público aún no tiene permisos de lectura en Firebase. Puedes pedir informes por WhatsApp.";
    }
    if (code.includes("unavailable")) {
      return "El catálogo está temporalmente no disponible. Intenta nuevamente en unos minutos.";
    }
    return "No pudimos cargar los productos en este momento.";
  }

  private errorCode(error: unknown): string {
    if (!error || typeof error !== "object" || !("code" in error)) return "";
    const value = (error as { code?: unknown }).code;
    return typeof value === "string" ? value.toLowerCase() : "";
  }
}
