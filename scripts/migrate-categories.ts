/**
 * Script para migrar categorías a Firebase Firestore
 * 
 * Uso:
 *   npx tsx scripts/migrate-categories.ts
 */

import { initializeApp } from "firebase/app";
import { getFirestore, collection, doc, setDoc, writeBatch } from "firebase/firestore";
import { CATEGORIES_TREE, flattenCategories } from "./categories-data";

// IMPORTANTE: Usa tu configuración de Firebase
const firebaseConfig = {
  apiKey: "TU_API_KEY",
  authDomain: "TU_AUTH_DOMAIN",
  projectId: "TU_PROJECT_ID",
  storageBucket: "TU_STORAGE_BUCKET",
  messagingSenderId: "TU_SENDER_ID",
  appId: "TU_APP_ID"
};

async function migrateCategories() {
  console.log("🚀 Iniciando migración de categorías...\n");

  // Inicializar Firebase
  const app = initializeApp(firebaseConfig);
  const db = getFirestore(app);

  // Obtener lista plana de categorías
  const categories = flattenCategories(CATEGORIES_TREE);
  console.log(`📦 Total de categorías: ${categories.length}\n`);

  // Migrar en lotes de 500 (límite de Firestore)
  const batchSize = 500;
  let processed = 0;

  for (let i = 0; i < categories.length; i += batchSize) {
    const batch = writeBatch(db);
    const chunk = categories.slice(i, i + batchSize);

    for (const category of chunk) {
      const docRef = doc(db, "categories", category.id);
      batch.set(docRef, {
        ...category,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
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

  process.exit(0);
}

// Ejecutar
migrateCategories().catch((error) => {
  console.error("❌ Error durante la migración:", error);
  process.exit(1);
});
