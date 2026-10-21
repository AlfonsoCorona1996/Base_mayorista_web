import { Category } from './categories.service';
import { searchCategories, sortCategories } from './category-ordering';

const cat = (fullPath: string, order = 1): Category => ({ id: fullPath, name: fullPath.split('>').at(-1)!.trim(), fullPath, parentId: null, level: 0, active: true, order });
describe('Orden y búsqueda de categorías', () => {
  it('mantiene padres e hijos juntos aunque el order global sea igual o distinto', () => {
    const rows = [cat('Ropa Interior > Mujer'), cat('Ropa > Niños > Playeras'), cat('Hogar > Baño'), cat('Ropa > Mujer'), cat('Ropa'), cat('Hogar'), cat('Ropa > Niños'), cat('Ropa > Niños > Conjuntos', 999)];
    expect(sortCategories(rows).map(row => row.fullPath)).toEqual(['Hogar', 'Hogar > Baño', 'Ropa', 'Ropa > Mujer', 'Ropa > Niños', 'Ropa > Niños > Conjuntos', 'Ropa > Niños > Playeras', 'Ropa Interior > Mujer']);
    expect(rows[0].fullPath).toBe('Ropa Interior > Mujer');
  });
  it('ordena nombres con acentos, minúsculas y números de forma natural', () => {
    const rows = ['Ropa > Niños > Talla 10', 'Ropa > Niños > conjuntos', 'Ropa > Niños > Talla 2', 'Ropa > Niños > Árbol'].map(path => cat(path));
    expect(sortCategories(rows).map(row => row.name)).toEqual(['Árbol', 'conjuntos', 'Talla 2', 'Talla 10']);
  });
  it('busca varias palabras en toda la ruta sin exigir su orden ni acentos', () => {
    const rows = ['Ropa > Niños > Conjuntos', 'Ropa > Mujer > Conjunto', 'Hogar > Recámara'].map(path => cat(path));
    expect(searchCategories(rows, 'conjunto nino').map(row => row.fullPath)).toEqual(['Ropa > Niños > Conjuntos']);
    expect(searchCategories(rows, '  RECAMARA hogar  ').length).toBe(1);
    expect(searchCategories(rows, 'no-existe')).toEqual([]);
  });
  it('no trunca resultados a las primeras diez categorías', () => {
    const rows = Array.from({ length: 35 }, (_, index) => cat(`Ropa > Tipo ${index}`));
    expect(searchCategories(rows, 'ropa').length).toBe(35);
  });
});
