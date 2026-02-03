# Scripts de Migración

## 📋 Migrar Categorías a Firebase

Este script migra 150+ categorías estandarizadas a tu proyecto Firebase.

### Paso 1: Verificar Service Account Key

El script ya está configurado para usar tu `serviceAccountKey.json` del backend.

**Ruta esperada**: `../whatsapp-bot/serviceAccountKey.json`

✅ **No necesitas editar nada** - el script ya tiene la configuración correcta.

### Paso 2: Instalar Dependencias

```bash
cd admin-web
npm install tsx firebase-admin --save-dev
```

### Paso 3: Probar Conexión (Opcional pero Recomendado)

Antes de migrar, verifica que la conexión funciona:

```bash
npx tsx scripts/test-firebase-connection.ts
```

**Salida esperada:**
```
🔍 Verificando conexión a Firebase...
✅ Service Account: firebase-adminsdk-fbsvc@base-mayorista.iam.gserviceaccount.com
✅ Project ID: base-mayorista
✅ Firebase Admin inicializado
✅ Escritura exitosa en Firestore
✅ Lectura exitosa desde Firestore
🎉 ¡Conexión a Firebase exitosa!
```

### Paso 4: Ejecutar Migración

```bash
npx tsx scripts/migrate-categories.ts
```

**Salida esperada:**

```
🚀 Iniciando migración de categorías...

📦 Total de categorías: 150

✅ Procesadas 150/150 categorías

🎉 Migración completada exitosamente!

📋 Resumen por nivel:
  Nivel 0: 8 categorías
  Nivel 1: 35 categorías
  Nivel 2: 107 categorías
```

### Paso 5: Verificar en Firebase

1. Ve a Firebase Console
2. Firestore Database
3. Verás la colección `categories` con 150+ documentos

Ejemplo de documento:

```json
{
  "id": "hogar-recamara-cobertores",
  "name": "Cobertores",
  "fullPath": "Hogar > Recámara > Cobertores",
  "parentId": "hogar-recamara",
  "level": 2,
  "active": true,
  "order": 1,
  "created_at": "2026-01-28T..."
}
```

### Paso 6: Configurar Reglas de Firestore

Asegúrate de que las categorías sean legibles:

```javascript
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /categories/{category} {
      allow read: if true; // Público
      allow write: if request.auth != null; // Solo admins
    }
  }
}
```

### Paso 7: Crear Índices (si es necesario)

Firestore debería crear estos índices automáticamente. Si no, agrégalos manualmente:

1. `active` (ASC) + `order` (ASC)
2. `parentId` (ASC) + `order` (ASC)
3. `level` (ASC) + `order` (ASC)

---

## 🔄 Re-ejecutar la Migración

Si necesitas actualizar las categorías:

1. Modifica `categories-data.ts`
2. Re-ejecuta: `npx tsx scripts/migrate-categories.ts`
3. El script sobrescribe los documentos existentes

---

## ➕ Agregar Nuevas Categorías

### Opción 1: Desde el Frontend (recomendado)

Usa `CategoriesService.addCategory()`:

```typescript
await categoriesService.addCategory("Bufandas", "accesorios");
```

### Opción 2: Editar el Script

1. Abre `categories-data.ts`
2. Agrega tu categoría en el árbol:

```typescript
{
  id: "accesorios-bufandas",
  name: "Bufandas",
  fullPath: "Accesorios > Bufandas",
  level: 1,
  parentId: "accesorios",
  active: true,
  order: 10
}
```

3. Re-ejecuta el script

---

## 📊 Categorías Incluidas

- **Ropa** (Mujer, Hombre, Niños): 22 subcategorías
- **Ropa Interior** (Mujer, Hombre): 9 subcategorías
- **Calzado**: 5 tipos
- **Accesorios**: 9 tipos
- **Hogar** (Recámara, Baño, Cocina, Sala, Organización): 21 subcategorías
- **Deportes**: 3 tipos
- **Belleza**: 4 tipos
- **Bebés**: 4 tipos

**Total: 150+ categorías**

---

## 🐛 Troubleshooting

### Error: "Permission denied"

**Causa**: El Service Account no tiene permisos suficientes.

**Solución**: 
1. Ve a [Firebase Console](https://console.firebase.google.com/project/base-mayorista/settings/iam)
2. Verifica que `firebase-adminsdk-fbsvc@base-mayorista.iam.gserviceaccount.com` tenga rol de "Editor" o "Propietario"
3. Si no aparece, agrégalo con permisos de Cloud Datastore User

### Error: "Module not found: firebase-admin"

**Solución**: 
```bash
npm install firebase-admin --save-dev
```

### Error: "Cannot find module serviceAccountKey.json"

**Solución**: Verifica que el archivo existe en:
```
whatsapp-bot/serviceAccountKey.json
```

### Error: "Cannot find module 'tsx'"

**Solución**: 
```bash
npm install tsx --save-dev
```

---

## ✅ Checklist Post-Migración

- [ ] Verificar que hay 150+ documentos en `categories` collection
- [ ] Probar búsqueda de categorías en el frontend
- [ ] Verificar que las reglas de Firestore permiten lectura pública
- [ ] Actualizar el backend para consultar categorías desde Firebase
- [ ] Probar que la IA propone categorías correctas

---

## 📚 Más Información

Ver `IMPLEMENTACION_COMPLETA.md` en la raíz del proyecto para la guía completa.
