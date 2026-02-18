import { Component, HostListener, inject, signal } from "@angular/core";
import { NavigationEnd, Router, RouterLink, RouterLinkActive, RouterOutlet } from "@angular/router";
import { filter } from "rxjs";
import { AuthService } from "../../core/auth.service";
import { AccessService, AppPermission } from "../../core/access.service";
import { AuditService } from "../../core/audit.service";

@Component({
  standalone: true,
  selector: "app-main-layout",
  imports: [RouterOutlet, RouterLink, RouterLinkActive],
  templateUrl: "./main-layout.html",
  styleUrl: "./main-layout.css",
})
export default class MainLayoutPage {
  menuOpen = signal(false);
  openGroups = signal<Record<string, boolean>>(this.loadGroupState());

  private auth = inject(AuthService);
  private router = inject(Router);
  access = inject(AccessService);
  private audit = inject(AuditService);

  ngOnInit() {
    this.syncMenuForViewport();
    this.access.refreshProfile().catch(() => null);
    this.router.events.pipe(filter((event) => event instanceof NavigationEnd)).subscribe((event) => {
      const nav = event as NavigationEnd;
      this.audit.log("VIEW_ROUTE", { url: nav.urlAfterRedirects }).catch(() => null);
    });
  }

  @HostListener("window:resize")
  onResize() {
    this.syncMenuForViewport();
  }

  toggleMenu() {
    this.menuOpen.set(!this.menuOpen());
  }

  toggleGroup(groupId: string) {
    this.openGroups.update((current) => ({
      ...current,
      [groupId]: !current[groupId],
    }));
    this.persistGroupState();
  }

  isGroupOpen(groupId: string): boolean {
    return Boolean(this.openGroups()[groupId]);
  }

  closeMenu() {
    if (!this.isDesktopViewport()) {
      this.menuOpen.set(false);
    }
  }

  async logout() {
    await this.auth.logout();
    this.menuOpen.set(false);
    await this.router.navigateByUrl("/login");
  }

  can(permission: AppPermission): boolean {
    return this.access.can(permission);
  }

  userInitials(): string {
    const raw = this.access.displayName().trim();
    if (!raw) return "US";
    const parts = raw.split(/\s+/).filter(Boolean).slice(0, 2);
    return parts.map((part) => part[0]?.toUpperCase() ?? "").join("") || "US";
  }

  roleLabel(): string {
    const role = this.access.profile()?.role;
    if (!role) return "Sin rol";
    if (role === "super_admin") return "Super admin";
    if (role === "administrativo") return "Administrativo";
    if (role === "repartidor") return "Repartidor";
    return "Administrador";
  }

  private syncMenuForViewport() {
    if (this.isDesktopViewport() && !this.menuOpen()) {
      this.menuOpen.set(true);
      return;
    }
    if (!this.isDesktopViewport() && this.menuOpen()) {
      this.menuOpen.set(false);
    }
  }

  private isDesktopViewport(): boolean {
    if (typeof window === "undefined") return true;
    return window.matchMedia("(min-width: 960px)").matches;
  }

  private loadGroupState(): Record<string, boolean> {
    const fallback = { operaciones: true, logistica: true, catalogo: true, configuracion: true };
    if (typeof window === "undefined") {
      return fallback;
    }

    try {
      const raw = window.localStorage.getItem("panel.menu.groups");
      if (!raw) return fallback;
      const parsed = JSON.parse(raw) as Record<string, boolean>;
      return {
        operaciones: Boolean(parsed["operaciones"] ?? parsed["operacion"]),
        logistica: Boolean(parsed["logistica"] ?? parsed["clientes"]),
        catalogo: Boolean(parsed["catalogo"]),
        configuracion: Boolean(parsed["configuracion"] ?? parsed["seguridad"]),
      };
    } catch {
      return fallback;
    }
  }

  private persistGroupState() {
    if (typeof window === "undefined") return;
    window.localStorage.setItem("panel.menu.groups", JSON.stringify(this.openGroups()));
  }
}

