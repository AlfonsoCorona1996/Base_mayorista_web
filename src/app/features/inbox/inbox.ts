import { Component, signal } from "@angular/core";
import { Router } from "@angular/router";
import { AuthService } from "../../core/auth.service";
import { NormalizedListingsService } from "../../core/normalized-listings.service";
import type { NormalizedListingDoc } from "../../core/firestore-contracts";


@Component({
  standalone: true,
  selector: 'app-inbox',
  imports: [],
  templateUrl: './inbox.html',
  styleUrl: './inbox.css',
})
export default class Inbox {
  rows = signal<NormalizedListingDoc[]>([]);
  loading = signal(false);
  loadingMore = signal(false);
  error = signal<string | null>(null);
  hasMore = signal(true);

  private cursor: any | undefined;

  constructor(
    private auth: AuthService,
    private router: Router,
    private svc: NormalizedListingsService
  ) {
    this.reload();
  }

  shortId(id: string) {
    if (!id) return "";
    return id.length > 12 ? `${id.slice(0, 6)}…${id.slice(-4)}` : id;
  }

  async reload() {
    this.error.set(null);
    this.loading.set(true);
    this.cursor = undefined;
    this.hasMore.set(true);

    try {
      const { docs, nextCursor } = await this.svc.listNeedsReview(25);
      this.rows.set(docs);
      this.cursor = nextCursor;
      this.hasMore.set(Boolean(nextCursor));
    } catch (e: any) {
      this.error.set(e?.message || "Error cargando inbox");
    } finally {
      this.loading.set(false);
    }
  }

  async loadMore() {
    if (!this.cursor) {
      this.hasMore.set(false);
      return;
    }

    this.error.set(null);
    this.loadingMore.set(true);
    try {
      // ✅ FIX: Pasar el cursor actual para continuar la paginación
      const { docs, nextCursor } = await this.svc.listNeedsReview(25, this.cursor);

      this.rows.set([...this.rows(), ...docs]);
      this.cursor = nextCursor;
      this.hasMore.set(Boolean(nextCursor));
    } catch (e: any) {
      this.error.set(e?.message || "Error cargando más");
    } finally {
      this.loadingMore.set(false);
    }
  }

  async open(id: string) {
    await this.router.navigateByUrl(`/review/${id}`);
  }

  async logout() {
    await this.auth.logout();
    await this.router.navigateByUrl("/login");
  }

  timeAgo(ts: any): string {
    const d: Date | null =
      ts?.toDate?.() ? ts.toDate() :
        ts instanceof Date ? ts :
          null;

    if (!d) return "sin fecha";

    const diffMs = Date.now() - d.getTime();
    const sec = Math.max(0, Math.floor(diffMs / 1000));
    if (sec < 60) return `hace ${sec}s`;

    const min = Math.floor(sec / 60);
    if (min < 60) return `hace ${min} min`;

    const hr = Math.floor(min / 60);
    if (hr < 24) return `hace ${hr} h`;

    const days = Math.floor(hr / 24);
    return `hace ${days} d`;
  }

}
