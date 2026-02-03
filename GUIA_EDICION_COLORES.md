# 🎨 Guía: Cómo Editar Colores e Imágenes

## ✅ Funcionalidades Disponibles

Cuando activas "☑️ Las variantes tienen colores diferentes", puedes **editar completamente** los colores detectados por la IA:

---

## 📝 Editar el Nombre del Color

### ¿Cómo?
Simplemente **haz click** en el campo de texto y escribe el nuevo nombre:

```
┌─────────────────────────────────────────┐
│ [🖼️ img] [rosa            ] [📷] [✕]  │
│            ↑↑↑↑                         │
│         EDITABLE                        │
└─────────────────────────────────────────┘
```

### Ejemplos de cambio:
- La IA detectó "**rojo**" → Lo cambias a "**rojo vino**"
- La IA detectó "**blue**" → Lo cambias a "**azul marino**"
- La IA detectó "**beige**" → Lo cambias a "**arena**"

**No se requiere nada más:** Solo escribe y guarda ✅

---

## 🖼️ Cambiar la Imagen Asociada

### Método 1: Click directo en la miniatura
```
┌─────────────────────────────────────────┐
│ [🖼️ img] rosa  [📷 Cambiar] [✕]       │
│   ↑↑↑                                   │
│  CLICK AQUÍ                             │
└─────────────────────────────────────────┘
```

**Resultado:** Se abre el selector de imágenes

---

### Método 2: Botón "📷 Cambiar"
```
┌─────────────────────────────────────────┐
│ [🖼️ img] rosa  [📷 Cambiar] [✕]       │
│                    ↑↑↑↑↑↑↑↑↑           │
│                   CLICK AQUÍ            │
└─────────────────────────────────────────┘
```

**Resultado:** Se abre el selector de imágenes

---

### ¿Qué pasa después?
Se abre un modal con todas las imágenes disponibles:

```
┌────────────────────────────────────────┐
│      Seleccionar imagen                │
├────────────────────────────────────────┤
│  [img1]  [img2]  [img3]  [img4]        │
│  🎨 rosa  🎨 azul              [img5]  │
│                                         │
│  [img6]  [img7]  [img8]                │
│                                         │
│                 [Cancelar]              │
└────────────────────────────────────────┘
```

**Click en cualquier imagen** y se asigna automáticamente a ese color.

---

## 🔄 Reordenar Colores

¿Los colores están en el orden incorrecto? **Muévelos:**

```
┌─────────────────────────────────────────┐
│  [↑][↓] [🖼️ rosa  ] rosa   [📷] [✕]  │
│  [↑][↓] [🖼️ beige ] beige  [📷] [✕]  │
│  [↑][↓] [🖼️ azul  ] azul   [📷] [✕]  │
└─────────────────────────────────────────┘
```

### ¿Cómo?
- **↑** Mueve el color **arriba**
- **↓** Mueve el color **abajo**

### Ejemplo:
Quieres que el azul aparezca primero:

**ANTES:**
1. rosa
2. beige
3. azul

**Haces click en ↑ del azul 2 veces:**

**DESPUÉS:**
1. azul
2. rosa
3. beige

---

## ✕ Eliminar un Color

¿La IA detectó un color incorrecto o duplicado?

```
┌─────────────────────────────────────────┐
│ [🖼️ img] rosa  [📷 Cambiar] [✕]       │
│                              ↑↑↑        │
│                            ELIMINAR     │
└─────────────────────────────────────────┘
```

**Click en ✕** → Confirmación → Color eliminado

**Nota:** No puedes eliminar el último color (debe haber al menos 1)

---

## ➕ Agregar un Nuevo Color

¿La IA no detectó todos los colores? Agrégalos:

```
┌─────────────────────────────────────────┐
│ Colores disponibles  [+ Agregar color] │
│                         ↑↑↑↑↑↑↑↑↑↑↑↑↑  │
│                        CLICK AQUÍ       │
└─────────────────────────────────────────┘
```

**Pasos:**
1. Click en [+ Agregar color]
2. Aparece fila nueva con campos vacíos
3. Escribe el nombre del color
4. Click en [📷 Cambiar] para seleccionar imagen
5. ¡Listo!

---

## 🎯 Escenarios Comunes

### Escenario 1: La IA confundió los colores

**Problema:**
```
rosa   → imagen_azul.jpg  ❌
azul   → imagen_rosa.jpg  ❌
```

**Solución:**
1. Click en miniatura de "rosa"
2. Selecciona la imagen rosa correcta
3. Click en miniatura de "azul"
4. Selecciona la imagen azul correcta
5. ✅ Listo

