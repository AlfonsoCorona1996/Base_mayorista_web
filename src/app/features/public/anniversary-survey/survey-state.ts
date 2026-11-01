import {
  COMMENT_MAX_LENGTH,
  CHOICE_QUESTION_IDS,
  ChoiceQuestion,
  ChoiceQuestionId,
  NAME_MAX_LENGTH,
  NAME_MIN_LENGTH,
  OTHER_MAX_LENGTH,
  OTHER_MIN_LENGTH,
  OTHER_OPTION_ID,
  SURVEY_CAMPAIGN_ID,
  SURVEY_QUESTIONS,
  SURVEY_QUESTIONS_VERSION,
} from "./survey-definition";

export const DRAFT_SCHEMA_VERSION = 1;

/** Pasos: 0 bienvenida, 1..6 preguntas, 7 registro del regalo, 8 confirmación. */
export const WELCOME_STEP = 0;
export const FIRST_QUESTION_STEP = 1;
export const QUESTION_COUNT = SURVEY_QUESTIONS.length;
export const GIFT_STEP = QUESTION_COUNT + 1;
export const DONE_STEP = QUESTION_COUNT + 2;

export interface MultiAnswer {
  selected: string[];
  other: string;
}

export interface SurveyAnswers {
  satisfaction: number | null;
  strengths: MultiAnswer;
  improvements: MultiAnswer;
  new_products: MultiAnswer;
  facebook_interest: MultiAnswer;
  comment: string;
}

export interface SurveyReward {
  status: "pending_definition" | "active";
  title: string | null;
  description: string | null;
  redeemInstructions: string | null;
}

export interface SurveyReceipt {
  participationId: string;
  receivedAt: string | null;
  registeredName: string;
  reward: SurveyReward;
}

/** idle: sin intento de envío. pending: se intentó y no hay confirmación. */
export type SubmissionStatus = "idle" | "pending" | "confirmed";

export interface SurveyDraft {
  schema: typeof DRAFT_SCHEMA_VERSION;
  campaignId: string;
  questionsVersion: number;
  participationId: string;
  step: number;
  answers: SurveyAnswers;
  name: string;
  submission: SubmissionStatus;
  receipt: SurveyReceipt | null;
  /** Instantánea v1 pendiente: solo se reintenta; nunca se atribuye a preguntas v2. */
  legacySubmission?: LegacySubmissionPayload;
  startedAt: string;
  updatedAt: string;
}

export type StepErrorCode = "required" | "other_required" | "too_long" | "name_required" | "name_too_long" | "invalid_selection";

export interface StepError {
  code: StepErrorCode;
  message: string;
}

function emptyMulti(): MultiAnswer {
  return { selected: [], other: "" };
}

export function emptyAnswers(): SurveyAnswers {
  return {
    satisfaction: null,
    strengths: emptyMulti(),
    improvements: emptyMulti(),
    new_products: emptyMulti(),
    facebook_interest: emptyMulti(),
    comment: "",
  };
}

