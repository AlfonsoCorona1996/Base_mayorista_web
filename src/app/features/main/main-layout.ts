import { Component, HostListener, inject, signal } from "@angular/core";
import { Router, RouterLink, RouterLinkActive, RouterOutlet } from "@angular/router";
import { AuthService } from "../../core/auth.service";

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

  ngOnInit() {
    this.syncMenuForViewport();
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
      return { operacion: false, catalogo: false, clientes: false };
    }

    try {
      const raw = window.localStorage.getItem("panel.menu.groups");
      if (!raw) return { operacion: false, catalogo: false, clientes: false };
      const parsed = JSON.parse(raw) as Record<string, boolean>;
      return {
        operacion: Boolean(parsed["operacion"]),
        catalogo: Boolean(parsed["catalogo"]),
        clientes: Boolean(parsed["clientes"]),
      };
    } catch {
      return { operacion: false, catalogo: false, clientes: false };
    }
  }

  private persistGroupState() {
    if (typeof window === "undefined") return;
    window.localStorage.setItem("panel.menu.groups", JSON.stringify(this.openGroups()));
  }
}
