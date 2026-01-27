import { FIREBASE_AUTH, FIRESTORE } from "./firebase.providers";
import { onAuthStateChanged } from "firebase/auth";
import { doc, getDoc } from "firebase/firestore";

export async function firebaseSmokeTest() {
  console.log("Firebase Auth app name:", FIREBASE_AUTH.app.name);

  onAuthStateChanged(FIREBASE_AUTH, (user) => {
    console.log("Auth state:", user ? user.email : "signed out");
  });

  // Smoke read (solo si tus rules permiten; si no, fallará y es normal)
  try {
    const snap = await getDoc(doc(FIRESTORE, "_smoke", "ping"));
    console.log("Firestore smoke doc exists?", snap.exists());
  } catch (e) {
    console.warn("Firestore smoke read failed (ok if rules block it):", e);
  }
}
