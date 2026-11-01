/**
 * Encuesta del primer aniversario. El backend valida con su propia copia
 * (survey_definitions.js en el repo del backend): si cambian opciones o
 * límites, sube QUESTIONS_VERSION en ambos lados. Un cambio de versión
 * reinicia con aviso los borradores incompatibles; conserva comprobantes y envíos pendientes.
 */
export const SURVEY_CAMPAIGN_ID = "aniversario-2026";
export const SURVEY_QUESTIONS_VERSION = 2;

export const OTHER_OPTION_ID = "other";
export const OTHER_MIN_LENGTH = 2;
export const OTHER_MAX_LENGTH = 120;
export const COMMENT_MAX_LENGTH = 1000;
export const NAME_MIN_LENGTH = 2;
export const NAME_MAX_LENGTH = 80;

/**
 * Logo BM (completo e ícono), generados desde brand/ con
 * scripts/generate-anniversary-assets.py. Para sustituirlo basta con regenerarlos.
 */
export const SURVEY_LOGO = {
  webp: "/aniversario/bm-logo.webp",
  png: "/aniversario/bm-logo.png",
  iconWebp: "/aniversario/bm-icono.webp",
  iconPng: "/aniversario/bm-icono.png",
} as const;

export type MultiQuestionId = "strengths" | "improvements" | "new_products";
export type ChoiceQuestionId = MultiQuestionId | "facebook_interest";

export interface SurveyOption {
  id: string;
  label: string;
}

export interface RatingQuestion {
  kind: "rating";
  id: "satisfaction";
  title: string;
  options: readonly { value: number; label: string }[];
}

export interface MultiQuestion {
  kind: "multi";
  id: MultiQuestionId;
  title: string;
  max: number;
  options: readonly SurveyOption[];
}

export interface SingleQuestion {
  kind: "single";
  id: "facebook_interest";
  title: string;
  intro: { title: string; description: string };
  max: 1;
  options: readonly SurveyOption[];
}

export type ChoiceQuestion = MultiQuestion | SingleQuestion;

export interface TextQuestion {
  kind: "text";
  id: "comment";
  title: string;
  placeholder: string;
  maxLength: number;
}

export type SurveyQuestion = RatingQuestion | ChoiceQuestion | TextQuestion;

export const SURVEY_QUESTIONS: readonly SurveyQuestion[] = [
  {
    kind: "rating",
    id: "satisfaction",
    title: "¿Cómo calificarías tu experiencia actual comprando con Base Mayorista?",
    options: [
      { value: 1, label: "Muy mala" },
      { value: 2, label: "Mala" },
      { value: 3, label: "Regular" },
      { value: 4, label: "Buena" },
      { value: 5, label: "Excelente" },
    ],
  },
  {
    kind: "multi",
    id: "strengths",
    title: "¿Qué es lo que más valoras de Base Mayorista y te gustaría que siguiéramos ofreciendo?",
    max: 2,
    options: [
      { id: "prices", label: "Nuestros precios" },
      { id: "variety", label: "La variedad de productos" },
      { id: "quality", label: "La calidad de los productos" },
      { id: "service", label: "La atención y el trato que recibes" },
      { id: "ordering_ease", label: "La facilidad para realizar pedidos" },
      { id: "news", label: "Las novedades que compartimos" },
      { id: OTHER_OPTION_ID, label: "Otro" },
    ],
  },
  {
    kind: "multi",
    id: "improvements",
    title: "¿Cuál de estas opciones te ayudaría más a hacer tus pedidos o vender nuestros productos?",
    max: 2,
    options: [
      { id: "digital_catalog", label: "Un catálogo digital fácil de consultar y compartir" },
      { id: "ready_media", label: "Fotos y videos listos para publicar" },
      { id: "order_tracking", label: "Poder consultar más fácilmente el avance de mis pedidos" },
      { id: "early_news", label: "Conocer las novedades con anticipación" },
      { id: "availability", label: "Más opciones de tallas, colores y modelos" },
      { id: "seller_promos", label: "Promociones especiales para vendedoras" },
      { id: OTHER_OPTION_ID, label: "Otro" },
    ],
  },
  {
    kind: "single",
    id: "facebook_interest",
    intro: {
      title: "Una idea que estamos preparando",
      description: "Queremos aprovechar nuestra nueva página de Facebook para dar a conocer nuestros productos y ayudar a que las personas interesadas encuentren vendedoras en su localidad.",
    },
    title: "¿Te gustaría participar en esta iniciativa y recibir posibles nuevas clientas de tu zona?",
    max: 1,
    options: [
      { id: "very_interested", label: "¡Sí, me interesa mucho!" },
      { id: "needs_information", label: "Me interesa, pero quisiera conocer cómo funcionaría" },
      { id: "not_interested", label: "Por ahora prefiero seguir con mis propias clientas" },
      { id: OTHER_OPTION_ID, label: "Otro" },
    ],
  },
  {
    kind: "multi",
    id: "new_products",
    title: "¿Qué productos te gustaría que ampliáramos o incorporáramos a nuestro catálogo?",
    max: 3,
    options: [
      { id: "women_clothing", label: "Más ropa de dama" },
      { id: "men_clothing", label: "Más ropa de caballero" },
      { id: "kids_clothing", label: "Ropa infantil y para bebé" },
      { id: "footwear", label: "Calzado" },
      { id: "underwear", label: "Ropa interior" },
      { id: "bags_accessories", label: "Bolsas y accesorios" },
      { id: "home", label: "Blancos y artículos para el hogar" },
      { id: "beauty", label: "Belleza y cuidado personal" },
      { id: OTHER_OPTION_ID, label: "Otro" },
    ],
  },
  {
    kind: "text",
    id: "comment",
    title: "Si pudieras proponernos una idea para nuestro segundo año, ¿qué te gustaría que hiciéramos?",
    placeholder:
      "Puede ser una nueva forma de vender, algún producto, una promoción, una mejora o algo que todavía no hayamos pensado...",
    maxLength: COMMENT_MAX_LENGTH,
  },
];

export const CHOICE_QUESTION_IDS: readonly ChoiceQuestionId[] = SURVEY_QUESTIONS.filter(
  (question): question is ChoiceQuestion => question.kind === "multi" || question.kind === "single",
).map((question) => question.id);
