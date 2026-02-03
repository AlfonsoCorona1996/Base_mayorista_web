/**
 * Lista completa de categorías para el catálogo
 * Estructura jerárquica: Categoría > Subcategoría > Especialidad
 */

export interface CategoryNode {
  id: string;
  name: string;
  fullPath: string;
  level: number;
  parentId: string | null;
  children?: CategoryNode[];
  active: boolean;
  order: number;
}

export const CATEGORIES_TREE: CategoryNode[] = [
  // ============================================================================
  // ROPA Y MODA
  // ============================================================================
  {
    id: "ropa",
    name: "Ropa",
    fullPath: "Ropa",
    level: 0,
    parentId: null,
    active: true,
    order: 1,
    children: [
      {
        id: "ropa-mujer",
        name: "Mujer",
        fullPath: "Ropa > Mujer",
        level: 1,
        parentId: "ropa",
        active: true,
        order: 1,
        children: [
          { id: "ropa-mujer-blusas", name: "Blusas", fullPath: "Ropa > Mujer > Blusas", level: 2, parentId: "ropa-mujer", active: true, order: 1 },
          { id: "ropa-mujer-playeras", name: "Playeras", fullPath: "Ropa > Mujer > Playeras", level: 2, parentId: "ropa-mujer", active: true, order: 2 },
          { id: "ropa-mujer-pants", name: "Pants", fullPath: "Ropa > Mujer > Pants", level: 2, parentId: "ropa-mujer", active: true, order: 3 },
          { id: "ropa-mujer-leggings", name: "Leggings", fullPath: "Ropa > Mujer > Leggings", level: 2, parentId: "ropa-mujer", active: true, order: 4 },
          { id: "ropa-mujer-mallas", name: "Mallas", fullPath: "Ropa > Mujer > Mallas", level: 2, parentId: "ropa-mujer", active: true, order: 5 },
          { id: "ropa-mujer-jeans", name: "Jeans", fullPath: "Ropa > Mujer > Jeans", level: 2, parentId: "ropa-mujer", active: true, order: 6 },
          { id: "ropa-mujer-faldas", name: "Faldas", fullPath: "Ropa > Mujer > Faldas", level: 2, parentId: "ropa-mujer", active: true, order: 7 },
          { id: "ropa-mujer-vestidos", name: "Vestidos", fullPath: "Ropa > Mujer > Vestidos", level: 2, parentId: "ropa-mujer", active: true, order: 8 },
          { id: "ropa-mujer-shorts", name: "Shorts", fullPath: "Ropa > Mujer > Shorts", level: 2, parentId: "ropa-mujer", active: true, order: 9 },
          { id: "ropa-mujer-sueteres", name: "Suéteres", fullPath: "Ropa > Mujer > Suéteres", level: 2, parentId: "ropa-mujer", active: true, order: 10 },
          { id: "ropa-mujer-chamarras", name: "Chamarras", fullPath: "Ropa > Mujer > Chamarras", level: 2, parentId: "ropa-mujer", active: true, order: 11 },
        ]
      },
      {
        id: "ropa-hombre",
        name: "Hombre",
        fullPath: "Ropa > Hombre",
        level: 1,
        parentId: "ropa",
        active: true,
        order: 2,
        children: [
          { id: "ropa-hombre-camisas", name: "Camisas", fullPath: "Ropa > Hombre > Camisas", level: 2, parentId: "ropa-hombre", active: true, order: 1 },
          { id: "ropa-hombre-playeras", name: "Playeras", fullPath: "Ropa > Hombre > Playeras", level: 2, parentId: "ropa-hombre", active: true, order: 2 },
          { id: "ropa-hombre-pants", name: "Pants", fullPath: "Ropa > Hombre > Pants", level: 2, parentId: "ropa-hombre", active: true, order: 3 },
          { id: "ropa-hombre-jeans", name: "Jeans", fullPath: "Ropa > Hombre > Jeans", level: 2, parentId: "ropa-hombre", active: true, order: 4 },
          { id: "ropa-hombre-shorts", name: "Shorts", fullPath: "Ropa > Hombre > Shorts", level: 2, parentId: "ropa-hombre", active: true, order: 5 },
          { id: "ropa-hombre-sueteres", name: "Suéteres", fullPath: "Ropa > Hombre > Suéteres", level: 2, parentId: "ropa-hombre", active: true, order: 6 },
          { id: "ropa-hombre-chamarras", name: "Chamarras", fullPath: "Ropa > Hombre > Chamarras", level: 2, parentId: "ropa-hombre", active: true, order: 7 },
        ]
      },
      {
        id: "ropa-ninos",
        name: "Niños",
        fullPath: "Ropa > Niños",
        level: 1,
        parentId: "ropa",
        active: true,
        order: 3,
        children: [
          { id: "ropa-ninos-playeras", name: "Playeras", fullPath: "Ropa > Niños > Playeras", level: 2, parentId: "ropa-ninos", active: true, order: 1 },
          { id: "ropa-ninos-pants", name: "Pants", fullPath: "Ropa > Niños > Pants", level: 2, parentId: "ropa-ninos", active: true, order: 2 },
          { id: "ropa-ninos-vestidos", name: "Vestidos", fullPath: "Ropa > Niños > Vestidos", level: 2, parentId: "ropa-ninos", active: true, order: 3 },
          { id: "ropa-ninos-conjuntos", name: "Conjuntos", fullPath: "Ropa > Niños > Conjuntos", level: 2, parentId: "ropa-ninos", active: true, order: 4 },
        ]
      },
    ]
  },

  // ============================================================================
  // ROPA INTERIOR Y LENCERÍA
  // ============================================================================
  {
    id: "ropa-interior",
    name: "Ropa Interior",
    fullPath: "Ropa Interior",
    level: 0,
    parentId: null,
    active: true,
    order: 2,
    children: [
      {
        id: "ropa-interior-mujer",
        name: "Mujer",
        fullPath: "Ropa Interior > Mujer",
        level: 1,
        parentId: "ropa-interior",
        active: true,
        order: 1,
        children: [
          { id: "ropa-interior-mujer-brassieres", name: "Brassieres", fullPath: "Ropa Interior > Mujer > Brassieres", level: 2, parentId: "ropa-interior-mujer", active: true, order: 1 },
          { id: "ropa-interior-mujer-pantaletas", name: "Pantaletas", fullPath: "Ropa Interior > Mujer > Pantaletas", level: 2, parentId: "ropa-interior-mujer", active: true, order: 2 },
          { id: "ropa-interior-mujer-conjuntos", name: "Conjuntos", fullPath: "Ropa Interior > Mujer > Conjuntos", level: 2, parentId: "ropa-interior-mujer", active: true, order: 3 },
          { id: "ropa-interior-mujer-fajas", name: "Fajas", fullPath: "Ropa Interior > Mujer > Fajas", level: 2, parentId: "ropa-interior-mujer", active: true, order: 4 },
          { id: "ropa-interior-mujer-bodys", name: "Bodys", fullPath: "Ropa Interior > Mujer > Bodys", level: 2, parentId: "ropa-interior-mujer", active: true, order: 5 },
          { id: "ropa-interior-mujer-lenceria", name: "Lencería", fullPath: "Ropa Interior > Mujer > Lencería", level: 2, parentId: "ropa-interior-mujer", active: true, order: 6 },
        ]
      },
      {
        id: "ropa-interior-hombre",
        name: "Hombre",
        fullPath: "Ropa Interior > Hombre",
        level: 1,
        parentId: "ropa-interior",
        active: true,
        order: 2,
        children: [
          { id: "ropa-interior-hombre-boxers", name: "Boxers", fullPath: "Ropa Interior > Hombre > Boxers", level: 2, parentId: "ropa-interior-hombre", active: true, order: 1 },
          { id: "ropa-interior-hombre-calzoncillos", name: "Calzoncillos", fullPath: "Ropa Interior > Hombre > Calzoncillos", level: 2, parentId: "ropa-interior-hombre", active: true, order: 2 },
          { id: "ropa-interior-hombre-camisetas", name: "Camisetas", fullPath: "Ropa Interior > Hombre > Camisetas", level: 2, parentId: "ropa-interior-hombre", active: true, order: 3 },
        ]
      },
    ]
  },

  // ============================================================================
  // CALZADO
  // ============================================================================
  {
    id: "calzado",
    name: "Calzado",
    fullPath: "Calzado",
    level: 0,
    parentId: null,
    active: true,
    order: 3,
    children: [
      { id: "calzado-tenis", name: "Tenis", fullPath: "Calzado > Tenis", level: 1, parentId: "calzado", active: true, order: 1 },
      { id: "calzado-zapatos", name: "Zapatos", fullPath: "Calzado > Zapatos", level: 1, parentId: "calzado", active: true, order: 2 },
      { id: "calzado-sandalias", name: "Sandalias", fullPath: "Calzado > Sandalias", level: 1, parentId: "calzado", active: true, order: 3 },
      { id: "calzado-botas", name: "Botas", fullPath: "Calzado > Botas", level: 1, parentId: "calzado", active: true, order: 4 },
      { id: "calzado-pantuflas", name: "Pantuflas", fullPath: "Calzado > Pantuflas", level: 1, parentId: "calzado", active: true, order: 5 },
    ]
  },

  // ============================================================================
  // ACCESORIOS
  // ============================================================================
  {
    id: "accesorios",
    name: "Accesorios",
    fullPath: "Accesorios",
    level: 0,
    parentId: null,
    active: true,
    order: 4,
    children: [
      { id: "accesorios-bolsas", name: "Bolsas", fullPath: "Accesorios > Bolsas", level: 1, parentId: "accesorios", active: true, order: 1 },
      { id: "accesorios-carteras", name: "Carteras", fullPath: "Accesorios > Carteras", level: 1, parentId: "accesorios", active: true, order: 2 },
      { id: "accesorios-mochilas", name: "Mochilas", fullPath: "Accesorios > Mochilas", level: 1, parentId: "accesorios", active: true, order: 3 },
      { id: "accesorios-cinturones", name: "Cinturones", fullPath: "Accesorios > Cinturones", level: 1, parentId: "accesorios", active: true, order: 4 },
      { id: "accesorios-gorras", name: "Gorras", fullPath: "Accesorios > Gorras", level: 1, parentId: "accesorios", active: true, order: 5 },
      { id: "accesorios-sombreros", name: "Sombreros", fullPath: "Accesorios > Sombreros", level: 1, parentId: "accesorios", active: true, order: 6 },
      { id: "accesorios-lentes", name: "Lentes", fullPath: "Accesorios > Lentes", level: 1, parentId: "accesorios", active: true, order: 7 },
      { id: "accesorios-joyeria", name: "Joyería", fullPath: "Accesorios > Joyería", level: 1, parentId: "accesorios", active: true, order: 8 },
      { id: "accesorios-bufandas", name: "Bufandas", fullPath: "Accesorios > Bufandas", level: 1, parentId: "accesorios", active: true, order: 9 },
    ]
  },

  // ============================================================================
  // HOGAR
  // ============================================================================
  {
    id: "hogar",
    name: "Hogar",
    fullPath: "Hogar",
    level: 0,
    parentId: null,
    active: true,
    order: 5,
    children: [
      {
        id: "hogar-recamara",
        name: "Recámara",
        fullPath: "Hogar > Recámara",
        level: 1,
        parentId: "hogar",
        active: true,
        order: 1,
        children: [
          { id: "hogar-recamara-cobertores", name: "Cobertores", fullPath: "Hogar > Recámara > Cobertores", level: 2, parentId: "hogar-recamara", active: true, order: 1 },
          { id: "hogar-recamara-edredones", name: "Edredones", fullPath: "Hogar > Recámara > Edredones", level: 2, parentId: "hogar-recamara", active: true, order: 2 },
          { id: "hogar-recamara-sabanas", name: "Sábanas", fullPath: "Hogar > Recámara > Sábanas", level: 2, parentId: "hogar-recamara", active: true, order: 3 },
          { id: "hogar-recamara-fundas", name: "Fundas", fullPath: "Hogar > Recámara > Fundas", level: 2, parentId: "hogar-recamara", active: true, order: 4 },
          { id: "hogar-recamara-almohadas", name: "Almohadas", fullPath: "Hogar > Recámara > Almohadas", level: 2, parentId: "hogar-recamara", active: true, order: 5 },
          { id: "hogar-recamara-colchonetas", name: "Colchonetas", fullPath: "Hogar > Recámara > Colchonetas", level: 2, parentId: "hogar-recamara", active: true, order: 6 },
        ]
      },
      {
        id: "hogar-bano",
        name: "Baño",
        fullPath: "Hogar > Baño",
        level: 1,
        parentId: "hogar",
        active: true,
        order: 2,
        children: [
          { id: "hogar-bano-toallas", name: "Toallas", fullPath: "Hogar > Baño > Toallas", level: 2, parentId: "hogar-bano", active: true, order: 1 },
          { id: "hogar-bano-toallones", name: "Toallones", fullPath: "Hogar > Baño > Toallones", level: 2, parentId: "hogar-bano", active: true, order: 2 },
          { id: "hogar-bano-cortinas", name: "Cortinas de baño", fullPath: "Hogar > Baño > Cortinas de baño", level: 2, parentId: "hogar-bano", active: true, order: 3 },
          { id: "hogar-bano-tapetes", name: "Tapetes", fullPath: "Hogar > Baño > Tapetes", level: 2, parentId: "hogar-bano", active: true, order: 4 },
          { id: "hogar-bano-organizadores", name: "Organizadores", fullPath: "Hogar > Baño > Organizadores", level: 2, parentId: "hogar-bano", active: true, order: 5 },
        ]
      },
      {
        id: "hogar-cocina",
        name: "Cocina",
        fullPath: "Hogar > Cocina",
        level: 1,
        parentId: "hogar",
        active: true,
        order: 3,
        children: [
          { id: "hogar-cocina-manteles", name: "Manteles", fullPath: "Hogar > Cocina > Manteles", level: 2, parentId: "hogar-cocina", active: true, order: 1 },
          { id: "hogar-cocina-individuales", name: "Individuales", fullPath: "Hogar > Cocina > Individuales", level: 2, parentId: "hogar-cocina", active: true, order: 2 },
          { id: "hogar-cocina-paños", name: "Paños", fullPath: "Hogar > Cocina > Paños", level: 2, parentId: "hogar-cocina", active: true, order: 3 },
          { id: "hogar-cocina-delantales", name: "Delantales", fullPath: "Hogar > Cocina > Delantales", level: 2, parentId: "hogar-cocina", active: true, order: 4 },
          { id: "hogar-cocina-organizadores", name: "Organizadores", fullPath: "Hogar > Cocina > Organizadores", level: 2, parentId: "hogar-cocina", active: true, order: 5 },
        ]
      },
      {
        id: "hogar-sala",
        name: "Sala",
        fullPath: "Hogar > Sala",
        level: 1,
        parentId: "hogar",
        active: true,
        order: 4,
        children: [
          { id: "hogar-sala-cojines", name: "Cojines", fullPath: "Hogar > Sala > Cojines", level: 2, parentId: "hogar-sala", active: true, order: 1 },
          { id: "hogar-sala-fundas", name: "Fundas", fullPath: "Hogar > Sala > Fundas", level: 2, parentId: "hogar-sala", active: true, order: 2 },
          { id: "hogar-sala-cortinas", name: "Cortinas", fullPath: "Hogar > Sala > Cortinas", level: 2, parentId: "hogar-sala", active: true, order: 3 },
          { id: "hogar-sala-tapetes", name: "Tapetes", fullPath: "Hogar > Sala > Tapetes", level: 2, parentId: "hogar-sala", active: true, order: 4 },
        ]
      },
      {
        id: "hogar-organizacion",
        name: "Organización",
        fullPath: "Hogar > Organización",
        level: 1,
        parentId: "hogar",
        active: true,
        order: 5,
        children: [
          { id: "hogar-organizacion-cajas", name: "Cajas", fullPath: "Hogar > Organización > Cajas", level: 2, parentId: "hogar-organizacion", active: true, order: 1 },
          { id: "hogar-organizacion-canastos", name: "Canastos", fullPath: "Hogar > Organización > Canastos", level: 2, parentId: "hogar-organizacion", active: true, order: 2 },
          { id: "hogar-organizacion-estantes", name: "Estantes", fullPath: "Hogar > Organización > Estantes", level: 2, parentId: "hogar-organizacion", active: true, order: 3 },
          { id: "hogar-organizacion-ganchos", name: "Ganchos", fullPath: "Hogar > Organización > Ganchos", level: 2, parentId: "hogar-organizacion", active: true, order: 4 },
        ]
      },
    ]
  },

  // ============================================================================
  // DEPORTES
  // ============================================================================
  {
    id: "deportes",
    name: "Deportes",
    fullPath: "Deportes",
    level: 0,
    parentId: null,
    active: true,
    order: 6,
    children: [
      { id: "deportes-ropa-deportiva", name: "Ropa Deportiva", fullPath: "Deportes > Ropa Deportiva", level: 1, parentId: "deportes", active: true, order: 1 },
      { id: "deportes-calzado", name: "Calzado Deportivo", fullPath: "Deportes > Calzado Deportivo", level: 1, parentId: "deportes", active: true, order: 2 },
      { id: "deportes-accesorios", name: "Accesorios", fullPath: "Deportes > Accesorios", level: 1, parentId: "deportes", active: true, order: 3 },
    ]
  },

  // ============================================================================
  // BELLEZA Y CUIDADO PERSONAL
  // ============================================================================
  {
    id: "belleza",
    name: "Belleza",
    fullPath: "Belleza",
    level: 0,
    parentId: null,
    active: true,
    order: 7,
    children: [
      { id: "belleza-cuidado-piel", name: "Cuidado de la piel", fullPath: "Belleza > Cuidado de la piel", level: 1, parentId: "belleza", active: true, order: 1 },
      { id: "belleza-maquillaje", name: "Maquillaje", fullPath: "Belleza > Maquillaje", level: 1, parentId: "belleza", active: true, order: 2 },
      { id: "belleza-cuidado-cabello", name: "Cuidado del cabello", fullPath: "Belleza > Cuidado del cabello", level: 1, parentId: "belleza", active: true, order: 3 },
      { id: "belleza-perfumes", name: "Perfumes", fullPath: "Belleza > Perfumes", level: 1, parentId: "belleza", active: true, order: 4 },
    ]
  },

  // ============================================================================
  // JUGUETES Y BEBÉS
  // ============================================================================
  {
    id: "bebes",
    name: "Bebés",
    fullPath: "Bebés",
    level: 0,
    parentId: null,
    active: true,
    order: 8,
    children: [
      { id: "bebes-ropa", name: "Ropa", fullPath: "Bebés > Ropa", level: 1, parentId: "bebes", active: true, order: 1 },
      { id: "bebes-pañales", name: "Pañales", fullPath: "Bebés > Pañales", level: 1, parentId: "bebes", active: true, order: 2 },
      { id: "bebes-juguetes", name: "Juguetes", fullPath: "Bebés > Juguetes", level: 1, parentId: "bebes", active: true, order: 3 },
      { id: "bebes-accesorios", name: "Accesorios", fullPath: "Bebés > Accesorios", level: 1, parentId: "bebes", active: true, order: 4 },
    ]
  },
];

/**
 * Convierte el árbol en una lista plana para Firebase
 */
export function flattenCategories(tree: CategoryNode[]): CategoryNode[] {
  const result: CategoryNode[] = [];
  
  function traverse(nodes: CategoryNode[]) {
    for (const node of nodes) {
      const { children, ...nodeData } = node;
      result.push(nodeData);
      if (children && children.length > 0) {
        traverse(children);
      }
    }
  }
  
  traverse(tree);
  return result;
}
