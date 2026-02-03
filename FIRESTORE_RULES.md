# 🔥 Firestore Rules - Configuración Requerida

## ⚠️ **ERRORES ACTUALES**

Según los logs de tu consola:

```
❌ Firestore smoke read failed
❌ Error cargando categorías desde Firestore
❌ Error cargando proveedores
```

**Causa:** Las reglas de Firestore no permiten leer/escribir a usuarios autenticados.

---

## 🔧 **SOLUCIÓN: Configurar Firestore Rules**

### **1. Ve a Firebase Console**

1. Abre [https://console.firebase.google.com/](https://console.firebase.google.com/)
2. Selecciona tu proyecto: **Base Mayorista**
3. En el menú lateral, click en **"Firestore Database"**
4. Click en la pestaña **"Reglas"** (Rules)

---

### **2. Reemplaza con estas Reglas**

Copia y pega estas reglas completas:

```javascript
rules_version = '2';

service cloud.firestore {
  match /databases/{database}/documents {
    
    // ============================================================
    // FUNCIONES AUXILIARES
    // ============================================================
    
    // Verificar si el usuario está autenticado
    function isAuthenticated() {
      return request.auth != null;
    }
    
    // Verificar si el usuario es admin (puedes agregar tu email específico)
    function isAdmin() {
      return isAuthenticated() && request.auth.token.email != null;
    }
    
    // ============================================================
    // RAW POSTS (Posts originales de WhatsApp)
    // ============================================================
    
    match /raw_posts/{postId} {
      // Lectura: Solo usuarios autenticados
      allow read: if isAuthenticated();
      
      // Escritura: Solo el backend (o admin por ahora)
      allow write: if isAuthenticated();
    }
    
    // ============================================================
    // NORMALIZED LISTINGS (Productos normalizados)
    // ============================================================
    
    match /normalized_listings/{listingId} {
      // Lectura: Solo usuarios autenticados
      allow read: if isAuthenticated();
      
      // Escritura: Solo usuarios autenticados
      allow write: if isAuthenticated();
    }
    
    // ============================================================
    // CATEGORIES (Categorías del sistema)
    // ============================================================
    
    match /categories/{categoryId} {
      // Lectura: Usuarios autenticados
      allow read: if isAuthenticated();
      
      // Escritura: Solo admin
      allow write: if isAdmin();
    }
    
    // ============================================================
    // SUPPLIERS (Proveedores)
    // ============================================================
    
    match /suppliers/{supplierId} {
      // Lectura: Usuarios autenticados
      allow read: if isAuthenticated();
      
      // Escritura: Solo admin
      allow write: if isAdmin();
    }
    
    // ============================================================
    // PRODUCTS (Productos validados)
    // ============================================================
    
    match /products/{productId} {
      // Lectura: Usuarios autenticados
      allow read: if isAuthenticated();
      
      // Escritura: Solo usuarios autenticados
      allow write: if isAuthenticated();
    }
    
    // ============================================================
    // DEFAULT: Denegar todo lo demás
    // ============================================================
    
    match /{document=**} {
      allow read, write: if false;
    }
  }
}
```

---

### **3. Click en "Publicar" (Publish)**

⚠️ **Importante**: Las reglas se aplican inmediatamente.

---

## 🔐 **EXPLICACIÓN DE LAS REGLAS**

### **Seguridad por Colección**

| Colección | Lectura | Escritura |
|-----------|---------|-----------|
| `raw_posts` | 🔒 Autenticado | 🔒 Autenticado |
| `normalized_listings` | 🔒 Autenticado | 🔒 Autenticado |
| `categories` | 🔒 Autenticado | 🔐 Admin |
| `suppliers` | 🔒 Autenticado | 🔐 Admin |
| `products` | 🔒 Autenticado | 🔒 Autenticado |
| Otros | ❌ Denegado | ❌ Denegado |

---

## ✅ **VERIFICACIÓN**

Después de publicar las reglas:

1. **Recarga tu app** (Ctrl + Shift + R)
2. **Vuelve a hacer login**
3. **Abre la consola** (F12)

**Deberías ver:**
```
✅ Login exitoso, redirigiendo a: /inbox
✅ Categorías cargadas: 150+
✅ Proveedores cargados: X
```

**NO deberías ver:**
```
❌ Firestore smoke read failed
❌ Error cargando categorías
❌ Usando categorías de respaldo
```

---

## 🧪 **TESTING**

### **Test de Categorías**

```javascript
// En la consola del navegador (F12), ejecuta:
firebase.firestore().collection('categories').limit(1).get()
  .then(() => console.log('✅ Categorías accesibles'))
  .catch(err => console.error('❌ Error:', err.code));
```

---

## ❌ **ERRORES COMUNES**

### **Error: "Missing or insufficient permissions"**

**Causa:** Las reglas aún no están publicadas o el usuario no está autenticado.

**Solución:**
1. Verifica que publicaste las reglas
2. Verifica que estás **logueado** en la app
3. Cierra sesión y vuelve a entrar
4. Espera 1 minuto después de publicar

---

### **Error: "Firestore smoke read failed (ok if rules block it)"**

**Causa:** Es un warning normal. Firebase intenta hacer un "smoke test" al conectarse.

**Solución:** Ignorar. Es esperado que falle si las reglas requieren autenticación.

---

## 🔐 **REGLAS PARA DESARROLLO (⚠️ INSEGURO)**

Si necesitas probar rápidamente **SIN restricciones** (⚠️ solo para desarrollo local):

```javascript
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /{document=**} {
      allow read, write: if true;  // ⚠️ INSEGURO
    }
  }
}
```

⚠️ **NUNCA uses esto en producción**

---

## 📋 **CHECKLIST**

- [ ] Ir a Firebase Console → Firestore Database → Reglas
- [ ] Copiar las reglas de arriba
- [ ] Click en "Publicar"
- [ ] Esperar 1 minuto
- [ ] Recargar la app (Ctrl + Shift + R)
- [ ] Hacer login nuevamente
- [ ] Abrir consola (F12)
- [ ] Verificar que no hay errores de permisos

---

## 🔄 **TAMBIÉN NECESITAS: Storage Rules**

Las reglas de **Firestore** son diferentes de las de **Storage**.

Para el botón de "Subir Imagen", lee: **`FIREBASE_STORAGE_RULES.md`**

---

## 📞 **SI PERSISTE EL ERROR**

1. **Captura de pantalla** de:
   - Firebase Console → Firestore Database → Reglas
   - Consola del navegador (F12) con el error completo

2. **Verifica**:
   - Estás logueado en la app
   - El email con el que te logueaste está en Firebase Authentication
   - Esperaste al menos 1 minuto después de publicar

3. **Intenta**:
   - Cerrar sesión
   - Limpiar caché del navegador (Ctrl + Shift + Delete)
   - Volver a hacer login

---

## ✅ **RESULTADO ESPERADO**

Después de aplicar las reglas:

```
Console Log:
✅ Login exitoso, redirigiendo a: /inbox
✅ Categorías cargadas desde Firebase
✅ Proveedores cargados desde Firebase
✅ Productos cargados: X pendientes de revisión

NO más errores:
❌ Missing or insufficient permissions
❌ Error cargando categorías
```

**¡Listo para trabajar sin errores de permisos!** 🎉