export function createParticipationId(): string {
  const cryptoApi = typeof globalThis.crypto !== "undefined" ? globalThis.crypto : undefined;
  if (cryptoApi && typeof cryptoApi.randomUUID === "function") return cryptoApi.randomUUID();
  const bytes = new Uint8Array(16);
  if (cryptoApi && typeof cryptoApi.getRandomValues === "function") {
    cryptoApi.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function createDraft(now: Date = new Date()): SurveyDraft {
  const iso = now.toISOString();
  return {
    schema: DRAFT_SCHEMA_VERSION,
    campaignId: SURVEY_CAMPAIGN_ID,
    questionsVersion: SURVEY_QUESTIONS_VERSION,
    participationId: createParticipationId(),
    step: WELCOME_STEP,
    answers: emptyAnswers(),
    name: "",
    submission: "idle",
    receipt: null,
    startedAt: iso,
    updatedAt: iso,
  };
}

export function choiceQuestion(id: ChoiceQuestionId): ChoiceQuestion {
  const question = SURVEY_QUESTIONS.find((item): item is ChoiceQuestion => (item.kind === "multi" || item.kind === "single") && item.id === id);
  if (!question) throw new Error(`Pregunta desconocida: ${id}`);
  return question;
}

export function collapseSpaces(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export function validateQuestion(answers: SurveyAnswers, questionIndex: number): StepError | null {
  const question = SURVEY_QUESTIONS[questionIndex];
  if (!question) return null;
  if (question.kind === "rating") {
    const value = answers.satisfaction;
    return value !== null && Number.isInteger(value) && value >= 1 && value <= 5
      ? null
      : { code: "required", message: "Elige una calificación para continuar." };
  }
  if (question.kind === "multi" || question.kind === "single") {
    const answer = answers[question.id];
    if (answer.selected.length > question.max || new Set(answer.selected).size !== answer.selected.length ||
        answer.selected.some((id) => !question.options.some((option) => option.id === id))) {
      return { code: "invalid_selection", message: "Revisa las opciones seleccionadas para continuar." };
    }
    if (answer.selected.length === 0) {
      return { code: "required", message: question.kind === "single" ? "Elige una opción para continuar." : `Elige al menos una opción (hasta ${question.max}).` };
    }
    if (answer.selected.includes(OTHER_OPTION_ID)) {
      const other = collapseSpaces(answer.other);
      if (other.length < OTHER_MIN_LENGTH) {
        return { code: "other_required", message: "Escribe tu respuesta en «Otro» o desmárcalo para continuar." };
      }
      if (other.length > OTHER_MAX_LENGTH) {
        return { code: "too_long", message: `Tu respuesta en «Otro» puede tener hasta ${OTHER_MAX_LENGTH} caracteres.` };
      }
    }
    return null;
  }
  return answers.comment.length > COMMENT_MAX_LENGTH
    ? { code: "too_long", message: `Tu comentario puede tener hasta ${COMMENT_MAX_LENGTH} caracteres.` }
    : null;
}

export function validateName(name: string): StepError | null {
  const value = collapseSpaces(name);
  if (value.length < NAME_MIN_LENGTH || !/\p{L}/u.test(value)) {
    return { code: "name_required", message: "Escribe el nombre con el que haces tus pedidos." };
  }
  if (value.length > NAME_MAX_LENGTH) {
    return { code: "name_too_long", message: `El nombre puede tener hasta ${NAME_MAX_LENGTH} caracteres.` };
  }
  return null;
}

/** Primer paso con datos incompletos antes de `upTo` (para no saltar preguntas obligatorias). */
export function firstIncompleteStep(answers: SurveyAnswers, upTo: number): number | null {
  for (let index = 0; index < QUESTION_COUNT && FIRST_QUESTION_STEP + index < upTo; index += 1) {
    if (validateQuestion(answers, index)) return FIRST_QUESTION_STEP + index;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Lectura defensiva de borradores: el almacenamiento puede traer datos de otra
// versión, editados a mano o truncados. Lo desconocido se descarta.

/** Forma de T con valores aún sin validar. */
type Unchecked<T> = { [K in keyof T]?: unknown };

function asUnchecked<T>(value: unknown): Unchecked<T> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Unchecked<T>) : null;
}

function readString(value: unknown, max: number): string {
  return typeof value === "string" ? value.slice(0, max) : "";
}

function readIso(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function readMulti(id: ChoiceQuestionId, input: unknown): MultiAnswer {
  const value = asUnchecked<MultiAnswer>(input);
  if (!value || !Array.isArray(value.selected)) return emptyMulti();
  const question = choiceQuestion(id);
  const allowed = new Set(question.options.map((option) => option.id));
  const selected: string[] = [];
  for (const item of value.selected) {
    if (typeof item === "string" && allowed.has(item) && !selected.includes(item) && selected.length < question.max) {
      selected.push(item);
    }
  }
  const other = selected.includes(OTHER_OPTION_ID) ? readString(value.other, OTHER_MAX_LENGTH) : "";
  return { selected, other };
}

function readReward(input: unknown): SurveyReward {
  const value = asUnchecked<SurveyReward>(input);
  if (value && value.status === "active" && typeof value.title === "string" && value.title) {
    return {
      status: "active",
      title: value.title.slice(0, 120),
      description: typeof value.description === "string" ? value.description.slice(0, 400) : null,
      redeemInstructions: typeof value.redeemInstructions === "string" ? value.redeemInstructions.slice(0, 400) : null,
    };
  }
  return { status: "pending_definition", title: null, description: null, redeemInstructions: null };
}

function readReceipt(input: unknown): SurveyReceipt | null {
  const value = asUnchecked<SurveyReceipt>(input);
  if (!value || typeof value.participationId !== "string") return null;
  return {
    participationId: value.participationId.slice(0, 64),
    receivedAt: readIso(value.receivedAt),
    registeredName: readString(value.registeredName, NAME_MAX_LENGTH),
    reward: readReward(value.reward),
  };
}

const PARTICIPATION_ID_RE = /^[A-Za-z0-9-]{16,64}$/;

/** Devuelve un borrador utilizable o null si no es compatible con esta versión. */
export function parseStoredDraft(input: unknown): SurveyDraft | null {
  const raw = asUnchecked<SurveyDraft>(input);
  if (!raw) return null;
  if (raw.schema !== DRAFT_SCHEMA_VERSION) return null;
  if (raw.campaignId !== SURVEY_CAMPAIGN_ID) return null;
  if (raw.questionsVersion !== SURVEY_QUESTIONS_VERSION) return readLegacyDraft(raw);
  if (typeof raw.participationId !== "string" || !PARTICIPATION_ID_RE.test(raw.participationId)) return null;

  const rawAnswers: Unchecked<SurveyAnswers> = asUnchecked<SurveyAnswers>(raw.answers) ?? {};
  const satisfaction = rawAnswers.satisfaction;
  const answers: SurveyAnswers = {
    satisfaction:
      typeof satisfaction === "number" && Number.isInteger(satisfaction) && satisfaction >= 1 && satisfaction <= 5
        ? satisfaction
        : null,
    strengths: emptyMulti(),
    improvements: emptyMulti(),
    new_products: emptyMulti(),
    facebook_interest: emptyMulti(),
    comment: readString(rawAnswers.comment, COMMENT_MAX_LENGTH),
  };
  for (const id of CHOICE_QUESTION_IDS) answers[id] = readMulti(id, rawAnswers[id]);

  const legacy = readLegacyPayload(raw.legacySubmission);
  if (legacy) return { ...createDraft(), participationId: legacy.participation_id, step: GIFT_STEP,
    submission: "pending", name: legacy.registered_name, legacySubmission: legacy };

  const receipt = raw.submission === "confirmed" ? readReceipt(raw.receipt) : null;
  const submission: SubmissionStatus = receipt ? "confirmed" : raw.submission === "pending" ? "pending" : "idle";

  const rawStep = typeof raw.step === "number" && Number.isInteger(raw.step) ? raw.step : WELCOME_STEP;
  let step = receipt ? DONE_STEP : Math.min(Math.max(rawStep, WELCOME_STEP), GIFT_STEP);
  if (!receipt) {
    // Nunca retomar más allá de una pregunta obligatoria sin contestar.
    const incomplete = firstIncompleteStep(answers, step);
    if (incomplete !== null) step = incomplete;
  }

  const now = new Date().toISOString();
  return {
    schema: DRAFT_SCHEMA_VERSION,
    campaignId: SURVEY_CAMPAIGN_ID,
    questionsVersion: SURVEY_QUESTIONS_VERSION,
    participationId: raw.participationId,
    step,
    answers,
    name: readString(raw.name, NAME_MAX_LENGTH),
    submission,
    receipt,
    startedAt: readIso(raw.startedAt) ?? now,
    updatedAt: readIso(raw.updatedAt) ?? now,
  };
}

/** Cuerpo que espera POST /api/surveys/:campaignId/responses. */
export function buildSubmissionPayload(draft: SurveyDraft) {
  const multi = (id: ChoiceQuestionId) => {
    const answer = draft.answers[id];
    return {
      selected: [...answer.selected],
      other: answer.selected.includes(OTHER_OPTION_ID) ? collapseSpaces(answer.other) : "",
    };
  };
  return {
    campaign_id: draft.campaignId,
    questions_version: draft.questionsVersion,
    participation_id: draft.participationId,
    started_at: draft.startedAt,
    registered_name: collapseSpaces(draft.name),
    answers: {
      satisfaction: draft.answers.satisfaction,
      strengths: multi("strengths"),
      improvements: multi("improvements"),
      new_products: multi("new_products"),
      facebook_interest: multi("facebook_interest"),
      comment: draft.answers.comment.trim(),
    },
  };
}

export interface LegacySubmissionPayload {
  campaign_id: string;
  questions_version: 1;
  participation_id: string;
  started_at: string;
  registered_name: string;
  answers: {
    satisfaction: number;
    strengths: MultiAnswer;
    improvements: MultiAnswer;
    new_products: MultiAnswer;
    sell_more: MultiAnswer;
    comment: string;
  };
}

export type SurveySubmissionPayload = ReturnType<typeof buildSubmissionPayload> | LegacySubmissionPayload;

/** Solo conserva el envío v1 pendiente o su comprobante; nunca migra respuestas a v2. */
function readLegacyDraft(raw: Unchecked<SurveyDraft>): SurveyDraft | null {
  if (raw.questionsVersion !== 1 || typeof raw.participationId !== "string" || !PARTICIPATION_ID_RE.test(raw.participationId)) return null;
  const receipt = raw.submission === "confirmed" ? readReceipt(raw.receipt) : null;
  if (receipt) return { ...createDraft(), questionsVersion: 1, participationId: raw.participationId,
    step: DONE_STEP, submission: "confirmed", receipt };
  if (raw.submission !== "pending") return null;
  const payload = readLegacyPayload({ campaign_id: raw.campaignId, questions_version: 1,
    participation_id: raw.participationId, started_at: raw.startedAt,
    registered_name: raw.name, answers: raw.answers });
  return payload ? { ...createDraft(), participationId: payload.participation_id,
    step: GIFT_STEP, submission: "pending", name: payload.registered_name, legacySubmission: payload } : null;
}

function readLegacyPayload(input: unknown): LegacySubmissionPayload | null {
  const raw = asUnchecked<LegacySubmissionPayload>(input);
  if (!raw || raw.questions_version !== 1 || raw.campaign_id !== SURVEY_CAMPAIGN_ID ||
      typeof raw.participation_id !== "string" || !PARTICIPATION_ID_RE.test(raw.participation_id) ||
      typeof raw.registered_name !== "string" || validateName(raw.registered_name)) return null;
  const answers = asUnchecked<LegacySubmissionPayload["answers"]>(raw.answers);
  if (!answers || typeof answers.satisfaction !== "number" || !Number.isInteger(answers.satisfaction) ||
      answers.satisfaction < 1 || answers.satisfaction > 5) return null;
  const legacyMulti = (value: unknown, max: number): MultiAnswer | null => {
    const choice = asUnchecked<MultiAnswer>(value);
    if (!choice || !Array.isArray(choice.selected) || !choice.selected.length || choice.selected.length > max ||
        choice.selected.some((id) => typeof id !== "string")) return null;
    return { selected: choice.selected as string[], other: readString(choice.other, OTHER_MAX_LENGTH) };
  };
  const strengths = legacyMulti(answers.strengths, 2);
  const improvements = legacyMulti(answers.improvements, 2);
  const new_products = legacyMulti(answers.new_products, 3);
  const sell_more = legacyMulti(answers.sell_more, 2);
  if (!strengths || !improvements || !new_products || !sell_more) return null;
  return { campaign_id: SURVEY_CAMPAIGN_ID, questions_version: 1, participation_id: raw.participation_id,
    started_at: readIso(raw.started_at) ?? new Date().toISOString(), registered_name: raw.registered_name,
    answers: { satisfaction: answers.satisfaction, strengths, improvements, new_products, sell_more,
      comment: readString(answers.comment, COMMENT_MAX_LENGTH) } };
}
