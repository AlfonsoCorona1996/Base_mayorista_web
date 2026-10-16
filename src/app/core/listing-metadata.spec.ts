import {
  assertUniqueVariants,
  matchesListingMetadata,
  mergeListingMetadata,
  normalizeKeywords,
  normalizeSupplierSku,
} from './listing-metadata';

describe('Metadatos de productos WhatsApp', () => {
  it('normaliza espacios, Unicode y mayúsculas sin imponer un mínimo', () => {
    expect(
      normalizeKeywords(['  Tenis  ', 'TENIS', 'azul   marino', '', 'ＳＮＥＡＫＥＲＳ']),
    ).toEqual(['tenis', 'azul marino', 'sneakers']);
    expect(normalizeKeywords(undefined)).toEqual([]);
    expect(normalizeSupplierSku('  001-AB  ')).toBe('001-AB');
    expect(normalizeSupplierSku(' ')).toBeNull();
  });
  it('encuentra palabras clave y referencias sin exigir unicidad global', () => {
    const listing = { keywords: ['botín'], supplierSku: '001-ABC' };
    expect(matchesListingMetadata(listing, 'BOTIN')).toBeTrue();
    expect(matchesListingMetadata(listing, '001-abc')).toBeTrue();
    expect(matchesListingMetadata({}, '001-abc')).toBeFalse();
    expect(
      [listing, { ...listing }].filter((row) => matchesListingMetadata(row, '001-abc')).length,
    ).toBe(2);
  });
  it('rechaza variantes equivalentes en dominio, incluidos decimales y ceros', () => {
    for (const names of [
      ['6', '06.00'],
      ['unitalla', ' UNITALLA '],
      ['24,5', '24.50'],
    ]) {
      expect(() =>
        assertUniqueVariants(names.map((variant_name) => ({ variant_name }))),
      ).toThrowError(/duplicada/);
    }
    expect(() =>
      assertUniqueVariants([{ variant_name: '6' }, { variant_name: '8' }]),
    ).not.toThrow();
  });
  it('fusiona palabras y preserva el SKU manual y su protección', () => {
    const merged = mergeListingMetadata(
      { keywords: ['tenis'], supplierSku: '001', extractionOverrides: { supplierSku: true } },
      { keywords: [' TENIS ', 'sneaker'], supplierSku: null },
      true,
    );
    expect(merged.keywords).toEqual(['tenis', 'sneaker']);
    expect(merged.supplierSku).toBe('001');
    expect(merged.extractionOverrides?.supplierSku).toBeTrue();
    expect(() =>
      mergeListingMetadata(
        { supplierSku: null, extractionOverrides: { supplierSku: true } },
        { supplierSku: '001' },
        true,
      ),
    ).toThrowError(/vacío manualmente/);
  });
  it('no pierde referencias incompatibles al fusionar', () => {
    expect(() =>
      mergeListingMetadata({ supplierSku: 'A' }, { supplierSku: 'B' }, true),
    ).toThrowError(/diferentes/);
    expect(() =>
      mergeListingMetadata({ supplierSku: 'A' }, { supplierSku: 'A' }, false),
    ).toThrowError(/proveedores distintos/);
  });
});
