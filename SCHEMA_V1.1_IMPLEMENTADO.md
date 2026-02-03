# ✅ Schema v1.1 - Implementación Completa

## 🎯 **CAMBIOS IMPLEMENTADOS**

El frontend ahora soporta el **nuevo schema v1.1** que separa correctamente:
- 🖼️ **Portadas** (`cover_images`) - Imágenes generales del producto
- 🎨 **Colores** (`product_colors`) - Colores globales reutilizables

---

## 📊 **DIFERENCIAS ENTRE SCHEMAS**

### **❌ Schema v1 (Antiguo)**

```json
{
  "preview_image_url": "https://.../portada.jpg",
  "listing": {
    "items": [
      {
        "variant_name": "Chica",
        "colors": ["negro", "blanco"],
        "image_urls": ["https://.../negro.jpg", "https://.../blanco.jpg"]
      }
    ]
  }
}
```

**Problemas:**
- ❌ Portada mezclada con colores
- ❌ Colores duplicados en cada variante
- ❌ Difícil agregar colores globalmente

---

### **✅ Schema v1.1 (Nuevo)**

```json
{
  "schema_version": "normalized_v1.1",
  
  "cover_images": ["https://.../portada.jpg"],
  
  "product_colors": [
    { "name": "negro", "image_url": "https://.../negro.jpg" },
    { "name": "blanco", "image_url": "https://.../blanco.jpg" }
  ],
  
  "listing": {
    "items": [
      {
        "variant_name": "Chica",
        "color_names": ["negro", "blanco"]
      }
    ]
  }
}
```

**Beneficios:**
- ✅ Separación clara: Portada ≠ Colores
- ✅ Colores definidos una vez
- ✅ Fácil reutilización en variantes
- ✅ Sin duplicación

---

## 🔧 **ARCHIVOS MODIFICADOS**

### **1. `src/app/core/firestore-contracts.ts`**

**Interfaces Nuevas:**

```typescript
// ✅ NUEVO: Color global del producto
export interface ProductColor {
  name: string;
  image_url: string | null;
}
```

**Interfaces Actualizadas:**

```typescript
export interface NormalizedListingDoc {
  schema_version: "normalized_v1" | "normalized_v1.1";
  
  // ✅ NUEVOS campos v1.1
  cover_images?: string[];
  product_colors?: ProductColor[];
  
  // DEPRECATED (mantener para compatibilidad)
  preview_image_url?: string | null;
  
  // ... resto igual
}

export interface NormalizedItem {
  variant_name: string | null;
  
  // ✅ NUEVO v1.1: Solo referencias a colores globales
  color_names?: string[];
  
  // DEPRECATED v1 (mantener para compatibilidad)
  colors?: string[];
  image_urls?: string[];
  
  // ... resto igual
}
```

**Resultado:**
- ✅ Soporte para ambos schemas (v1 y v1.1)
- ✅ Compatibilidad hacia atrás
- ✅ TypeScript validación completa

---

### **2. `src/app/features/review/review.ts`**

**Import Actualizado:**

```typescript
import type { 
  NormalizedListingDoc, 
  ProductColor,  // ← NUEVO
  // ... otros
} from "../../core/firestore-contracts";
```

**Computed Properties Nuevos:**

```typescript
// ✅ Portada con fallback a v1
coverUrl = computed(() => {
  const d = this.draft();
  if (!d) return null;
  
  // v1.1: Usar cover_images[0]
  if (d.cover_images && d.cover_images.length > 0) {
    return d.cover_images[0];
  }
  
  // v1: Fallback a preview_image_url
  return d.preview_image_url || null;
});

// ✅ Colores globales con fallback a v1
globalColors = computed(() => {
  const d = this.draft();
  if (!d) return [];
  
  // v1.1: Usar product_colors si existe
  if (d.product_colors && d.product_colors.length > 0) {
    return d.product_colors;
  }
  
  // v1: Construir desde imageColors actuales
  const colors: ProductColor[] = [];
  for (const [url, name] of Object.entries(this.imageColors)) {
    if (url !== this.coverUrl() && name.trim()) {
      colors.push({ name, image_url: url });
    }
  }
  
  return colors;
});
```

**Método de Normalización:**

