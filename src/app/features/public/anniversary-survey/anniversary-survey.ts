import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  Injector,
  afterNextRender,
  computed,
  inject,
  signal,
} from "@angular/core";
import { NgTemplateOutlet } from "@angular/common";
import { Meta, Title } from "@angular/platform-browser";
import {
  COMMENT_MAX_LENGTH,
  ChoiceQuestion,
  ChoiceQuestionId,
  NAME_MAX_LENGTH,
  OTHER_MAX_LENGTH,
  OTHER_OPTION_ID,
  SURVEY_LOGO,
  SURVEY_QUESTIONS,
  SurveyQuestion,
} from "./survey-definition";
import { SurveyApiService, SurveyCampaign } from "./survey-api.service";
import { SurveyDraftStorage } from "./survey-draft-storage";
import {
  DONE_STEP,
  FIRST_QUESTION_STEP,
  GIFT_STEP,
  QUESTION_COUNT,
  StepError,
  SurveyDraft,
  WELCOME_STEP,
  buildSubmissionPayload,
  createDraft,
  emptyAnswers,
  firstIncompleteStep,
  validateName,
  validateQuestion,
} from "./survey-state";

type SurveyView = "welcome" | "question" | "gift" | "done" | "closed";
type SubmitNotice = { tone: "offline" | "error"; message: string };

const TEXT_SAVE_DELAY_MS = 400;
const HISTORY_KEY = "bmSurveyStep";
const HISTORY_INDEX_KEY = "bmSurveyIndex";
const PAGE_TITLE = "Encuesta de aniversario | Base Mayorista";
const THEME_COLOR = "#0b1a45";

interface HistoryEntryState {
  [HISTORY_KEY]?: number;
  [HISTORY_INDEX_KEY]?: number;
}

function readHistoryState(): HistoryEntryState & Record<string, unknown> {
  const state: unknown = history.state;
  return typeof state === "object" && state !== null ? (state as Record<string, unknown>) : {};
}

@Component({
  selector: "app-anniversary-survey",
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [NgTemplateOutlet],
  templateUrl: "./anniversary-survey.html",
  styleUrl: "./anniversary-survey.css",
  providers: [SurveyApiService],
})
export default class AnniversarySurveyPage {
  private readonly api = inject(SurveyApiService);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly injector = inject(Injector);
  private readonly title = inject(Title);
  private readonly meta = inject(Meta);
  private readonly storage = SurveyDraftStorage.fromBrowser();

  protected readonly logo = SURVEY_LOGO;
  protected readonly questions = SURVEY_QUESTIONS;
  protected readonly questionCount = QUESTION_COUNT;
  protected readonly otherId = OTHER_OPTION_ID;
  protected readonly otherMaxLength = OTHER_MAX_LENGTH;
  protected readonly commentMaxLength = COMMENT_MAX_LENGTH;
  protected readonly nameMaxLength = NAME_MAX_LENGTH;
  protected readonly storageAvailable = this.storage.available;

  protected readonly draft = signal<SurveyDraft>(createDraft());
  protected readonly online = signal(typeof navigator === "undefined" ? true : navigator.onLine !== false);
  protected readonly resumed = signal(false);
  protected readonly draftReset = signal(false);
  protected readonly confirmingRestart = signal(false);
  protected readonly showErrors = signal(false);
  protected readonly sending = signal(false);
  protected readonly submitNotice = signal<SubmitNotice | null>(null);
  protected readonly closedMessage = signal<string | null>(null);
  protected readonly campaign = signal<SurveyCampaign | null>(null);

  protected readonly step = computed(() => this.draft().step);
  /** Clave para re-crear el contenido (y su animación de entrada) en cada paso. */
  protected readonly stepKey = computed(() => [this.step()]);

  protected readonly view = computed<SurveyView>(() => {
    const draft = this.draft();
    if (draft.receipt) return "done";
    if (this.closedMessage() && draft.submission !== "pending") return "closed";
    if (draft.step === WELCOME_STEP) return "welcome";
    if (draft.step === GIFT_STEP) return "gift";
    return "question";
  });

  protected readonly questionIndex = computed(() => this.step() - FIRST_QUESTION_STEP);
  protected readonly question = computed<SurveyQuestion | null>(() => {
    const index = this.questionIndex();
    return index >= 0 && index < QUESTION_COUNT ? SURVEY_QUESTIONS[index] : null;
  });
  /** Preguntas completadas, para la barra de progreso. */
  protected readonly progress = computed(() => {
    const step = this.step();
    if (step >= GIFT_STEP) return 1;
    return Math.max(0, step - FIRST_QUESTION_STEP) / QUESTION_COUNT;
  });

