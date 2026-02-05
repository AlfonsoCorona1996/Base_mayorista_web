import { Component, computed, inject, signal } from "@angular/core";
import { FormsModule } from "@angular/forms";
import { CategoriesService, Category } from "../../core/categories.service";

interface TreeRow {
  category: Category;
  depth: number;
  hasChildren: boolean;
  expanded: boolean;
  childCount: number;
}

@Component({
  standalone: true,
  selector: "app-categorias",
  imports: [FormsModule],
  templateUrl: "./categorias.html",
  styleUrl: "./categorias.css",
})
export default class CategoriasPage {
  loading = signal(false);
  saving = signal(false);
  togglingId = signal<string | null>(null);
  error = signal<string | null>(null);
  success = signal<string | null>(null);

  searchTerm = signal("");
  showInactive = signal(false);

  selectedCategoryId = signal<string | null>(null);
  editingId = signal<string | null>(null);
  expandedMap = signal<Record<string, boolean>>({});

  categories = signal<Category[]>([]);

  formName = "";
  formParentId = "";
  formOrder = 1;

  private categoriesService = inject(CategoriesService);

  constructor() {
    this.reload();
  }

  isEditing = computed(() => this.editingId() !== null);

  totalCount = computed(() => this.categories().length);
  visibleCount = computed(() => this.visibleCategories().length);

  rootCount = computed(() => this.categories().filter((category) => !category.parentId).length);

  maxDepth = computed(() => this.categories().reduce((max, category) => Math.max(max, category.level), 0));

  visibleCategories = computed(() => {
    const includeInactive = this.showInactive();
    return this.categories().filter((category) => includeInactive || category.active);
  });

  categoryById = computed(() => new Map(this.categories().map((category) => [category.id, category])));

  childrenMap = computed(() => {
    const map = new Map<string, Category[]>();

    for (const category of this.visibleCategories()) {
      const key = category.parentId || "__root__";
      const list = map.get(key) || [];
      list.push(category);
      map.set(key, list);
    }

    for (const [key, list] of map.entries()) {
      map.set(key, this.sortCategories(list));
    }

    return map;
  });

  treeRows = computed<TreeRow[]>(() => {
    const rows: TreeRow[] = [];
    const map = this.childrenMap();
    const expanded = this.expandedMap();

    const walk = (parentId: string | null, depth: number) => {
      const children = map.get(parentId || "__root__") || [];
      for (const category of children) {
        const directChildren = map.get(category.id) || [];
        const hasChildren = directChildren.length > 0;
        const isExpanded = hasChildren && Boolean(expanded[category.id]);

        rows.push({
          category,
          depth,
          hasChildren,
          expanded: isExpanded,
          childCount: directChildren.length,
        });

        if (hasChildren && isExpanded) {
          walk(category.id, depth + 1);
        }
      }
    };

    walk(null, 0);
    return rows;
  });

  searchResults = computed(() => {
    const term = this.searchTerm().trim().toLowerCase();
    if (term.length < 2) return [];

    return [...this.visibleCategories()]
      .filter((category) => {
        const blob = `${category.name} ${category.fullPath} ${category.id}`.toLowerCase();
        return blob.includes(term);
      })
      .sort((a, b) => a.fullPath.localeCompare(b.fullPath, "es", { sensitivity: "base" }))
      .slice(0, 15);
  });

  selectedCategory = computed(() => {
    const id = this.selectedCategoryId();
    if (!id) return null;
    return this.categoryById().get(id) || null;
  });

  selectedChildren = computed(() => {
    const selected = this.selectedCategory();
    if (!selected) return [];
    return this.childrenMap().get(selected.id) || [];
  });

  availableParentOptions = computed(() => {
    const editingId = this.editingId();
    const rows = this.sortCategories(this.categories().filter((category) => category.active));

    if (!editingId) return rows;

    const forbidden = this.collectDescendantIds(editingId, this.categories());
    forbidden.add(editingId);

    return rows.filter((category) => !forbidden.has(category.id));
  });

  async reload() {
    this.loading.set(true);
    this.error.set(null);

    try {
      const rows = await this.categoriesService.listAllFromFirestore();
      this.categories.set(rows);
      this.ensureDefaultExpandedRoots();
      this.ensureValidSelection();
    } catch (error: any) {
      this.error.set(error?.message || "No se pudieron cargar las categorias");
    } finally {
      this.loading.set(false);
    }
  }

  onShowInactiveChange(nextValue: boolean) {
    this.showInactive.set(Boolean(nextValue));
    this.ensureDefaultExpandedRoots();
    this.ensureValidSelection();
  }

  expandAllVisible() {
    const map = this.childrenMap();
    const next: Record<string, boolean> = {};

    for (const category of this.visibleCategories()) {
      if ((map.get(category.id) || []).length > 0) {
        next[category.id] = true;
      }
    }

    this.expandedMap.set(next);
  }

  collapseAllVisible() {
    this.expandedMap.set({});
    const selectedId = this.selectedCategoryId();
    if (selectedId) {
      this.expandAncestors(selectedId);
    }
  }

  toggleExpanded(categoryId: string, event?: Event) {
    event?.stopPropagation();
    this.expandedMap.update((current) => ({
      ...current,
      [categoryId]: !current[categoryId],
    }));
  }

  selectCategory(categoryId: string) {
    const category = this.categoryById().get(categoryId);
    if (!category) return;

    this.selectedCategoryId.set(categoryId);
    this.expandAncestors(categoryId);

    const hasChildren = this.childCount(categoryId) > 0;
    if (hasChildren) {
      this.expandedMap.update((current) => ({ ...current, [categoryId]: true }));
    }

    this.startEdit(category);
  }

