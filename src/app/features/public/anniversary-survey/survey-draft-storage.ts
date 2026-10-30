import { SURVEY_CAMPAIGN_ID } from "./survey-definition";
import { SurveyDraft, parseStoredDraft } from "./survey-state";

export const DRAFT_STORAGE_KEY = `bm.survey.${SURVEY_CAMPAIGN_ID}`;

export type DraftLoadStatus = "none" | "restored" | "discarded";

export interface DraftLoadResult {
  draft: SurveyDraft | null;
  status: DraftLoadStatus;
}

/**
 * Persistencia local del borrador. localStorage basta para este volumen
 * (unos pocos KB) y es síncrono, lo que permite guardar en `pagehide` sin
 * depender de promesas que el navegador puede cortar. Cualquier fallo
 * (modo privado, cuota llena, almacenamiento bloqueado) se trata como
 * "sin almacenamiento" y la encuesta sigue funcionando en memoria.
 */
export class SurveyDraftStorage {
  private storage: Storage | null;

  constructor(storage: Storage | null) {
    this.storage = storage;
  }

  static fromBrowser(): SurveyDraftStorage {
    try {
      const storage = globalThis.localStorage;
      const probe = `${DRAFT_STORAGE_KEY}.probe`;
      storage.setItem(probe, "1");
      storage.removeItem(probe);
      return new SurveyDraftStorage(storage);
    } catch {
      return new SurveyDraftStorage(null);
    }
  }

  get available(): boolean {
    return this.storage !== null;
  }

  load(): DraftLoadResult {
    if (!this.storage) return { draft: null, status: "none" };
    let raw: string | null;
    try {
      raw = this.storage.getItem(DRAFT_STORAGE_KEY);
    } catch {
      return { draft: null, status: "none" };
    }
    if (raw === null) return { draft: null, status: "none" };
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = null;
    }
    const draft = parseStoredDraft(parsed);
    if (!draft) {
      this.clear();
      return { draft: null, status: "discarded" };
    }
    return { draft, status: "restored" };
  }

  /** Devuelve false si no se pudo guardar; el borrador sigue en memoria. */
  save(draft: SurveyDraft): boolean {
    if (!this.storage) return false;
    try {
      this.storage.setItem(DRAFT_STORAGE_KEY, JSON.stringify(draft));
      return true;
    } catch {
      return false;
    }
  }

  clear(): void {
    if (!this.storage) return;
    try {
      this.storage.removeItem(DRAFT_STORAGE_KEY);
    } catch {
      // Sin acceso al almacenamiento: no hay nada que limpiar.
    }
  }
}
