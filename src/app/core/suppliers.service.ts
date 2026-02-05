import { Injectable, signal } from "@angular/core";
import { FIRESTORE } from "./firebase.providers";
import { collection, doc, getDocs, orderBy, query, serverTimestamp, setDoc, updateDoc } from "firebase/firestore";

export interface Supplier {
  supplier_id: string;
  display_name: string;
  contact_phone?: string;
  contact_name?: string;
  active: boolean;
  created_at?: any;
  updated_at?: any;
  notes?: string;
}

@Injectable({ providedIn: "root" })
export class SuppliersService {
  private colRef = collection(FIRESTORE, "suppliers");

  // Fallback local para entorno sin datos remotos.
  private demoSuppliers: Supplier[] = [
    {
      supplier_id: "frodam",
      display_name: "Frodam (Tenis)",
      contact_phone: "+52 33 1234 5678",
      contact_name: "Juan Perez",
      active: true,
      created_at: new Date(),
      notes: "Proveedor principal de tenis. Cada imagen = una variante.",
    },
    {
      supplier_id: "corseteria_guadalupana",
      display_name: "Corseteria Guadalupana",
      contact_phone: "+52 33 9876 5432",
      contact_name: "Maria Lopez",
      active: true,
      created_at: new Date(),
      notes: "Pijamas y lenceria. Usa talla unica en muchos productos.",
    },
  ];

  suppliers = signal<Supplier[]>(this.demoSuppliers);

  constructor() {
    this.loadFromFirestore().catch((error) => {
      console.warn("No se pudieron cargar proveedores desde Firestore. Se usa fallback local.", error);
    });
  }

  async loadFromFirestore(): Promise<void> {
    try {
      const q = query(this.colRef, orderBy("display_name", "asc"));
      const snap = await getDocs(q);

      const loaded = snap.docs.map((entry) => {
        const data = entry.data() as Partial<Supplier>;
        return this.normalizeSupplier(data, entry.id);
      });

      this.suppliers.set(loaded);
    } catch (error) {
      console.error("Error cargando proveedores:", error);
      // En error real mantenemos la ultima lista disponible.
    }
  }

  getActive(): Supplier[] {
    return this.suppliers().filter((supplier) => supplier.active);
  }

  getById(id: string): Supplier | null {
    return this.suppliers().find((supplier) => supplier.supplier_id === id) || null;
  }

  async save(supplier: Supplier): Promise<void> {
    const supplierId = (supplier.supplier_id || "").trim();
    if (!supplierId) throw new Error("supplier_id requerido");

    const now = serverTimestamp();
    const payload: Supplier = {
      ...supplier,
      supplier_id: supplierId,
      display_name: (supplier.display_name || supplierId).trim(),
      active: supplier.active ?? true,
      created_at: supplier.created_at ?? now,
      updated_at: now,
    };

    await setDoc(doc(this.colRef, supplierId), payload, { merge: true });
    await this.loadFromFirestore();
  }

  async setActive(supplierId: string, active: boolean): Promise<void> {
    const ref = doc(this.colRef, supplierId);
    await updateDoc(ref, {
      active,
      updated_at: serverTimestamp(),
    });
    await this.loadFromFirestore();
  }

  async deactivate(supplierId: string): Promise<void> {
    await this.setActive(supplierId, false);
  }

  private normalizeSupplier(data: Partial<Supplier>, fallbackId: string): Supplier {
    const supplierId = (data.supplier_id || fallbackId || "").trim();
    return {
      supplier_id: supplierId,
      display_name: (data.display_name || supplierId).trim(),
      contact_phone: data.contact_phone || "",
      contact_name: data.contact_name || "",
      active: data.active ?? true,
      created_at: data.created_at ?? null,
      updated_at: data.updated_at ?? null,
      notes: data.notes || "",
    };
  }
}