/**
 * Script de prueba para verificar conexión a Firebase
 * 
 * Uso:
 *   npx tsx scripts/test-firebase-connection.ts
 */

import * as admin from "firebase-admin";
import * as path from "path";

const serviceAccountPath = path.resolve(
  __dirname,
  "../../whatsapp-bot/serviceAccountKey.json"
);

async function testConnection() {
  console.log("🔍 Verificando conexión a Firebase...\n");

  try {
    // Cargar service account
    console.log("📁 Cargando serviceAccountKey.json...");
    const serviceAccount = require(serviceAccountPath);
    console.log(`✅ Service Account: ${serviceAccount.client_email}`);
    console.log(`✅ Project ID: ${serviceAccount.project_id}\n`);

    // Inicializar Firebase Admin
    console.log("🔌 Inicializando Firebase Admin SDK...");
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
      projectId: serviceAccount.project_id
    });
    console.log("✅ Firebase Admin inicializado\n");

    // Probar conexión a Firestore
    console.log("🔥 Conectando a Firestore...");
    const db = admin.firestore();
    
    // Intentar leer un documento (o crear uno de prueba)
    const testRef = db.collection("_test").doc("connection");
    await testRef.set({
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
      message: "Test de conexión exitoso"
    });
    console.log("✅ Escritura exitosa en Firestore\n");

    // Leer el documento
    const doc = await testRef.get();
    if (doc.exists) {
      console.log("✅ Lectura exitosa desde Firestore");
      console.log("   Datos:", doc.data());
    }

    // Limpiar
    await testRef.delete();
    console.log("✅ Limpieza completada\n");

    console.log("🎉 ¡Conexión a Firebase exitosa!");
    console.log("\n✅ Todo listo para migrar categorías.");
    console.log("   Ejecuta: npx tsx scripts/migrate-categories.ts");

  } catch (error: any) {
    console.error("\n❌ Error de conexión:", error.message);
    
    if (error.code === "ENOENT") {
      console.error("\n💡 No se encontró serviceAccountKey.json");
      console.error("   Ruta esperada:", serviceAccountPath);
    } else if (error.message.includes("Permission denied")) {
      console.error("\n💡 Error de permisos en Firestore");
      console.error("   Verifica que el Service Account tenga permisos de escritura");
    }
    
    process.exit(1);
  }

  process.exit(0);
}

testConnection();
