import { HttpClient, HttpErrorResponse } from "@angular/common/http";
import { Injectable, inject } from "@angular/core";
import { TimeoutError, firstValueFrom, timeout } from "rxjs";
import { environment } from "../../../../environments/environment";
import { SURVEY_CAMPAIGN_ID } from "./survey-definition";
import { SurveyReceipt, SurveyReward, SurveySubmissionPayload } from "./survey-state";

const CONFIG_TIMEOUT_MS = 8_000;
const SUBMIT_TIMEOUT_MS = 20_000;

interface ApiReward {
  status?: string;
  title?: string | null;
  description?: string | null;
  redeem_instructions?: string | null;
}

interface ApiCampaign {
  ok?: boolean;
  status?: string;
  reward?: ApiReward;
}

interface ApiReceipt {
  ok?: boolean;
  participation_id?: string;
  received_at?: string | null;
  registered_name?: string | null;
  reward?: ApiReward;
}

interface ApiError {
  error?: string;
  message?: string;
}

export interface SurveyCampaign {
  status: "active" | "closed";
  reward: SurveyReward;
}

export type SubmitResult =
  | { kind: "ok"; receipt: SurveyReceipt }
  | { kind: "offline" }
  | { kind: "rate_limited" }
  | { kind: "closed"; message: string }
  | { kind: "invalid"; message: string }
  | { kind: "server" };

function toReward(raw: ApiReward | undefined): SurveyReward {
  if (raw?.status === "active" && raw.title) {
    return {
      status: "active",
      title: raw.title,
      description: raw.description ?? null,
      redeemInstructions: raw.redeem_instructions ?? null,
    };
  }
  return { status: "pending_definition", title: null, description: null, redeemInstructions: null };
}

function isOffline(): boolean {
  return typeof navigator !== "undefined" && navigator.onLine === false;
}

@Injectable()
export class SurveyApiService {
  private readonly http = inject(HttpClient);
  private readonly baseUrl = `${environment.adminApiBaseUrl.replace(/\/+$/, "")}/api/surveys/${SURVEY_CAMPAIGN_ID}`;

  /** Estado de la campaña. Null si no se pudo consultar: la encuesta sigue disponible. */
  async getCampaign(): Promise<SurveyCampaign | null> {
    if (isOffline()) return null;
    try {
      const response = await firstValueFrom(this.http.get<ApiCampaign>(this.baseUrl).pipe(timeout(CONFIG_TIMEOUT_MS)));
      return {
        status: response.status === "closed" ? "closed" : "active",
        reward: toReward(response.reward),
      };
    } catch {
      return null;
    }
  }

  async submit(payload: SurveySubmissionPayload): Promise<SubmitResult> {
    if (isOffline()) return { kind: "offline" };
    try {
      const response = await firstValueFrom(
        this.http.post<ApiReceipt>(`${this.baseUrl}/responses`, payload).pipe(timeout(SUBMIT_TIMEOUT_MS)),
      );
      if (!response?.ok || response.participation_id !== payload.participation_id) return { kind: "server" };
      return {
        kind: "ok",
        receipt: {
          participationId: response.participation_id,
          receivedAt: response.received_at ?? null,
          registeredName: response.registered_name ?? payload.registered_name,
          reward: toReward(response.reward),
        },
      };
    } catch (error) {
      if (error instanceof TimeoutError) return { kind: "offline" };
      if (!(error instanceof HttpErrorResponse)) return { kind: "server" };
      const body = (error.error ?? {}) as ApiError;
      if (error.status === 0) return { kind: "offline" };
      if (error.status === 429) return { kind: "rate_limited" };
      if (error.status === 409 && body.error === "CAMPAIGN_CLOSED") {
        return { kind: "closed", message: body.message ?? "La encuesta de aniversario ya cerró." };
      }
      if (error.status === 400 || error.status === 413) {
        return { kind: "invalid", message: body.message ?? "Revisa tus respuestas e intenta de nuevo." };
      }
      return { kind: "server" };
    }
  }
}
