import { Component, signal, ChangeDetectionStrategy, inject } from '@angular/core';
import { NavigationCancel, NavigationEnd, NavigationError, Router, RouterOutlet } from '@angular/router';
import { filter, take } from 'rxjs';
import { firebaseSmokeTest } from "./core/firebase.smoketest";

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-root',
   standalone: true,
  imports: [RouterOutlet],
  templateUrl: './app.html',
  styleUrl: './app.css'
})
export class App {
  private readonly router = inject(Router);

  constructor() {
    firebaseSmokeTest();
    this.router.events
      .pipe(
        filter((event): event is NavigationEnd | NavigationCancel | NavigationError =>
          event instanceof NavigationEnd || event instanceof NavigationCancel || event instanceof NavigationError),
        take(1),
      )
      .subscribe(() => this.dismissBootSkeleton());
  }
  protected readonly title = signal('admin-web');

  /** Retira la pantalla de arranque estática (ver index.html) una vez que la
   * primera navegación real terminó, sin importar si fue con éxito o no. */
  private dismissBootSkeleton(): void {
    const el = document.getElementById('app-shell-skeleton');
    if (!el) return;
    el.classList.add('is-leaving');
    const remove = () => el.remove();
    el.addEventListener('transitionend', remove, { once: true });
    setTimeout(remove, 400);
  }
}
