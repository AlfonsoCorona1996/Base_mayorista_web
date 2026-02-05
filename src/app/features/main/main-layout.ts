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
}
