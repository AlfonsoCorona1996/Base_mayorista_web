/**
 * Script para migrar categorías a Firebase Firestore
 * 
 * Uso:
 *   npx tsx scripts/migrate-categories.ts
 */

import * as admin from "firebase-admin";
import { CATEGORIES_TREE, flattenCategories } from "./categories-data";
import * as path from "path";

// Ruta al serviceAccountKey.json del backend
const serviceAccountPath = path.resolve(
  __dirname,
  "../../whatsapp-bot/serviceAccountKey.json"
);

async function migrateCategories() {
  console.log("🚀 Iniciando migración de categorías...\n");

  try {
    // Inicializar Firebase Admin
    const serviceAccount = require(serviceAccountPath);
    
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
      projectId: "base-mayorista"
    });

    const db = admin.firestore();
    console.log("✅ Conectado a Firebase\n");

    // Obtener lista plana de categorías
    const categories = flattenCategories(CATEGORIES_TREE);
    console.log(`📦 Total de categorías a migrar: ${categories.length}\n`);

    // Migrar en lotes de 500 (límite de Firestore)
    const batchSize = 500;
    let processed = 0;

    for (let i = 0; i < categories.length; i += batchSize) {
      const batch = db.batch();
      const chunk = categories.slice(i, i + batchSize);

      for (const category of chunk) {
        const docRef = db.collection("categories").doc(category.id);
        batch.set(docRef, {
          ...category,
          created_at: admin.firestore.FieldValue.serverTimestamp(),
          updated_at: admin.firestore.FieldValue.serverTimestamp(),
        });
        processed++;
      }

      await batch.commit();
      console.log(`✅ Procesadas ${processed}/${categories.length} categorías`);
    }

    console.log("\n🎉 Migración completada exitosamente!");
    console.log("\n📋 Resumen por nivel:");
    
    const byLevel = categories.reduce((acc, cat) => {
      acc[cat.level] = (acc[cat.level] || 0) + 1;
      return acc;
    }, {} as Record<number, number>);

    Object.entries(byLevel).forEach(([level, count]) => {
      console.log(`  Nivel ${level}: ${count} categorías`);
    });

    console.log("\n📊 Categorías por sección:");
    const roots = categories.filter(c => c.level === 0);
    roots.forEach(root => {
      const children = categories.filter(c => c.parentId === root.id);
      console.log(`  ${root.name}: ${children.length + 1} items`);
    });

    console.log("\n✅ Verifica en Firebase Console:");
    console.log("   https://console.firebase.google.com/project/base-mayorista/firestore");

  } catch (error) {
    console.error("\n❌ Error durante la migración:", error);
    process.exit(1);
  }

  process.exit(0);
}

// Ejecutar
migrateCategories();
