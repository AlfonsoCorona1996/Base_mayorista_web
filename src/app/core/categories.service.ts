import { Injectable, signal } from "@angular/core";
import {
  collection,
  doc,
  getDocs,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
  writeBatch,
} from "firebase/firestore";
import { FIRESTORE } from "./firebase.providers";

export interface Category {
  id: string;
  name: string;
  fullPath: string;
  parentId: string | null;
  level: number;
  active: boolean;
  order: number;
  created_at?: any;
  updated_at?: any;
}

interface CategoryEditInput {
  name: string;
  parentId: string | null;
  order?: number;
}

@Injectable({ providedIn: "root" })
export class CategoriesService {
  private allCategories = signal<Category[]>([]);
  private loaded = false;

  constructor() {
    this.loadCategories();
  }

  async loadCategories(): Promise<void> {
    if (this.loaded) return;

    try {
      const colRef = collection(FIRESTORE, "categories");
      const q = query(colRef, where("active", "==", true), orderBy("order", "asc"));
      const snapshot = await getDocs(q);
      const cats = snapshot.docs.map((entry) => this.normalizeCategory(entry.data() as Partial<Category>, entry.id));

      this.allCategories.set(cats);
      this.loaded = true;
    } catch (error) {
      console.error("Error cargando categorias desde Firestore:", error);
      this.loadFallbackCategories();
    }
  }

  async listAllFromFirestore(): Promise<Category[]> {
    const colRef = collection(FIRESTORE, "categories");
    const q = query(colRef, orderBy("fullPath", "asc"));
    const snapshot = await getDocs(q);

    return snapshot.docs.map((entry) => this.normalizeCategory(entry.data() as Partial<Category>, entry.id));
  }

  search(searchQuery: string): Category[] {
    const all = this.allCategories();
    if (!searchQuery || searchQuery.trim().length === 0) return all;

    const q = searchQuery.toLowerCase().trim();
    return all.filter((category) => category.name.toLowerCase().includes(q) || category.fullPath.toLowerCase().includes(q));
  }

  getByPath(fullPath: string): Category | null {
    return this.allCategories().find((category) => category.fullPath === fullPath) || null;
  }

  getById(id: string): Category | null {
    return this.allCategories().find((category) => category.id === id) || null;
  }

  getChildren(parentId: string): Category[] {
    return this.allCategories().filter((category) => category.parentId === parentId);
  }

  getRoots(): Category[] {
    return this.allCategories().filter((category) => category.level === 0);
  }

  getAll(): Category[] {
    return this.allCategories();
  }

  async addCategory(name: string, parentId: string | null): Promise<string> {
    const nextName = name.trim();
    if (!nextName) throw new Error("El nombre de categoria es obligatorio");

    const all = await this.listAllFromFirestore();
    const existingIds = new Set(all.map((category) => category.id));
    const parent = parentId ? all.find((category) => category.id === parentId) || null : null;

    if (parentId && !parent) {
      throw new Error("La categoria padre no existe");
    }

    const level = parent ? parent.level + 1 : 0;
    const fullPath = parent ? `${parent.fullPath} > ${nextName}` : nextName;

    const slug = this.slugify(nextName) || "categoria";
    const candidate = parentId ? `${parentId}-${slug}` : slug;
    const finalId = this.ensureUniqueId(candidate, existingIds);

    const payload: Category = {
      id: finalId,
      name: nextName,
      fullPath,
      parentId,
      level,
      active: true,
      order: 999,
      created_at: serverTimestamp(),
      updated_at: serverTimestamp(),
    };

    await setDoc(doc(FIRESTORE, "categories", finalId), payload);
    await this.refreshCache();
    return finalId;
  }

  async updateCategory(id: string, updates: Partial<Category>): Promise<void> {
    const docRef = doc(FIRESTORE, "categories", id);
    await updateDoc(docRef, {
      ...updates,
      updated_at: serverTimestamp(),
    });

    await this.refreshCache();
  }

