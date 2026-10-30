/**
 * Encuesta del primer aniversario. El backend valida con su propia copia
 * (survey_definitions.js en el repo del backend): si cambian opciones o
 * límites, sube QUESTIONS_VERSION en ambos lados. Un cambio de versión
 * descarta los borradores guardados en los celulares.
 */
export const SURVEY_CAMPAIGN_ID = "aniversario-2026";
export const SURVEY_QUESTIONS_VERSION = 1;

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

export type MultiQuestionId = "strengths" | "improvements" | "new_products" | "sell_more";

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

export interface TextQuestion {
  kind: "text";
  id: "comment";
  title: string;
  placeholder: string;
  maxLength: number;
}

export type SurveyQuestion = RatingQuestion | MultiQuestion | TextQuestion;

export const SURVEY_QUESTIONS: readonly SurveyQuestion[] = [
  {
    kind: "rating",
    id: "satisfaction",
    title: "¿Cómo calificarías tu experiencia comprando con Base Mayorista durante este primer año?",
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
    title: "¿Qué es lo que más te gusta de comprar con nosotros?",
    max: 2,
    options: [
      { id: "prices", label: "Nuestros precios" },
      { id: "variety", label: "Variedad de productos y modelos" },
      { id: "quality", label: "Calidad de los productos" },
      { id: "service", label: "Atención y trato que recibes" },
      { id: "ordering_ease", label: "Facilidad para realizar pedidos" },
      { id: OTHER_OPTION_ID, label: "Otro" },
    ],
  },
  {
    kind: "multi",
    id: "improvements",
    title: "Si pudieras pedirnos que mejoráramos algo, ¿qué sería?",
    max: 2,
    options: [
      { id: "delivery_times", label: "Tiempos de entrega" },
      { id: "availability", label: "Disponibilidad de tallas, colores y modelos" },
      { id: "prices", label: "Precios" },
      { id: "order_tracking", label: "Información y seguimiento de pedidos" },
      { id: "communication", label: "Atención y comunicación" },
      { id: "returns", label: "Cambios y devoluciones" },
      { id: OTHER_OPTION_ID, label: "Otro" },
    ],
  },
  {
    kind: "multi",
    id: "new_products",
    title: "¿Qué te gustaría que empezáramos a vender o que tuviéramos con más variedad?",
    max: 3,
    options: [
      { id: "women_clothing", label: "Ropa de mujer" },
      { id: "men_clothing", label: "Ropa de hombre" },
      { id: "kids_clothing", label: "Ropa infantil" },
      { id: "footwear", label: "Calzado" },
      { id: "bags_accessories", label: "Bolsas y accesorios" },
      { id: "home", label: "Artículos para el hogar" },
      { id: "beauty", label: "Belleza y cuidado personal" },
      { id: OTHER_OPTION_ID, label: "Otro" },
    ],
  },
  {
    kind: "multi",
    id: "sell_more",
    title: "¿Qué te ayudaría a vender más y hacer pedidos más seguido con nosotros?",
    max: 2,
    options: [
      { id: "frequent_news", label: "Recibir novedades con mayor frecuencia" },
      { id: "better_media", label: "Tener mejores fotos y videos para ofrecer" },
      { id: "seller_promos", label: "Promociones especiales para vendedoras" },
      { id: "easy_catalog", label: "Consultar fácilmente los productos disponibles" },
      { id: "faster_delivery", label: "Recibir los pedidos más rápido" },
      { id: "more_variety", label: "Encontrar más variedad de productos" },
      { id: OTHER_OPTION_ID, label: "Otro" },
    ],
  },
  {
    kind: "text",
    id: "comment",
    title: "¿Hay algo que te gustaría decirnos y que no te hayamos preguntado?",
    placeholder:
      "Puede ser una idea, algún producto específico que quisieras encontrar o algo que creas que deberíamos mejorar...",
    maxLength: COMMENT_MAX_LENGTH,
  },
];

export const MULTI_QUESTION_IDS: readonly MultiQuestionId[] = SURVEY_QUESTIONS.filter(
  (question): question is MultiQuestion => question.kind === "multi",
).map((question) => question.id);