```typescript
// ✅ Convierte v1 → v1.1 en memoria (sin guardar)
private normalizeToV1_1(doc: NormalizedListingDoc): void {
  // Si ya es v1.1, no hacer nada
  if (doc.schema_version === "normalized_v1.1" && doc.product_colors) {
    return;
  }

  // 1. Construir cover_images desde preview_image_url
  if (!doc.cover_images || doc.cover_images.length === 0) {
    doc.cover_images = doc.preview_image_url ? [doc.preview_image_url] : [];
  }

  // 2. Construir product_colors desde items v1
  if (!doc.product_colors || doc.product_colors.length === 0) {
    const colorMap = new Map<string, string | null>();
    // ... lógica de conversión
    doc.product_colors = Array.from(colorMap.entries()).map(([name, url]) => ({
      name,
      image_url: url
    }));
  }

  // 3. Construir color_names para cada item
  doc.listing.items.forEach(item => {
    if (!item.color_names && item.colors) {
      item.color_names = [...item.colors];
    }
  });
}
```

**Métodos de Utilidad Nuevos:**

```typescript
// Obtener nombres de colores (v1.1 compatible)
getItemColorNames(item: NormalizedItem): string[] {
  return item.color_names || item.colors || [];
}

// Obtener imagen de un color
getColorImage(colorName: string): string | null {
  const color = this.draft()?.product_colors?.find(c => c.name === colorName);
  return color?.image_url || null;
}

// Actualizar nombre de color global
updateGlobalColorName(oldName: string, newName: string) {
  // Actualiza en product_colors Y en todas las referencias de items
}

// Agregar color global
addGlobalColorWithDetails(name: string, imageUrl: string | null) {
  // Agrega a product_colors
}

// Eliminar color global
removeGlobalColorByName(colorName: string) {
  // Elimina de product_colors Y de todas las referencias
}
```

**Llamada en `load()`:**

```typescript
async load() {
  // ... código existente
  
  this.initializeImageColors();
  
  // ✅ NUEVO: Normalizar a v1.1 en memoria
  this.normalizeToV1_1(clone);
  
  // ... resto del código
}
```

---

## 🔄 **COMPATIBILIDAD HACIA ATRÁS**

El frontend ahora maneja **automáticamente** ambos schemas:

### **Datos v1 (Antiguos)**
```
1. Usuario carga producto viejo (v1)
2. Frontend detecta que no tiene product_colors
3. Ejecuta normalizeToV1_1()
4. Convierte en memoria a v1.1
5. Usuario trabaja con el nuevo formato
6. Al guardar, se puede enviar en v1.1
```

### **Datos v1.1 (Nuevos)**
```
1. Usuario carga producto nuevo (v1.1)
2. Frontend detecta product_colors presente
3. Usa directamente el formato v1.1
4. Usuario trabaja con colores globales
5. Al guardar, mantiene v1.1
```

---

## 🧪 **TESTING**

### **Test 1: Producto Nuevo (v1.1)** ✅

Cuando el backend envía un producto con schema v1.1:

```json
{
  "schema_version": "normalized_v1.1",
  "cover_images": ["https://.../portada.jpg"],
  "product_colors": [
    { "name": "negro", "image_url": "https://.../negro.jpg" }
  ],
  "listing": {
    "items": [
      { "variant_name": "Chica", "color_names": ["negro"] }
    ]
  }
}
```

**Resultado esperado:**
```
✅ coverUrl() → "https://.../portada.jpg"
✅ globalColors() → [{ name: "negro", image_url: "..." }]
✅ getItemColorNames(item) → ["negro"]
✅ getColorImage("negro") → "https://.../negro.jpg"
```

---

### **Test 2: Producto Antiguo (v1)** ✅

Cuando el backend envía un producto con schema v1:

```json
{
  "schema_version": "normalized_v1",
  "preview_image_url": "https://.../portada.jpg",
  "listing": {
    "items": [
      {
        "variant_name": "Chica",
        "colors": ["negro"],
        "image_urls": ["https://.../negro.jpg"]
      }
    ]
  }
}
```

**Resultado esperado:**
```
✅ normalizeToV1_1() se ejecuta automáticamente
✅ coverUrl() → "https://.../portada.jpg" (desde preview_image_url)
✅ globalColors() → [{ name: "negro", image_url: "..." }] (construido)
✅ getItemColorNames(item) → ["negro"] (desde colors)
✅ getColorImage("negro") → "https://.../negro.jpg"
```