  protected readonly stepError = computed<StepError | null>(() => {
    const draft = this.draft();
    if (draft.step === GIFT_STEP) return validateName(draft.name);
    const index = draft.step - FIRST_QUESTION_STEP;
    return index >= 0 && index < QUESTION_COUNT ? validateQuestion(draft.answers, index) : null;
  });
  protected readonly visibleError = computed(() => (this.showErrors() ? this.stepError() : null));

  protected readonly receivedAtLabel = computed(() => {
    const iso = this.draft().receipt?.receivedAt;
    if (!iso) return null;
    try {
      return new Intl.DateTimeFormat("es-MX", { dateStyle: "long", timeStyle: "short" }).format(new Date(iso));
    } catch {
      return null;
    }
  });
  protected readonly folio = computed(() => this.draft().receipt?.participationId.slice(0, 8).toUpperCase() ?? "");

  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private previousTitle = "";
  private previousThemeColor: string | null = null;

  constructor() {
    const destroyRef = inject(DestroyRef);
    this.restoreDraft();
    this.setupDocumentMeta();

    const onPopState = (event: PopStateEvent) => this.handlePopState(event);
    const onOnline = () => {
      this.online.set(true);
      // Si había un envío sin confirmar, se reintenta solo al volver la conexión.
      if (this.view() === "gift" && this.draft().submission === "pending" && !this.sending()) void this.submit(true);
    };
    const onOffline = () => this.online.set(false);
    const onHide = () => this.flushSave();
    const onVisibility = () => {
      if (document.visibilityState === "hidden") this.flushSave();
    };

    window.addEventListener("popstate", onPopState);
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    window.addEventListener("pagehide", onHide);
    document.addEventListener("visibilitychange", onVisibility);
    destroyRef.onDestroy(() => {
      this.flushSave();
      window.removeEventListener("popstate", onPopState);
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
      window.removeEventListener("pagehide", onHide);
      document.removeEventListener("visibilitychange", onVisibility);
      this.restoreDocumentMeta();
    });

    void this.loadCampaign();
    this.continueFromStaticWelcome();
  }

  // -------------------------------------------------------------------------
  // Navegación

  protected start(): void {
    this.goTo(FIRST_QUESTION_STEP);
  }

  protected next(): void {
    if (this.stepError()) {
      this.showErrors.set(true);
      this.focusFirstInvalid();
      return;
    }
    this.goTo(this.step() + 1);
  }

  protected back(): void {
    const step = this.step();
    if (step <= WELCOME_STEP || this.draft().legacySubmission) return;
    const state = readHistoryState();
    // Si el paso anterior está en el historial, se usa para que el botón
    // "atrás" de Android y este botón recorran el mismo camino.
    if ((state[HISTORY_INDEX_KEY] ?? 0) > 0 && state[HISTORY_KEY] === step) {
      history.back();
      return;
    }
    this.applyStep(step - 1, "replace");
  }

  private goTo(step: number): void {
    this.applyStep(step, "push");
  }

  private applyStep(step: number, mode: "push" | "replace" | "none"): void {
    this.flushSave();
    this.showErrors.set(false);
    this.confirmingRestart.set(false);
    this.submitNotice.set(null);
    if (step !== this.step()) this.resumed.set(false);
    this.update((draft) => ({ ...draft, step }));
    this.persistNow();

    const current = readHistoryState();
    const index = current[HISTORY_INDEX_KEY] ?? 0;
    if (mode === "push") {
      history.pushState({ ...current, [HISTORY_KEY]: step, [HISTORY_INDEX_KEY]: index + 1 }, "");
    } else if (mode === "replace") {
      history.replaceState({ ...current, [HISTORY_KEY]: step }, "");
    }

    window.scrollTo(0, 0);
    this.focusStepTitle();
  }

  private handlePopState(event: PopStateEvent): void {
    const state: unknown = event.state;
    const target = typeof state === "object" && state !== null ? (state as HistoryEntryState)[HISTORY_KEY] : undefined;
    if (typeof target !== "number" || this.draft().receipt || this.draft().legacySubmission || this.sending()) return;
    let step = Math.min(Math.max(target, WELCOME_STEP), GIFT_STEP);
    const incomplete = firstIncompleteStep(this.draft().answers, step);
    if (incomplete !== null) step = incomplete;
    if (step !== this.step()) this.applyStep(step, "none");
  }

  // -------------------------------------------------------------------------
  // Respuestas

  protected setRating(value: number): void {
    this.update((draft) => ({ ...draft, answers: { ...draft.answers, satisfaction: value } }));
    this.persistNow();
  }

  protected isSelected(id: ChoiceQuestionId, optionId: string): boolean {
    return this.draft().answers[id].selected.includes(optionId);
  }

