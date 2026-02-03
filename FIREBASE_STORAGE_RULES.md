# 🔥 Firebase Storage - Configuración de Reglas

## ⚠️ **IMPORTANTE**

Para que el botón "📤 Subir Nueva Imagen" funcione, necesitas configurar las reglas de Firebase Storage para permitir escritura a usuarios autenticados.

---

## 🔧 **CÓMO CONFIGURAR**

### **1. Ve a Firebase Console**

1. Abre [https://console.firebase.google.com/](https://console.firebase.google.com/)
2. Selecciona tu proyecto: **Base Mayorista**
3. En el menú lateral, click en **"Storage"**
4. Click en la pestaña **"Rules"** (Reglas)

---

### **2. Reemplaza las Reglas Actuales**

Copia y pega estas reglas:

```javascript
rules_version = '2';

service firebase.storage {
  match /b/{bucket}/o {
    
    // Carpeta de imágenes de productos
    match /product-images/{imageId} {
      // Lectura: Cualquiera (para que los productos sean públicos)
      allow read: if true;
      
      // Escritura: Solo usuarios autenticados
      allow write: if request.auth != null 
                   && request.resource.size < 5 * 1024 * 1024  // Máx 5MB
                   && request.resource.contentType.matches('image/.*'); // Solo imágenes
    }
    
    // Carpeta de imágenes raw del WhatsApp Bot
    match /whatsapp-media/{allPaths=**} {
      allow read: if true;
      allow write: if request.auth != null;
    }
    
    // Otras carpetas: Solo lectura
    match /{allPaths=**} {
      allow read: if true;
      allow write: if false;
    }
  }
}
```

---

### **3. Click en "Publicar" (Publish)**

⚠️ **Importante**: Espera unos segundos a que las reglas se propaguen.

---

## ✅ **VERIFICACIÓN**

### **Después de publicar las reglas:**

1. Ve a tu app: `http://localhost:4200`
2. Abre un producto en review
3. Click en [📷 Con imagen]
4. Click en [📤 Subir Nueva Imagen]
5. Selecciona una imagen de tu PC
6. **Abre la consola del navegador** (F12)
7. Deberías ver logs como:

```
📁 Archivo seleccionado: mi-imagen.jpg Tamaño: 123456 bytes
⏳ Iniciando upload...
📝 Nombre de archivo: 1738034567_abc123_mi-imagen.jpg
📤 Subiendo a Firebase Storage...
✅ Upload completado: product-images/1738034567_abc123_mi-imagen.jpg
🔗 Obteniendo URL pública...
✅ URL obtenida: https://firebasestorage.googleapis.com/...
✅ Agregada a rawImages, total: 5
✅ Color asignado: rosa
✅ Imagen subida exitosamente: rosa
```

---

## ❌ **SI HAY ERRORES**

### **Error: "🔒 Error de permisos"**

```
Error code: storage/unauthorized
```

**Solución:**
1. Verifica que las reglas estén publicadas
2. Verifica que estás **logueado** en la app
3. Espera 30 segundos y recarga la app
4. Si persiste, revisa las reglas en Firebase Console

---

### **Error: "❌ Error desconocido"**

```
Error code: storage/unknown
```

**Solución:**
1. Verifica tu conexión a internet
2. Verifica que Firebase Storage esté habilitado en tu proyecto
3. En Firebase Console > Storage, asegúrate de que el bucket existe

---

### **Error: "⚠️ La imagen no puede pesar más de 5MB"**

**Solución:**
- Usa una imagen más pequeña
- O aumenta el límite en las reglas:
  ```javascript
  request.resource.size < 10 * 1024 * 1024  // 10MB
  ```

---

## 🧪 **PROBAR SIN REGLAS (Solo Testing)**

Si necesitas probar rápidamente **SIN configurar reglas** (⚠️ INSEGURO, solo para desarrollo):

```javascript
rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /{allPaths=**} {
      allow read, write: if true;  // ⚠️ INSEGURO - Cualquiera puede escribir
    }
  }
}
```

⚠️ **NUNCA uses esto en producción**

---

## 📋 **CHECKLIST**

- [ ] Ir a Firebase Console → Storage → Rules
- [ ] Copiar y pegar las reglas de arriba
- [ ] Click en "Publicar"
- [ ] Esperar 30 segundos
- [ ] Recargar la app (Ctrl + Shift + R)
- [ ] Abrir consola del navegador (F12)
- [ ] Probar subir una imagen
- [ ] Verificar logs en consola

---

## 🔍 **LOGS EN CONSOLA**

El código ahora incluye logs detallados. Abre la consola del navegador (F12) antes de subir una imagen para ver:

- ✅ **Éxito**: Verás el proceso completo con emojis verdes
- ❌ **Error**: Verás el error específico con código y mensaje

---

## 📞 **SI SIGUE SIN FUNCIONAR**

1. Toma screenshot de:
   - Firebase Console → Storage → Rules
   - Consola del navegador (F12) con el error
   
2. Busca en los logs:
   - `Error code: storage/...`
   - Mensaje completo del error

3. Verifica que:
   - Estás **logueado** en la app
   - Firebase Storage está **habilitado**
   - El bucket existe

---

## ✅ **RESULTADO ESPERADO**

Después de subir la imagen exitosamente:

```
1. Modal muestra "⏳ Subiendo..."
2. Prompt pide: "Nombre del color para esta imagen:"
3. Ingresas: "rosa"
4. Alert: "✅ Imagen subida exitosamente: rosa"
5. Modal se cierra
6. La imagen aparece en la galería de colores
```

**¡Listo para subir imágenes!** 📤✨