  selectFromSearch(categoryId: string) {
    this.selectCategory(categoryId);
    this.searchTerm.set("");
  }

  startCreateRoot() {
    this.startCreate(null);
  }

  startCreateChild() {
    const selected = this.selectedCategory();
    if (!selected) {
      this.startCreate(null);
      return;
    }
    this.startCreate(selected.id);
  }

  private startCreate(parentId: string | null) {
    this.editingId.set(null);
    this.formName = "";
    this.formParentId = parentId || "";
    this.formOrder = this.suggestedOrder(parentId);
    this.error.set(null);
    this.success.set(null);
  }

  startEdit(category: Category) {
    this.editingId.set(category.id);
    this.formName = category.name;
    this.formParentId = category.parentId || "";
    this.formOrder = this.normalizeOrder(category.order);
    this.error.set(null);
    this.success.set(null);
  }

  async saveCategory() {
    this.error.set(null);
    this.success.set(null);

    const name = this.formName.trim();
    if (!name) {
      this.error.set("El nombre de categoria es obligatorio");
      return;
    }

    const parentId = this.formParentId.trim() || null;
    const order = this.normalizeOrder(this.formOrder);

    this.saving.set(true);

    try {
      const editingId = this.editingId();

      if (editingId) {
        await this.categoriesService.editCategory(editingId, {
          name,
          parentId,
          order,
        });

        await this.reload();
        this.selectCategory(editingId);
        this.success.set("Categoria actualizada");
      } else {
        const newId = await this.categoriesService.addCategory(name, parentId);
        await this.reload();
        this.selectCategory(newId);
        this.success.set("Categoria creada");
      }
    } catch (error: any) {
      this.error.set(error?.message || "No se pudo guardar la categoria");
    } finally {
      this.saving.set(false);
    }
  }

  async toggleSelectedActive(nextActive: boolean) {
    const selected = this.selectedCategory();
    if (!selected || selected.active === nextActive) return;

    this.togglingId.set(selected.id);
    this.error.set(null);
    this.success.set(null);

    try {
      await this.categoriesService.updateCategory(selected.id, { active: nextActive });
      await this.reload();
      this.selectCategory(selected.id);
      this.success.set(nextActive ? "Categoria activada" : "Categoria desactivada");
    } catch (error: any) {
      this.error.set(error?.message || "No se pudo actualizar el estado");
    } finally {
      this.togglingId.set(null);
    }
  }

  isBusy(categoryId: string): boolean {
    return this.togglingId() === categoryId;
  }

  childCount(categoryId: string): number {
    return (this.childrenMap().get(categoryId) || []).length;
  }

  private ensureDefaultExpandedRoots() {
    const roots = this.sortCategories(this.visibleCategories().filter((category) => !category.parentId));
    this.expandedMap.update((current) => {
      const next = { ...current };
      const firstRootId = roots[0]?.id || null;

      for (const root of roots) {
        if (typeof next[root.id] === "undefined") {
          next[root.id] = root.id === firstRootId;
        }
      }
      return next;
    });
  }

  private ensureValidSelection() {
    const currentId = this.selectedCategoryId();
    const visibleIds = new Set(this.visibleCategories().map((category) => category.id));

    if (currentId && visibleIds.has(currentId)) {
      return;
    }

    const fallback = this.sortCategories(this.visibleCategories().filter((category) => !category.parentId))[0] || null;

    if (!fallback) {
      this.selectedCategoryId.set(null);
      this.startCreateRoot();
      return;
    }

    this.selectCategory(fallback.id);
  }

  private expandAncestors(categoryId: string) {
    const map = this.categoryById();
    this.expandedMap.update((current) => {
      const next = { ...current };
      let cursor = map.get(categoryId)?.parentId || null;

      while (cursor) {
        next[cursor] = true;
        cursor = map.get(cursor)?.parentId || null;
      }

      return next;
    });
  }

  private suggestedOrder(parentId: string | null): number {
    const siblings = this.categories().filter((category) => (category.parentId || null) === parentId);
    if (siblings.length === 0) return 1;

    const maxOrder = Math.max(...siblings.map((category) => this.normalizeOrder(category.order)));
    return maxOrder + 1;
  }

  private collectDescendantIds(rootId: string, rows: Category[]): Set<string> {
    const byParent = new Map<string, string[]>();

    for (const category of rows) {
      if (!category.parentId) continue;
      const children = byParent.get(category.parentId) || [];
      children.push(category.id);
      byParent.set(category.parentId, children);
    }

    const out = new Set<string>();
    const queue: string[] = [rootId];

    while (queue.length > 0) {
      const currentId = queue.shift()!;
      const children = byParent.get(currentId) || [];

      for (const childId of children) {
        if (out.has(childId)) continue;
        out.add(childId);
        queue.push(childId);
      }
    }

    return out;
  }

  private sortCategories(rows: Category[]): Category[] {
    return [...rows].sort((a, b) => {
      const orderDiff = this.normalizeOrder(a.order) - this.normalizeOrder(b.order);
      if (orderDiff !== 0) return orderDiff;
      return a.name.localeCompare(b.name, "es", { sensitivity: "base" });
    });
  }

  private normalizeOrder(value: number): number {
    if (!Number.isFinite(value)) return 999;
    return Math.max(0, Math.round(value));
  }
}