  async editCategory(id: string, input: CategoryEditInput): Promise<void> {
    const all = await this.listAllFromFirestore();
    const byId = new Map(all.map((category) => [category.id, category]));
    const current = byId.get(id);

    if (!current) throw new Error("Categoria no encontrada");

    const nextName = input.name.trim();
    if (!nextName) throw new Error("El nombre de categoria es obligatorio");

    const nextParentId = input.parentId || null;
    const childrenMap = this.buildChildrenMap(all);
    const descendants = this.collectDescendantIds(id, childrenMap);

    if (nextParentId === id) {
      throw new Error("Una categoria no puede ser su propio padre");
    }

    if (nextParentId && descendants.has(nextParentId)) {
      throw new Error("No puedes mover una categoria dentro de su propio arbol");
    }

    const parent = nextParentId ? byId.get(nextParentId) || null : null;
    if (nextParentId && !parent) {
      throw new Error("La categoria padre seleccionada no existe");
    }

    const nextLevel = parent ? parent.level + 1 : 0;
    const nextFullPath = parent ? `${parent.fullPath} > ${nextName}` : nextName;
    const nextOrder =
      typeof input.order === "number" && Number.isFinite(input.order)
        ? Math.max(0, Math.round(input.order))
        : current.order;

    const computedTree = new Map<string, { fullPath: string; level: number }>();
    computedTree.set(id, { fullPath: nextFullPath, level: nextLevel });

    const queue: string[] = [id];
    while (queue.length > 0) {
      const currentParentId = queue.shift()!;
      const currentParent = computedTree.get(currentParentId);
      if (!currentParent) continue;

      const children = childrenMap.get(currentParentId) || [];
      for (const child of children) {
        computedTree.set(child.id, {
          fullPath: `${currentParent.fullPath} > ${child.name}`,
          level: currentParent.level + 1,
        });
        queue.push(child.id);
      }
    }

    const batch = writeBatch(FIRESTORE);
    const now = serverTimestamp();

    for (const [categoryId, info] of computedTree.entries()) {
      const ref = doc(FIRESTORE, "categories", categoryId);
      if (categoryId === id) {
        batch.update(ref, {
          name: nextName,
          parentId: nextParentId,
          order: nextOrder,
          fullPath: info.fullPath,
          level: info.level,
          updated_at: now,
        });
      } else {
        batch.update(ref, {
          fullPath: info.fullPath,
          level: info.level,
          updated_at: now,
        });
      }
    }

    await batch.commit();
    await this.refreshCache();
  }

  async deactivateCategory(id: string): Promise<void> {
    await this.updateCategory(id, { active: false });
  }

  private loadFallbackCategories() {
    this.allCategories.set([
      {
        id: "hogar",
        name: "Hogar",
        fullPath: "Hogar",
        parentId: null,
        level: 0,
        active: true,
        order: 1,
      },
      {
        id: "hogar-recamara",
        name: "Recamara",
        fullPath: "Hogar > Recamara",
        parentId: "hogar",
        level: 1,
        active: true,
        order: 1,
      },
      {
        id: "hogar-recamara-cobertores",
        name: "Cobertores",
        fullPath: "Hogar > Recamara > Cobertores",
        parentId: "hogar-recamara",
        level: 2,
        active: true,
        order: 1,
      },
      {
        id: "ropa",
        name: "Ropa",
        fullPath: "Ropa",
        parentId: null,
        level: 0,
        active: true,
        order: 2,
      },
      {
        id: "ropa-mujer",
        name: "Mujer",
        fullPath: "Ropa > Mujer",
        parentId: "ropa",
        level: 1,
        active: true,
        order: 1,
      },
    ]);
    this.loaded = true;
  }

  private buildChildrenMap(categories: Category[]): Map<string, Category[]> {
    const map = new Map<string, Category[]>();

    for (const category of categories) {
      if (!category.parentId) continue;
      const row = map.get(category.parentId) || [];
      row.push(category);
      map.set(category.parentId, row);
    }

    return map;
  }

  private collectDescendantIds(rootId: string, childrenMap: Map<string, Category[]>): Set<string> {
    const visited = new Set<string>();
    const queue: string[] = [rootId];

    while (queue.length > 0) {
      const currentId = queue.shift()!;
      const children = childrenMap.get(currentId) || [];
      for (const child of children) {
        if (visited.has(child.id)) continue;
        visited.add(child.id);
        queue.push(child.id);
      }
    }

    return visited;
  }

  private normalizeCategory(data: Partial<Category>, docId: string): Category {
    const name = (data.name || docId).toString().trim();
    const fullPath = (data.fullPath || name).toString().trim();
    const level = typeof data.level === "number" && Number.isFinite(data.level) ? data.level : 0;
    const order = typeof data.order === "number" && Number.isFinite(data.order) ? data.order : 999;

    return {
      id: docId,
      name,
      fullPath,
      parentId: typeof data.parentId === "string" && data.parentId.trim().length > 0 ? data.parentId.trim() : null,
      level,
      active: data.active ?? true,
      order,
      created_at: data.created_at,
      updated_at: data.updated_at,
    };
  }

  private ensureUniqueId(candidate: string, existingIds: Set<string>): string {
    if (!existingIds.has(candidate)) return candidate;

    let index = 2;
    while (existingIds.has(`${candidate}-${index}`)) {
      index += 1;
    }

    return `${candidate}-${index}`;
  }

  private slugify(value: string): string {
    return value
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
  }

  private async refreshCache() {
    this.loaded = false;
    await this.loadCategories();
  }
}