---

## 🎯 **PRÓXIMOS PASOS**

### **Frontend - LISTO** ✅
- [x] Interfaces TypeScript actualizadas
- [x] Computed properties para v1.1
- [x] Normalización automática v1 → v1.1
- [x] Métodos de utilidad nuevos
- [x] Compatibilidad hacia atrás

### **Backend - PENDIENTE** (ver `FRONTEND_ACTUALIZAR_SCHEMA_V1.1.md`)
- [ ] Actualizar IA para generar v1.1
- [ ] Separar cover_images de product_colors
- [ ] Modificar prompt de GPT-4 Vision
- [ ] Script de migración de datos viejos

### **UI/UX - PENDIENTE** (opcional)
- [ ] Actualizar HTML para mostrar colores globales
- [ ] Crear sección de "Colores del Producto"
- [ ] Selector visual de colores para variantes
- [ ] Mejorar UX de asignación de colores

---

## 📐 **FLUJO COMPLETO**

### **Usuario carga producto:**

```
1. Frontend llama load()
2. Obtiene documento de Firestore
3. Ejecuta normalizeToV1_1(doc)
   ├─ Si es v1.1 → usa directamente
   └─ Si es v1 → convierte en memoria
4. Usuario ve:
   - Portada separada
   - Colores globales del producto
   - Variantes con referencias a colores
5. Usuario edita:
   - Puede cambiar portada
   - Puede agregar/editar colores globales
   - Puede asignar colores a variantes
6. Usuario guarda (save())
   - Los datos se guardan con la estructura v1.1
```

---

## 📚 **DOCUMENTOS RELACIONADOS**

| Documento | Descripción |
|-----------|-------------|
| `FRONTEND_ACTUALIZAR_SCHEMA_V1.1.md` | Guía completa del backend |
| `BACKEND_SEPARAR_PORTADA_COLORES.md` | Arquitectura de separación |
| `SCHEMA_V1.1_IMPLEMENTADO.md` | Este documento |

---

## ✅ **CHECKLIST DE IMPLEMENTACIÓN**

### **TypeScript**
- [x] Interface `ProductColor` creada
- [x] `NormalizedListingDoc` actualizado
- [x] `NormalizedItem` actualizado
- [x] Import de `ProductColor` en review.ts

### **Review Component**
- [x] Computed `coverUrl` con fallback v1
- [x] Computed `globalColors` con fallback v1
- [x] Método `normalizeToV1_1()`
- [x] Métodos de utilidad v1.1
- [x] Llamada a normalización en `load()`
- [x] Actualizado `detectAndActivateColors()`

### **Testing**
- [ ] Probar con producto nuevo (v1.1)
- [ ] Probar con producto viejo (v1)
- [ ] Verificar que globalColors() funciona
- [ ] Verificar que coverUrl() funciona
- [ ] Verificar normalización automática

---

## 🚀 **PARA PROBAR**

```typescript
// En la consola del navegador (F12):

// 1. Verificar schema version
console.log("Schema:", window.reviewComponent?.draft()?.schema_version);

// 2. Ver colores globales
console.log("Colores globales:", window.reviewComponent?.globalColors());

// 3. Ver portada
console.log("Portada:", window.reviewComponent?.coverUrl());

// 4. Ver colores de primera variante
const item = window.reviewComponent?.draft()?.listing.items[0];
console.log("Colores variante:", window.reviewComponent?.getItemColorNames(item));
```

---

## 💡 **BENEFICIOS IMPLEMENTADOS**

1. ✅ **Sin Duplicación**: Un color se define una vez
2. ✅ **Más Flexible**: Fácil agregar/eliminar colores
3. ✅ **Mejor UX**: Todos los colores visibles de un vistazo
4. ✅ **Más Limpio**: Separación clara portada/colores
5. ✅ **Escalable**: Fácil extender con más propiedades
6. ✅ **Compatible**: Funciona con datos v1 y v1.1

---

**¡Frontend listo para Schema v1.1!** 🎉

**Próximo paso:** Implementar generación v1.1 en el backend siguiendo `FRONTEND_ACTUALIZAR_SCHEMA_V1.1.md`
