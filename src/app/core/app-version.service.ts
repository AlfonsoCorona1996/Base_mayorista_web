import { HttpClient } from "@angular/common/http";
import { Injectable, computed, inject, signal } from "@angular/core";
import { lastValueFrom } from "rxjs";
import packageMetadata from "../../../package.json";
import { environment } from "../../environments/environment";

export interface PublicBuildInfo {
  service: string;
  version: string;
  commit: string | null;
  dirty: boolean;
  built_at: string | null;
}

type BackendVersionState = "loading" | "ready" | "unversioned" | "unavailable";

@Injectable({ providedIn: "root" })
export class AppVersionService {
  private http = inject(HttpClient);
  private loaded = false;

  readonly frontend = signal<PublicBuildInfo>({
    service: "base-mayorista-admin-web",
    version: packageMetadata.version,
    commit: null,
    dirty: false,
    built_at: null,
  });
  readonly backend = signal<PublicBuildInfo | null>(null);
  readonly backendState = signal<BackendVersionState>("loading");

  readonly summary = computed(() => {
    const backend = this.backend();
    if (backend) return `Web v${this.frontend().version} · API v${backend.version}`;
    if (this.backendState() === "loading") return `Web v${this.frontend().version} · API consultando...`;
    if (this.backendState() === "unversioned") return `Web v${this.frontend().version} · API sin versión`;
    return `Web v${this.frontend().version} · API no disponible`;
  });

  load(): void {
    if (this.loaded) return;
    this.loaded = true;
    void Promise.all([this.loadFrontendBuild(), this.loadBackendBuild()]);
  }

  shortCommit(commit: string | null | undefined): string {
    if (!commit || commit === "unknown") return "sin commit";
    return commit.slice(0, 7);
  }

  private async loadFrontendBuild(): Promise<void> {
    try {
      const text = await lastValueFrom(this.http.get(
        `/version.json?v=${encodeURIComponent(packageMetadata.version)}`,
        { responseType: "text" },
      ));
      const build = this.parseBuildInfo(text);
      if (build?.version === packageMetadata.version) this.frontend.set(build);
    } catch {
      // En ng serve no existe version.json; package.json sigue siendo la fuente.
    }
  }

  private async loadBackendBuild(): Promise<void> {
    try {
      const text = await lastValueFrom(this.http.get(
        `${environment.adminApiBaseUrl.replace(/\/+$/, "")}/health`,
        { responseType: "text" },
      ));
      const build = this.parseBuildInfo(text);
      if (!build) {
        this.backendState.set("unversioned");
        return;
      }
      this.backend.set(build);
      this.backendState.set("ready");
    } catch {
      this.backendState.set("unavailable");
    }
  }

  private parseBuildInfo(text: string): PublicBuildInfo | null {
    try {
      const value = JSON.parse(text) as Record<string, unknown>;
      const version = typeof value["version"] === "string" ? value["version"].trim() : "";
      if (!version) return null;
      return {
        service: typeof value["service"] === "string" ? value["service"] : "unknown",
        version,
        commit: typeof value["commit"] === "string" && value["commit"].trim() ? value["commit"].trim() : null,
        dirty: value["dirty"] === true,
        built_at: typeof value["built_at"] === "string" ? value["built_at"] : null,
      };
    } catch {
      return null;
    }
  }
}