---

### Escenario 2: Nombre de color incorrecto

**Problema:**
```
Color: "red"  ❌ (quiero "rojo")
```

**Solución:**
1. Click en el campo de texto
2. Borra "red"
3. Escribe "rojo"
4. ✅ Listo

---

### Escenario 3: Faltan colores

**Problema:**
```
Detectó: rosa, beige
Falta: azul marino
```

**Solución:**
1. Click en [+ Agregar color]
2. Escribe "azul marino"
3. Click en [📷 Cambiar]
4. Selecciona imagen azul
5. ✅ Listo

---

### Escenario 4: Hay un color duplicado

**Problema:**
```
1. rosa
2. rosa  ❌ (duplicado)
3. beige
```

**Solución:**
1. Click en ✕ del segundo "rosa"
2. Confirmar
3. ✅ Listo

---

### Escenario 5: Orden incorrecto

**Problema:**
```
1. beige
2. azul
3. rosa  ← Este debería estar primero
```

**Solución:**
1. Click en ↑ del "rosa" dos veces
2. ✅ Ahora está primero

---

## 💡 Tips y Atajos

### Tip 1: Click directo en miniatura
No necesitas usar el botón "📷 Cambiar", puedes hacer **click directo en la miniatura** para cambiar la imagen.

---

### Tip 2: Auto-completado
Si una imagen ya tiene un color detectado y la asignas a un campo vacío, el nombre del color se **auto-completa**.

**Ejemplo:**
1. Imagen `img1.jpg` tiene badge "🎨 rosa"
2. Agregas un color nuevo (vacío)
3. Asignas `img1.jpg` a ese color
4. ✅ El campo se llena automáticamente con "rosa"

---

### Tip 3: Hover para tooltips
Pasa el mouse sobre cualquier botón para ver qué hace:
- 📷 → "Cambiar imagen"
- ✕ → "Eliminar este color"
- ↑ → "Mover arriba"
- ↓ → "Mover abajo"

---

### Tip 4: Visual feedback
- **Input de color:** Borde se pone azul al editarlo
- **Miniatura:** Crece ligeramente al pasar el mouse
- **Botones:** Cambian de color al hacer hover

---

## 🖼️ Vista Completa del UI

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Variante #1: Matrimonial                [✕]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Colores disponibles    [+ Agregar color]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
💡 Tip: Puedes editar el nombre del color, 
   cambiar su imagen con 📷, o eliminarlo con ✕
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

┌─────────────────────────────────────────┐
│ [↑] [🖼️ img] rosa        [📷 Cambiar] │
│ [↓]                              [✕]   │
├─────────────────────────────────────────┤
│ [↑] [🖼️ img] beige       [📷 Cambiar] │
│ [↓]                              [✕]   │
├─────────────────────────────────────────┤
│ [↑] [🖼️ img] azul marino [📷 Cambiar] │
│ [↓]                              [✕]   │
└─────────────────────────────────────────┘

Stock: [✅ Disponible ▼]

Precios:
┌─────────────────────────────────┐
│ publico   │ 1080 │ MXN │ [✕]   │
│ mayorista │ 810  │ MXN │ [✕]   │
│ asociada  │ 864  │ MXN │ [✕]   │
└─────────────────────────────────┘
```

---

## 📋 Resumen de Controles

| Acción | Cómo |
|--------|------|
| **Editar nombre** | Click en el input, escribe nuevo nombre |
| **Cambiar imagen** | Click en miniatura O botón "📷 Cambiar" |
| **Eliminar color** | Click en [✕] |
| **Agregar color** | Click en [+ Agregar color] |
| **Mover arriba** | Click en [↑] |
| **Mover abajo** | Click en [↓] |

---

## ✅ Checklist de Validación

Antes de guardar, verifica:

- [ ] Cada color tiene un nombre claro
- [ ] Cada color tiene su imagen correcta
- [ ] No hay colores duplicados
- [ ] El orden de los colores tiene sentido
- [ ] Los nombres están en español (o tu idioma preferido)
- [ ] Las imágenes muestran claramente el color

---

## 🎉 ¡Listo!

Ahora tienes **control total** sobre los colores:
- ✏️ Edita nombres
- 🖼️ Cambia imágenes
- ➕ Agrega colores
- ✕ Elimina colores
- 🔄 Reordena colores

**Todo lo que la IA detecta es solo una sugerencia inicial.** Tú tienes la última palabra. 🎨
