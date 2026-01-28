import { Injectable, signal } from "@angular/core";
import { collection, getDocs, query, where, orderBy, doc, setDoc, updateDoc, serverTimestamp } from "firebase/firestore";
import { FIRESTORE } from "./firebase.providers";

/**
 * Árbol de categorías estandarizado
 * Ahora carga desde Firestore collection "categories"
 */
export interface Category {
  id: string;
  name: string;        // Nombre corto (ej: "Cobertores")
  fullPath: string;    // Path completo (ej: "Hogar > Recámara > Cobertores")
  parentId: string | null;
  level: number;
  active: boolean;
  order: number;
  created_at?: any;
  updated_at?: any;
}

/**
 * Servicio de categorías
 * Carga desde Firestore y permite CRUD
 */
@Injectable({ providedIn: "root" })
export class CategoriesService {
  private allCategories = signal<Category[]>([]);
  private loaded = false;

  constructor() {
    // Cargar categorías al iniciar
    this.loadCategories();
  }

  /**
   * Carga categorías desde Firestore
   */
  async loadCategories(): Promise<void> {
    if (this.loaded) return;

    try {
      const colRef = collection(FIRESTORE, "categories");
      const q = query(
        colRef,
        where("active", "==", true),
        orderBy("order", "asc")
      );

      const snapshot = await getDocs(q);
      const cats: Category[] = snapshot.docs.map((doc) => ({
        id: doc.id,
        ...doc.data(),
      } as Category));

      this.allCategories.set(cats);
      this.loaded = true;
      console.log(`✅ Categorías cargadas: ${cats.length}`);
    } catch (error) {
      console.error("❌ Error cargando categorías desde Firestore:", error);
      // Fallback a categorías básicas
      this.loadFallbackCategories();
    }
  }

  /**
   * Categorías de respaldo si Firestore falla
   */
  private loadFallbackCategories() {
    console.warn("⚠️ Usando categorías de respaldo (hardcoded)");
    this.allCategories.set([
      { id: "hogar", name: "Hogar", fullPath: "Hogar", parentId: null, level: 0, active: true, order: 1 },
      { id: "hogar-recamara", name: "Recámara", fullPath: "Hogar > Recámara", parentId: "hogar", level: 1, active: true, order: 1 },
      { id: "hogar-recamara-cobertores", name: "Cobertores", fullPath: "Hogar > Recámara > Cobertores", parentId: "hogar-recamara", level: 2, active: true, order: 1 },
      { id: "ropa", name: "Ropa", fullPath: "Ropa", parentId: null, level: 0, active: true, order: 2 },
      { id: "ropa-mujer", name: "Mujer", fullPath: "Ropa > Mujer", parentId: "ropa", level: 1, active: true, order: 1 },
    ]);
    this.loaded = true;
  }

  /**
   * Busca categorías por texto
   * Útil para el autocomplete
   */
  search(query: string): Category[] {
    const all = this.allCategories();
    if (!query || query.trim().length === 0) {
      return all;
    }

    const q = query.toLowerCase().trim();
    return all.filter(
      (c) =>
        c.name.toLowerCase().includes(q) ||
        c.fullPath.toLowerCase().includes(q)
    );
  }

  /**
   * Obtiene categoría por fullPath
   */
  getByPath(fullPath: string): Category | null {
    return this.allCategories().find((c) => c.fullPath === fullPath) || null;
  }

  /**
   * Obtiene categoría por ID
   */
  getById(id: string): Category | null {
    return this.allCategories().find((c) => c.id === id) || null;
  }

  /**
   * Obtiene hijos de una categoría
   */
  getChildren(parentId: string): Category[] {
    return this.allCategories().filter((c) => c.parentId === parentId);
  }

  /**
   * Obtiene categorías raíz (nivel 0)
   */
  getRoots(): Category[] {
    return this.allCategories().filter((c) => c.level === 0);
  }

  /**
   * Obtiene todas las categorías
   */
  getAll(): Category[] {
    return this.allCategories();
  }

  /**
   * Agrega una nueva categoría
   */
  async addCategory(
    name: string,
    parentId: string | null
  ): Promise<void> {
    const parent = parentId ? this.getById(parentId) : null;
    const level = parent ? parent.level + 1 : 0;
    const fullPath = parent ? `${parent.fullPath} > ${name}` : name;

    // Generar ID único
    const id = name.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "");
    const finalId = parentId ? `${parentId}-${id}` : id;

    const category: Category = {
      id: finalId,
      name,
      fullPath,
      parentId,
      level,
      active: true,
      order: 999, // Se puede ajustar después
      created_at: serverTimestamp(),
      updated_at: serverTimestamp(),
    };

    const docRef = doc(FIRESTORE, "categories", finalId);
    await setDoc(docRef, category);

    // Recargar categorías
    this.loaded = false;
    await this.loadCategories();
  }

  /**
   * Actualiza una categoría existente
   */
  async updateCategory(
    id: string,
    updates: Partial<Category>
  ): Promise<void> {
    const docRef = doc(FIRESTORE, "categories", id);
    await updateDoc(docRef, {
      ...updates,
      updated_at: serverTimestamp(),
    });

    // Recargar categorías
    this.loaded = false;
    await this.loadCategories();
  }

  /**
   * Desactiva una categoría (soft delete)
   */
  async deactivateCategory(id: string): Promise<void> {
    await this.updateCategory(id, { active: false });
  }
}
