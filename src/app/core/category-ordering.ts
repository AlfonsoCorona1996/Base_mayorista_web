import type { Category } from './categories.service';
import { normalizeSearch } from './listing-metadata';

const collator = new Intl.Collator('es', { sensitivity: 'base', numeric: true });

/** Compare each level so parents precede children and branches stay together. */
export function compareCategoryPaths(a: Category, b: Category): number {
  const left = a.fullPath.split('>').map(part => part.trim());
  const right = b.fullPath.split('>').map(part => part.trim());
  for (let index = 0; index < Math.min(left.length, right.length); index++) {
    const compared = collator.compare(left[index], right[index]);
    if (compared) return compared;
  }
  return left.length - right.length || collator.compare(a.id, b.id);
}

export function sortCategories(categories: Category[]): Category[] {
  return [...categories].sort(compareCategoryPaths);
}

export function searchCategories(categories: Category[], query: string): Category[] {
  const words = normalizeSearch(query).split(/[\s>]+/).filter(Boolean);
  if (!words.length) return sortCategories(categories);
  return sortCategories(categories.filter(category => {
    const path = normalizeSearch(category.fullPath);
    return words.every(word => path.includes(word));
  }));
}
