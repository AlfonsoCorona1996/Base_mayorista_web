/** Additive metadata for WhatsApp listings; independent of internal variant SKUs. */
export interface ListingMetadata {
  keywords?: string[];
  supplierSku?: string | null;
  attributes?: ProductAttribute[];
  categoryReview?: {
    status: 'pending' | 'confirmed';
    path: string | null;
    confirmedBy?: string | null;
    confirmedAt?: string | null;
  };
  colorReview?: { signature: string; confirmedBy: string; confirmedAt: string };
  extractionOverrides?: {
    keywords?: boolean;
    supplierSku?: boolean;
    title?: boolean;
    category?: boolean;
    attributes?: boolean;
    colors?: boolean;
  };
}

export interface ProductAttribute {
  kind:
    | 'type'
    | 'audience'
    | 'brand'
    | 'material'
    | 'print'
    | 'pattern'
    | 'texture'
    | 'cut'
    | 'detail';
  value: string;
  source?: 'text' | 'image' | 'manual';
  image_id?: string | null;
  evidence?: string;
}

export function isCategoryConfirmed(
  listing: ListingMetadata & { category_hint?: string | null; category_proposed?: string | null },
): boolean {
  return (
    !!listing.category_hint &&
    !listing.category_proposed &&
    listing.categoryReview?.status === 'confirmed' &&
    listing.categoryReview.path === listing.category_hint
  );
}

export function colorMappingSignature(
  colors: ReadonlyArray<{ name: string; image_url: string | null }>,
): string {
  return JSON.stringify(
    colors
      .map(({ name, image_url }) => [name.trim(), image_url])
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
  );
}

export function normalizeKeywords(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(
      value
        .filter((entry): entry is string => typeof entry === 'string')
        .map((entry) => entry.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('es'))
        .filter(Boolean),
    ),
  ];
}

export function normalizeSupplierSku(value: unknown): string | null {
  return typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') || null : null;
}

export function normalizeVariantName(value: string | null | undefined): string {
  const name = (value || '').normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('es');
  return /^[+-]?\d+(?:[.,]\d+)?$/.test(name) ? String(Number(name.replace(',', '.'))) : name;
}

export function assertUniqueVariants(items: ReadonlyArray<{ variant_name: string | null }>): void {
  const names = new Set<string>();
  for (const item of items) {
    const key = normalizeVariantName(item.variant_name);
    if (names.has(key))
      throw new Error(
        `Variante duplicada: ${item.variant_name || 'Sin nombre'}. Corrígela antes de guardar.`,
      );
    names.add(key);
  }
}

export function normalizeSearch(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

export function matchesListingMetadata(listing: ListingMetadata, query: string): boolean {
  const term = normalizeSearch(query);
  return (
    !!term &&
    [...normalizeKeywords(listing.keywords), listing.supplierSku || ''].some((value) =>
      normalizeSearch(value).includes(term),
    )
  );
}

export function mergeListingMetadata(
  target: ListingMetadata,
  source: ListingMetadata,
  sameSupplier: boolean,
): ListingMetadata {
  const current = normalizeSupplierSku(target.supplierSku);
  const incoming = normalizeSupplierSku(source.supplierSku);
  if ((current || incoming) && !sameSupplier) {
    throw new Error(
      'Los SKU de proveedor pertenecen a proveedores distintos. Revisa las referencias antes de fusionar.',
    );
  }
  if (current && incoming && normalizeSearch(current) !== normalizeSearch(incoming)) {
    throw new Error(
      `Las referencias de proveedor son diferentes (${current} / ${incoming}). Resuelve el conflicto antes de fusionar.`,
    );
  }
  if (!current && incoming && target.extractionOverrides?.supplierSku) {
    throw new Error(
      'El SKU del destino se dejó vacío manualmente. Resuelve la referencia antes de fusionar.',
    );
  }
  return {
    keywords: normalizeKeywords([...(target.keywords || []), ...(source.keywords || [])]),
    supplierSku: current ?? (target.extractionOverrides?.supplierSku ? null : incoming),
    extractionOverrides: {
      ...target.extractionOverrides,
      keywords: true,
      supplierSku: !!(
        target.extractionOverrides?.supplierSku || source.extractionOverrides?.supplierSku
      ),
    },
  };
}
