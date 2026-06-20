# 🚀 Guía Rápida: Migración de Categorías

## ✅ Todo está listo

Tu configuración de Firebase ya está conectada automáticamente usando el `serviceAccountKey.json` del backend.

---

## 📝 Comandos a Ejecutar (en orden)

### 1. Ir a la carpeta del proyecto

```bash
cd admin-web
```

### 2. Instalar dependencias necesarias

```bash
npm install tsx firebase-admin --save-dev
```

### 3. (Opcional) Probar conexión a Firebase

```bash
npx tsx scripts/test-firebase-connection.ts
```

**Deberías ver**:
```
🔍 Verificando conexión a Firebase...
✅ Service Account: firebase-adminsdk-fbsvc@base-mayorista.iam.gserviceaccount.com
✅ Project ID: base-mayorista
✅ Firebase Admin inicializado
✅ Escritura exitosa en Firestore
🎉 ¡Conexión a Firebase exitosa!
```

### 4. Migrar las 150+ categorías

```bash
npx tsx scripts/migrate-categories.ts
```

**Deberías ver**:
```
🚀 Iniciando migración de categorías...
✅ Conectado a Firebase
📦 Total de categorías a migrar: 150
✅ Procesadas 150/150 categorías
🎉 Migración completada exitosamente!

📋 Resumen por nivel:
  Nivel 0: 8 categorías
  Nivel 1: 35 categorías
  Nivel 2: 107 categorías

📊 Categorías por sección:
  Ropa: 23 items
  Ropa Interior: 10 items
  Calzado: 6 items
  Accesorios: 10 items
  Hogar: 26 items
  Deportes: 4 items
  Belleza: 5 items
  Bebés: 5 items
```

### 5. Verificar en Firebase Console

Abre en tu navegador:
```
https://console.firebase.google.com/project/base-mayorista/firestore
```

Deberías ver la colección **`categories`** con **150+ documentos**.

---

## 🎯 ¿Qué categorías se migrarán?

- **Ropa**: Mujer (blusas, playeras, pants, leggings, mallas, jeans, vestidos...), Hombre, Niños
- **Ropa Interior**: Mujer (brassieres, pantaletas, fajas, bodys, lencería), Hombre (boxers, calzoncillos)
- **Calzado**: Tenis, zapatos, sandalias, botas, pantuflas
- **Accesorios**: Bolsas, carteras, mochilas, cinturones, gorras, joyería
- **Hogar**:
  - Recámara: cobertores, edredones, sábanas, almohadas
  - Baño: toallas, toallones, cortinas, tapetes
  - Cocina: manteles, individuales, paños, delantales
  - Sala: cojines, cortinas, tapetes
  - Organización: cajas, canastos, estantes
- **Deportes**: Ropa deportiva, calzado, accesorios
- **Belleza**: Cuidado de piel, maquillaje, cabello, perfumes
- **Bebés**: Ropa, pañales, juguetes, accesorios

---

## ⚠️ Notas Importantes

1. **No necesitas editar nada** - El script ya está configurado con tu Firebase
2. **Es seguro re-ejecutar** - Si algo falla, puedes volver a correr el script
3. **Las categorías existentes se sobrescriben** - Si ya hay categorías, se actualizan

---

## 🐛 Si algo sale mal

### Error: "Cannot find module 'firebase-admin'"

```bash
npm install firebase-admin --save-dev
```

### Error: "Cannot find module serviceAccountKey.json"

Verifica que existe el archivo:
```
Base Mayorista Backend/Base_Mayorista/serviceAccountKey.json
```

### Error: "Permission denied"

El Service Account necesita permisos. Ve a:
```
https://console.firebase.google.com/project/base-mayorista/settings/iam
```

Y verifica que `firebase-adminsdk-fbsvc@base-mayorista.iam.gserviceaccount.com` tenga rol de "Editor".

---

## ✅ Después de Migrar

1. Recarga tu aplicación frontend (Ctrl + Shift + R)
2. Ve a la página de review de un listing
3. Busca en el campo de categoría
4. Deberías ver 150+ opciones

---

## 🎉 ¡Listo!

Ahora puedes usar las categorías estandarizadas en tu aplicación.

**Siguiente paso**: Actualizar el backend para que la IA consulte estas categorías.  
Ver: `whatsapp-bot/BACKEND_CATEGORIES_AI.md`
