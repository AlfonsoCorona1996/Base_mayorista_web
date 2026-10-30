import { ChangeDetectionStrategy, Component, computed, inject, signal } from "@angular/core";
import { RouterLink } from "@angular/router";
import { firstValueFrom } from "rxjs";
import { UserAdminApiService } from "../../services/user-admin-api.service";
import { SURVEY_CAMPAIGN_ID, SURVEY_QUESTIONS } from "../public/anniversary-survey/survey-definition";

type ClaimStatus = "pending_validation" | "validated" | "rejected" | "redeemed" | "missing" | string;

interface OptionStats {
  counts: Record<string, number>;
  labels: Record<string, string>;
  other_texts: { text: string; response_id: string }[];
  max: number;
}

interface SurveySummaryResponse {
  ok: boolean;
  generated_at: string;
  config: {
    status: "active" | "closed";
    reward: { status: "pending_definition" | "active"; title: string | null; description: string | null };
  };
  summary: {
    total_responses: number;
    satisfaction: {
      counts: Record<string, number>;
      labels: Record<string, string>;
      average: number | null;
      answered: number;
    };
    options: Record<string, OptionStats>;
    comments: {
      response_id: string;
      text: string;
      satisfaction: number | null;
      registered_name: string | null;
      received_at: string | null;
    }[];
    claims: { total: number; by_status: Record<string, number>; repeated_names: number };
    participations: {
      response_id: string;
      registered_name: string | null;
      satisfaction: number | null;
      received_at: string | null;
      claim_status: ClaimStatus;
      reward_status: string | null;
    }[];
  };
}

interface BarRow {
  id: string;
  label: string;
  count: number;
  share: number;
}

interface OptionSection {
  id: string;
  title: string;
  max: number;
  rows: BarRow[];
  otherTexts: string[];
}

const CLAIM_LABEL: Record<string, string> = {
  pending_validation: "Por validar",
  validated: "Validado",
  rejected: "No válido",
  redeemed: "Canjeado",
  missing: "Sin registro",
};

const SHORT_TITLE: Record<string, string> = {
  strengths: "Lo que más les gusta",
  improvements: "Lo que debemos mejorar",
  new_products: "Productos que quieren",
  sell_more: "Qué les ayudaría a vender más",
};

function normalize(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .trim();
}

@Component({
  selector: "app-encuesta-aniversario-page",
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink],
  templateUrl: "./encuesta-aniversario.page.html",
  styleUrl: "./encuesta-aniversario.page.css",
})
export default class EncuestaAniversarioPage {
  private readonly api = inject(UserAdminApiService);

  protected readonly loading = signal(true);
  protected readonly error = signal<string | null>(null);
  protected readonly data = signal<SurveySummaryResponse | null>(null);
  protected readonly search = signal("");
  protected readonly copied = signal(false);
  protected readonly surveyUrl = `${typeof location === "undefined" ? "" : location.origin}/aniversario`;

  protected readonly summary = computed(() => this.data()?.summary ?? null);
  protected readonly total = computed(() => this.summary()?.total_responses ?? 0);

  protected readonly ratingRows = computed<BarRow[]>(() => {
    const satisfaction = this.summary()?.satisfaction;
    if (!satisfaction) return [];
    const answered = satisfaction.answered || 0;
    return [5, 4, 3, 2, 1].map((value) => {
      const count = satisfaction.counts[String(value)] ?? 0;
      return {
        id: String(value),
        label: `${value} · ${satisfaction.labels[String(value)] ?? ""}`,
        count,
        share: answered ? count / answered : 0,
      };
    });
  });

  protected readonly optionSections = computed<OptionSection[]>(() => {
    const options = this.summary()?.options;
    if (!options) return [];
    const total = this.total();
    return SURVEY_QUESTIONS.filter((question) => question.kind === "multi").map((question) => {
      const stats = options[question.id];
      const rows = stats
        ? Object.entries(stats.counts)
            .map(([id, count]) => ({ id, label: stats.labels[id] ?? id, count, share: total ? count / total : 0 }))
            .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label, "es"))
        : [];
      return {
        id: question.id,
        title: SHORT_TITLE[question.id] ?? question.title,
        max: stats?.max ?? 0,
        rows,
        otherTexts: stats?.other_texts.map((item) => item.text) ?? [],
      };
    });
  });

  protected readonly pendingClaims = computed(() => this.summary()?.claims.by_status["pending_validation"] ?? 0);

  protected readonly filteredComments = computed(() => {
    const comments = this.summary()?.comments ?? [];
    const term = normalize(this.search());
    if (!term) return comments;
    return comments.filter((comment) => normalize(`${comment.text} ${comment.registered_name ?? ""}`).includes(term));
  });

  protected readonly filteredParticipations = computed(() => {
    const rows = this.summary()?.participations ?? [];
    const term = normalize(this.search());
    const counts = new Map<string, number>();
    for (const row of rows) {
      const key = normalize(row.registered_name ?? "");
      if (key) counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return rows
      .filter((row) => !term || normalize(row.registered_name ?? "").includes(term))
      .map((row) => ({ ...row, repeated: (counts.get(normalize(row.registered_name ?? "")) ?? 0) > 1 }));
  });

  protected readonly updatedLabel = computed(() => this.formatDate(this.data()?.generated_at ?? null));

  constructor() {
    void this.load();
  }

  protected async load(): Promise<void> {
    this.loading.set(true);
    this.error.set(null);
    try {
      const response = await firstValueFrom(
        this.api.get<SurveySummaryResponse>(`/api/admin/surveys/${SURVEY_CAMPAIGN_ID}/summary`),
      );
      this.data.set(response);
    } catch (error) {
      const message = error instanceof Error && error.message ? error.message : "";
      this.error.set(message || "No pudimos cargar los resultados de la encuesta.");
    } finally {
      this.loading.set(false);
    }
  }

  protected setSearch(value: string): void {
    this.search.set(value);
  }

  protected async copyLink(): Promise<void> {
    try {
      await navigator.clipboard.writeText(this.surveyUrl);
      this.copied.set(true);
      setTimeout(() => this.copied.set(false), 2000);
    } catch {
      this.copied.set(false);
    }
  }

  protected claimLabel(status: ClaimStatus): string {
    return CLAIM_LABEL[status] ?? status;
  }

  protected percent(share: number): string {
    return `${Math.round(share * 100)}%`;
  }

  protected formatDate(iso: string | null): string {
    if (!iso) return "—";
    const date = new Date(iso);
    if (!Number.isFinite(date.getTime())) return "—";
    return new Intl.DateTimeFormat("es-MX", { dateStyle: "medium", timeStyle: "short" }).format(date);
  }
}