  protected selectedCount(id: ChoiceQuestionId): number {
    return this.draft().answers[id].selected.length;
  }

  protected isOptionDisabled(question: ChoiceQuestion, optionId: string): boolean {
    const selected = this.draft().answers[question.id].selected;
    return question.kind === "multi" && selected.length >= question.max && !selected.includes(optionId);
  }

  protected otherText(id: ChoiceQuestionId): string {
    return this.draft().answers[id].other;
  }

  protected toggleOption(question: ChoiceQuestion, optionId: string, checked: boolean): void {
    const current = this.draft().answers[question.id];
    let selected = current.selected;
    if (checked) {
      if (selected.includes(optionId)) return;
      if (question.kind === "single") selected = [optionId];
      else {
        if (selected.length >= question.max) return;
        selected = [...selected, optionId];
      }
    } else {
      selected = selected.filter((id) => id !== optionId);
    }
    // Al desmarcar "Otro" se limpia su texto.
    const other = selected.includes(OTHER_OPTION_ID) ? current.other : "";
    this.update((draft) => ({
      ...draft,
      answers: { ...draft.answers, [question.id]: { selected, other } },
    }));
    this.persistNow();
    if (checked && optionId === OTHER_OPTION_ID) this.focusById("other-input");
  }

  protected setOther(id: ChoiceQuestionId, value: string): void {
    const text = value.slice(0, OTHER_MAX_LENGTH);
    this.update((draft) => ({
      ...draft,
      answers: { ...draft.answers, [id]: { ...draft.answers[id], other: text } },
    }));
    this.scheduleSave();
  }

  protected setComment(value: string): void {
    const text = value.slice(0, COMMENT_MAX_LENGTH);
    this.update((draft) => ({ ...draft, answers: { ...draft.answers, comment: text } }));
    this.scheduleSave();
  }

  protected setName(value: string): void {
    this.update((draft) => ({ ...draft, name: value.slice(0, NAME_MAX_LENGTH) }));
    if (this.submitNotice()?.tone === "error") this.submitNotice.set(null);
    this.scheduleSave();
  }

  // -------------------------------------------------------------------------
  // Envío

  protected async submit(automatic = false): Promise<void> {
    if (this.sending()) return;
    const nameError = validateName(this.draft().name);
    if (nameError) {
      if (automatic) return;
      this.showErrors.set(true);
      this.focusById("gift-name");
      return;
    }
    const incomplete = firstIncompleteStep(this.draft().answers, GIFT_STEP);
    if (incomplete !== null && !this.draft().legacySubmission) {
      this.applyStep(incomplete, "replace");
      this.showErrors.set(true);
      return;
    }

    this.update((draft) => ({ ...draft, submission: "pending" }));
    this.persistNow();
    this.sending.set(true);
    this.submitNotice.set(null);

    const result = await this.api.submit(this.draft().legacySubmission ?? buildSubmissionPayload(this.draft()));
    this.sending.set(false);

    switch (result.kind) {
      case "ok":
        // Solo con la confirmación del servidor se reemplaza el borrador por el comprobante.
        this.update((draft) => ({
          ...draft,
          step: DONE_STEP,
          submission: "confirmed",
          receipt: result.receipt,
          legacySubmission: undefined,
          // En un celular compartido no se dejan respuestas a la vista; queda el comprobante.
          answers: emptyAnswers(),
          name: "",
        }));
        this.persistNow();
        history.replaceState({ ...readHistoryState(), [HISTORY_KEY]: DONE_STEP }, "");
        window.scrollTo(0, 0);
        this.focusStepTitle();
        return;
      case "offline":
        this.submitNotice.set({
          tone: "offline",
          message: this.storageAvailable
            ? "Tus respuestas siguen guardadas en este celular. Cuando tengas conexión, podrás enviarlas."
            : "Tus respuestas siguen en esta pantalla. No la cierres: cuando tengas conexión, podrás enviarlas.",
        });
        break;
      case "rate_limited":
        this.submitNotice.set({
          tone: "error",
          message: "Estamos recibiendo muchas respuestas en este momento. Espera un minuto y vuelve a intentar.",
        });
        break;
      case "closed":
        this.closedMessage.set(result.message);
        this.update((draft) => ({ ...draft, submission: "idle" }));
        this.persistNow();
        break;
      case "invalid":
        this.submitNotice.set({ tone: "error", message: result.message });
        break;
      case "server":
        this.submitNotice.set({
          tone: "error",
          message: "No pudimos registrar tus respuestas. Siguen guardadas; intenta de nuevo en un momento.",
        });
        break;
    }
    if (!automatic) this.focusById("submit-notice");
  }

  // -------------------------------------------------------------------------
  // Reinicio

