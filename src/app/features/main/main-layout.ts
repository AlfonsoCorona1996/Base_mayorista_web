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
    if (typeof window === "undefined") {
      return { operacion: false, catalogo: false, clientes: false, seguridad: false };
    }

    try {
      const raw = window.localStorage.getItem("panel.menu.groups");
      if (!raw) return { operacion: false, catalogo: false, clientes: false, seguridad: false };
      const parsed = JSON.parse(raw) as Record<string, boolean>;
      return {
        operacion: Boolean(parsed["operacion"]),
        catalogo: Boolean(parsed["catalogo"]),
        clientes: Boolean(parsed["clientes"]),
        seguridad: Boolean(parsed["seguridad"]),
      };
    } catch {
      return { operacion: false, catalogo: false, clientes: false, seguridad: false };
    }
  }

  private persistGroupState() {
    if (typeof window === "undefined") return;
    window.localStorage.setItem("panel.menu.groups", JSON.stringify(this.openGroups()));
  }
}

