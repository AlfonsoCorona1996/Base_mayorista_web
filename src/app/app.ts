import { Component, signal, ChangeDetectionStrategy, inject } from '@angular/core';
import { NavigationCancel, NavigationEnd, NavigationError, Router, RouterOutlet } from '@angular/router';
import { SwUpdate, VersionReadyEvent } from '@angular/service-worker';
import { filter, take } from 'rxjs';
import { firebaseSmokeTest } from "./core/firebase.smoketest";
import { initFirestoreConnectivityResume } from "./core/firestore-connectivity";
import { bootedOnLightweightPublicPath } from "./core/public-landing";

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
  private readonly swUpdate = inject(SwUpdate, { optional: true });

  constructor() {
    if (!bootedOnLightweightPublicPath()) {
      firebaseSmokeTest();
      initFirestoreConnectivityResume();
    }
    this.setupServiceWorkerUpdates();
    this.router.events
      .pipe(
        filter((event): event is NavigationEnd | NavigationCancel | NavigationError =>
          event instanceof NavigationEnd || event instanceof NavigationCancel || event instanceof NavigationError),
        take(1),
      )
      .subscribe(() => this.dismissBootSkeleton());
  }
  protected readonly title = signal('admin-web');

  /**
   * Aplica una nueva versión publicada del sitio sin interrumpir a alguien a
   * media tarea: si la pestaña ya está oculta cuando llega la actualización
   * (o la siguiente vez que se oculta), recarga ahí; nunca mientras está
   * visible. Así se evita quedarse corriendo un bundle viejo por minutos u
   * horas en una sesión de mobile que no se cierra, que es lo que deja rutas
   * "colgadas" cargando para siempre tras un deploy.
   */
  private setupServiceWorkerUpdates(): void {
    if (!this.swUpdate?.isEnabled) return;

    let updateReady = false;

    this.swUpdate.versionUpdates
      .pipe(filter((event): event is VersionReadyEvent => event.type === 'VERSION_READY'))
      .subscribe(() => {
        updateReady = true;
        if (document.visibilityState === 'hidden') document.location.reload();
      });

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') {
        if (updateReady) document.location.reload();
        return;
      }
      this.swUpdate?.checkForUpdate().catch(() => undefined);
    });
  }

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
