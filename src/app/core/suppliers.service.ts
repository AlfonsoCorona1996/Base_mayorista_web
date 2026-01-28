import { Injectable, signal } from "@angular/core";
import { FIRESTORE } from "./firebase.providers";
import { collection, getDocs, doc, setDoc, updateDoc, query, orderBy } from "firebase/firestore";

export interface Supplier {
  supplier_id: string;
  display_name: string;
  contact_phone?: string;
  contact_name?: string;
  active: boolean;
  created_at: any;
  notes?: string;
}

/**
 * Servicio de proveedores
 * 
 * TODO: Completar CRUD en Firestore collection "suppliers"
 * Por ahora lista demo + métodos para cargar de Firestore
 */
@Injectable({ providedIn: "root" })
export class SuppliersService {
  private colRef = collection(FIRESTORE, "suppliers");

  // Lista demo para empezar
  private demoSuppliers: Supplier[] = [
    {
      supplier_id: "frodam",
      display_name: "Frodam (Tenis)",
      contact_phone: "+52 33 1234 5678",
      contact_name: "Juan Pérez",
      active: true,
      created_at: new Date(),
      notes: "Proveedor principal de tenis. Cada imagen = una variant."
    },
    {
      supplier_id: "corseteria_guadalupana",
      display_name: "Corsetería Guadalupana",
      contact_phone: "+52 33 9876 5432",
      contact_name: "María López",
      active: true,
      created_at: new Date(),
      notes: "Pijamas, lencería. Usa emojis y 'Unitalla'."
    },
    {
      supplier_id: "miel_canela",
      display_name: "Miel & Canela",
      contact_phone: "+52 33 5555 1234",
      active: true,
      created_at: new Date(),
      notes: "Solo imágenes con precios incrustados."
    },
    {
      supplier_id: "demo_generico",
      display_name: "Proveedor Genérico",
      active: false,
      created_at: new Date(),
      notes: "Proveedor de prueba inactivo."
    }
  ];

  suppliers = signal<Supplier[]>(this.demoSuppliers);

  constructor() {
    // Cargar proveedores reales de Firestore al inicio
    this.loadFromFirestore().catch((e) => {
      console.warn("No se pudieron cargar proveedores de Firestore, usando demo:", e);
    });
  }

  /**
   * Carga proveedores desde Firestore
   */
  async loadFromFirestore(): Promise<void> {
    try {
      const q = query(this.colRef, orderBy("display_name", "asc"));
      const snap = await getDocs(q);
      
      if (!snap.empty) {
        const loaded = snap.docs.map((d) => d.data() as Supplier);
        this.suppliers.set(loaded);
      }
    } catch (e) {
      console.error("Error cargando proveedores:", e);
      // Mantener lista demo si falla
    }
  }

  /**
   * Obtiene solo proveedores activos
   */
  getActive(): Supplier[] {
    return this.suppliers().filter((s) => s.active);
  }

  /**
   * Obtiene proveedor por ID
   */
  getById(id: string): Supplier | null {
    return this.suppliers().find((s) => s.supplier_id === id) || null;
  }

  /**
   * Crea o actualiza un proveedor
   */
  async save(supplier: Supplier): Promise<void> {
    const ref = doc(this.colRef, supplier.supplier_id);
    await setDoc(ref, supplier, { merge: true });
    
    // Recargar lista
    await this.loadFromFirestore();
  }

  /**
   * Desactiva un proveedor (no lo borra)
   */
  async deactivate(supplierId: string): Promise<void> {
    const ref = doc(this.colRef, supplierId);
    await updateDoc(ref, { active: false });
    
    await this.loadFromFirestore();
  }
}
