/**
 * Contratos de datos de Firestore
 * Basados en la implementación real del backend (whatsapp-bot)
 * 
 * IMPORTANTE: Estos tipos reflejan la estructura REAL en Firestore,
 * no necesariamente el documento maestro original (ver evolución v1.1)
 */

// ============================================================================
// RAW_POST - Inmutable, evidencia original
// ============================================================================

export interface RawPostSource {
  forwarded_by_user_id: string;
  forwarded_from_group: string | null;
}

export interface RawPostSupplierHint {
  display_name: string | null;
  supplier_id: string | null;
  confidence: "explicit" | "inferred" | "unknown";
}

export interface RawPostMessage {
  raw_text: string;
  raw_lines: string[];
  language_hint: "es" | "en" | "unknown";
}

export interface RawPostImage {
  image_id: string;
  url: string | null;
  sha256: string | null;
  extracted_text: string | null;
}

export interface RawPostMedia {
  images: RawPostImage[];
}

export interface RawPost {
  schema_version: "raw_v1";
  raw_post_id: string;
  ingested_at: string | any; // ISO string o Firestore Timestamp
  channel: "whatsapp";
  source: RawPostSource;
  supplier_hint: RawPostSupplierHint;
  message: RawPostMessage;
  media: RawPostMedia;
}

// ============================================================================
// NORMALIZED_LISTING - Editable, propuesta estructurada
// ============================================================================

export type StockState = "in_stock" | "last_pair" | "out_of_stock" | "unknown_qty";

export interface ItemPrice {
  amount: number | null;
  currency: string;
  tier_name: string; // "publico", "asociada", "mayoreo", etc.
}

export interface VariantColorStock {
  color_name: string;
  stock_state: StockState;
}

/**
 * ProductColor - Color global del producto (Schema v1.1)
 * Un color se define una vez y se referencia en múltiples variantes
 */
export interface ProductColor {
  name: string;
  image_url: string | null;
}

/**
 * ITEM - Estructura REAL del backend (plana, no jerárquica)
 * 
 * NOTA: Esto difiere del plan maestro original que tenía
 * una jerarquía ITEM → VARIANT → SIZE.
 * La estructura actual es más simple y práctica.
 */
export interface NormalizedItem {
  variant_name: string | null;
  sku: string | null;
  stock_state: StockState;
  notes: string | null;
  prices: ItemPrice[];
  
  // ✅ SCHEMA v1.1: Solo referencias a colores globales
  color_names?: string[]; // ["negro", "blanco"] - Referencias a product_colors
  color_stock?: VariantColorStock[]; // Estado de stock por color dentro de la variante
  
  // DEPRECATED Schema v1: Mantener para compatibilidad
  colors?: string[]; // ["rosa", "beige", "azul marino"]
  image_urls?: string[]; // URLs de imágenes (mismo orden que colors)
  color?: string | null; 
  image_url?: string | null;
}

export interface PriceTierGlobal {
  discount_percent: number | null;
  notes: string | null;
  tier_name: string; // "publico", "asociada", "mayoreo", etc.
}

export interface NormalizedListing {
  title: string | null;
  category_hint: string | null;
  price_tiers_global: PriceTierGlobal[];
  items: NormalizedItem[];
}

export type WorkflowStatus = "needs_review" | "validated" | "rejected";

export interface Workflow {
  status: WorkflowStatus;
  validated_by: string | null;
  validated_at: any | null; // Firestore Timestamp o Date
}

/**
 * Review - Campos editados por el humano en la UI
 * Separados de la normalización automática de la IA
 */
export interface Review {
  preview_image_url: string | null;
  excluded_image_urls: string[];
  edited_at: any | null; // Firestore Timestamp
  edited_by: string | null;
}

export interface NormalizedListingDoc {
  schema_version: "normalized_v1" | "normalized_v1.1";
  normalized_id: string;
  raw_post_id: string;
  supplier_id: string | null;
  
  // ✅ SCHEMA v1.1: Portada y colores separados
  cover_images?: string[]; // ["https://.../todas_las_carteras.jpg"]
  product_colors?: ProductColor[]; // [{ name: "negro", image_url: "..." }]
  
  // DEPRECATED Schema v1: Mantener para compatibilidad
  preview_image_url?: string | null;
  
  created_at: any; // Firestore Timestamp
  updated_at: any; // Firestore Timestamp
  
  listing: NormalizedListing;
  workflow: Workflow;
  review: Review;
}

// ============================================================================
// Tipos auxiliares para paginación
// ============================================================================

export interface ListPage<T> {
  docs: T[];
  nextCursor: any | null; // QueryDocumentSnapshot
}

// ============================================================================
// Tipos para actualizaciones parciales
// ============================================================================

export interface ReviewPatch {
  preview_image_url?: string | null;
  excluded_image_urls?: string[];
  edited_by?: string | null;
}

export type PartialNormalizedUpdate = Partial<Pick<
  NormalizedListingDoc,
  "supplier_id" | "preview_image_url" | "cover_images" | "product_colors" | "listing"
>>;