  protected askRestart(): void {
    this.confirmingRestart.set(true);
    this.focusById("restart-confirm");
  }

  protected cancelRestart(): void {
    this.confirmingRestart.set(false);
  }

  protected confirmRestart(): void {
    this.clearSaveTimer();
    this.storage.clear();
    this.resumed.set(false);
    this.draftReset.set(false);
    this.confirmingRestart.set(false);
    this.closedMessage.set(this.campaign()?.status === "closed" ? "La encuesta de aniversario ya cerró. Gracias por tu interés." : null);
    this.draft.set(createDraft());
    this.applyStep(WELCOME_STEP, "replace");
  }

  // -------------------------------------------------------------------------
  // Persistencia

  private update(mutate: (draft: SurveyDraft) => SurveyDraft): void {
    this.draft.update((draft) => ({ ...mutate(draft), updatedAt: new Date().toISOString() }));
  }

  private persistNow(): void {
    this.clearSaveTimer();
    this.storage.save(this.draft());
  }

  /** Los textos se guardan con un pequeño retraso para no escribir en cada tecla. */
  private scheduleSave(): void {
    this.clearSaveTimer();
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.storage.save(this.draft());
    }, TEXT_SAVE_DELAY_MS);
  }

  private flushSave(): void {
    if (this.saveTimer === null) return;
    this.persistNow();
  }

  private clearSaveTimer(): void {
    if (this.saveTimer !== null) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
  }

  private restoreDraft(): void {
    const { draft, status } = this.storage.load();
    this.draftReset.set(status === "discarded");
    if (draft) {
      this.draft.set(draft);
      this.resumed.set(status === "restored" && !draft.receipt && draft.step > WELCOME_STEP);
    }
    // La entrada actual del historial representa el paso inicial.
    history.replaceState({ ...readHistoryState(), [HISTORY_KEY]: this.step(), [HISTORY_INDEX_KEY]: 0 }, "");
    this.storage.save(this.draft());
  }

  /**
   * aniversario.html muestra una bienvenida estática mientras carga la app
   * (ver welcome.static.html). Si la clienta ya tocó "Comenzar" ahí, se avanza;
   * si se desplazó, se conserva su posición al retirar esa pantalla.
   */
  private continueFromStaticWelcome(): void {
    const early = window as Window & { __bmSurveyStart?: boolean };
    const splash = document.getElementById("app-shell-skeleton");
    if (early.__bmSurveyStart) {
      delete early.__bmSurveyStart;
      if (this.step() === WELCOME_STEP && !this.draft().receipt) this.start();
      return;
    }
    if (!splash || this.step() !== WELCOME_STEP) return;
    afterNextRender(
      {
        read: () => {
          if (splash.isConnected && splash.scrollTop > 0) window.scrollTo(0, splash.scrollTop);
        },
      },
      { injector: this.injector },
    );
  }

  private async loadCampaign(): Promise<void> {
    const campaign = await this.api.getCampaign();
    if (!campaign) return;
    this.campaign.set(campaign);
    if (campaign.status === "closed") {
      this.closedMessage.set("La encuesta de aniversario ya cerró. Gracias por tu interés.");
    }
  }

  // -------------------------------------------------------------------------
  // Documento y foco

  private setupDocumentMeta(): void {
    this.previousTitle = this.title.getTitle();
    this.title.setTitle(PAGE_TITLE);
    const theme = this.meta.getTag('name="theme-color"');
    this.previousThemeColor = theme?.content ?? null;
    this.meta.updateTag({ name: "theme-color", content: THEME_COLOR });
  }

  private restoreDocumentMeta(): void {
    if (this.previousTitle) this.title.setTitle(this.previousTitle);
    if (this.previousThemeColor !== null) this.meta.updateTag({ name: "theme-color", content: this.previousThemeColor });
  }

  private focusStepTitle(): void {
    this.focusById("step-title");
  }

  private focusFirstInvalid(): void {
    const error = this.stepError();
    if (error?.code === "other_required" || (error?.code === "too_long" && (this.question()?.kind === "multi" || this.question()?.kind === "single"))) {
      this.focusById("other-input");
    } else if (this.question()?.kind === "text") {
      this.focusById("comment-input");
    } else {
      this.focusById("step-error");
    }
  }

  /**
   * Enfoca después de pintar el paso: así el layout que provoca focus() no
   * se suma a la latencia de la interacción (INP) en teléfonos lentos.
   */
  private focusById(id: string): void {
    afterNextRender(
      {
        read: () => {
          setTimeout(() => {
            const element = this.host.nativeElement.querySelector<HTMLElement>(`#${id}`);
            element?.focus({ preventScroll: id === "step-title" });
          });
        },
      },
      { injector: this.injector },
    );
  }
}
