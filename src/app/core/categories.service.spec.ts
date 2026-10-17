import { signal } from '@angular/core';
import { CategoriesService, Category } from './categories.service';

describe('CategoriesService categorías equivalentes', () => {
  const root: Category = {
    id: 'hogar',
    name: 'Hogar',
    fullPath: 'Hogar',
    parentId: null,
    level: 0,
    active: true,
    order: 1,
  };
  const child: Category = {
    ...root,
    id: 'recamara',
    name: 'Recámara',
    fullPath: 'Hogar > Recámara',
    parentId: 'hogar',
    level: 1,
  };
  function service(): CategoriesService {
    // Avoid the constructor's network load; exercise actual domain/cache methods.
    const value = Object.create(CategoriesService.prototype) as CategoriesService;
    Object.assign(value, { allCategories: signal([root, child]), loaded: true });
    spyOn(value, 'listAllFromFirestore').and.resolveTo([root, child]);
    spyOn(value, 'loadCategories').and.resolveTo();
    return value;
  }
  it('busca y selecciona rutas ignorando acentos, mayúsculas y espacios', () => {
    const value = service();
    expect(value.getByPath(' HOGAR >  RECAMARA ')?.id).toBe('recamara');
    expect(value.search('  recamara  ').map((row) => row.id)).toEqual(['recamara']);
  });
  it('reutiliza la categoría equivalente bajo el mismo padre', async () => {
    const value = service();
    expect(await value.addCategory(' RECAMARA ', 'hogar')).toBe('recamara');
  });
  it('devuelve la ruta canónica al aceptar una propuesta equivalente sin duplicarla', async () => {
    const value = service();
    expect(await value.ensurePath(' hogar > recamara ')).toBe('Hogar > Recámara');
  });
});
