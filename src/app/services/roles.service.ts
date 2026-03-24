import { Injectable } from "@angular/core";
import { collection, doc, getDoc, getDocs, serverTimestamp, setDoc } from "firebase/firestore";
import {
  CAPABILITY_KEYS,
  DEFAULT_ROLE_PRESETS,
  ROLE_IDS,
  SECTION_KEYS,
  RoleDoc,
  RoleId,
  buildRolePreset,
  normalizeCapabilitiesMap,
  normalizeRoleId,
  normalizeSectionsMap,
  roleLabel,
} from "../core/rbac.constants";
import { FIRESTORE } from "../core/firebase.providers";

@Injectable({ providedIn: "root" })
export class RolesService {
  private ensureSeedPromise: Promise<void> | null = null;
  private seeded = false;
  private roleCache = new Map<RoleId, RoleDoc>();

  async ensureDefaultsSeeded(): Promise<void> {
    if (this.seeded) return;
    if (this.ensureSeedPromise) return this.ensureSeedPromise;
    this.ensureSeedPromise = this.seedDefaults();
    try {
      await this.ensureSeedPromise;
      this.seeded = true;
    } finally {
      this.ensureSeedPromise = null;
    }
  }

  async listRoles(): Promise<RoleDoc[]> {
    await this.ensureDefaultsSeeded();
    const snap = await getDocs(collection(FIRESTORE, "roles"));
    const rows = snap.docs.map((entry) => this.normalizeRoleDoc(entry.id, entry.data()));
    for (const row of rows) this.roleCache.set(row.roleId, row);
    return rows.sort((a, b) => ROLE_IDS.indexOf(a.roleId) - ROLE_IDS.indexOf(b.roleId));
  }

  async getRole(roleId: RoleId): Promise<RoleDoc> {
    const cached = this.roleCache.get(roleId);
    if (cached) return cached;

    await this.ensureDefaultsSeeded();
    const ref = doc(FIRESTORE, "roles", roleId);
    const snap = await getDoc(ref);
    if (!snap.exists()) {
      const fallback = buildRolePreset(roleId);
      await setDoc(ref, {
        roleId,
        label: fallback.label,
        sections: fallback.sections,
        capabilities: fallback.capabilities,
        updatedAt: serverTimestamp(),
      });
      this.roleCache.set(roleId, fallback);
      return fallback;
    }
    const normalized = this.normalizeRoleDoc(snap.id, snap.data());
    this.roleCache.set(roleId, normalized);
    return normalized;
  }

  async saveRole(role: Pick<RoleDoc, "roleId" | "label" | "sections" | "capabilities">): Promise<void> {
    const roleId = normalizeRoleId(role.roleId);
    const payload = {
      roleId,
      label: role.label || roleLabel(roleId),
      sections: normalizeSectionsMap(role.sections),
      capabilities: normalizeCapabilitiesMap(role.capabilities),
      updatedAt: serverTimestamp(),
    };
    await setDoc(doc(FIRESTORE, "roles", roleId), payload, { merge: true });
    this.roleCache.set(roleId, {
      roleId,
      label: payload.label,
      sections: payload.sections,
      capabilities: payload.capabilities,
      updatedAt: null,
    });
  }

  private async seedDefaults(): Promise<void> {
    for (const roleId of ROLE_IDS) {
      const ref = doc(FIRESTORE, "roles", roleId);
      const current = await getDoc(ref);
      const preset = DEFAULT_ROLE_PRESETS[roleId];
      if (!current.exists()) {
        await setDoc(ref, {
          roleId,
          label: preset.label,
          sections: preset.sections,
          capabilities: preset.capabilities,
          updatedAt: serverTimestamp(),
        });
        continue;
      }

      const normalized = this.normalizeRoleDoc(current.id, current.data());
      const needsSync =
        Object.keys(normalized.sections).length !== Object.keys(preset.sections).length ||
        Object.keys(normalized.capabilities).length !== Object.keys(preset.capabilities).length;
      if (!needsSync) continue;

      await setDoc(
        ref,
        {
          sections: normalizeSectionsMap({ ...preset.sections, ...normalized.sections }),
          capabilities: normalizeCapabilitiesMap({ ...preset.capabilities, ...normalized.capabilities }),
          label: normalized.label || preset.label,
          updatedAt: serverTimestamp(),
        },
        { merge: true },
      );
    }
  }

  private normalizeRoleDoc(rawId: string, data: Record<string, any>): RoleDoc {
    const roleId = normalizeRoleId(data["roleId"] || rawId);
    const preset = buildRolePreset(roleId);
    const sections =
      this.normalizeSectionsFromAny(data["sections"]) ?? this.normalizeSectionsFromAny(data["permissions"]) ?? { ...preset.sections };
    const capabilities = this.normalizeCapabilitiesFromAny(data["capabilities"]) ?? { ...preset.capabilities };
    return {
      roleId,
      label: (data["label"] || roleLabel(roleId)).toString(),
      sections,
      capabilities,
      updatedAt: data["updatedAt"] ?? null,
    };
  }

  private normalizeSectionsFromAny(raw: unknown): RoleDoc["sections"] | null {
    if (!raw || typeof raw !== "object") return null;
    const map = raw as Record<string, unknown>;

    const hasCanonical = SECTION_KEYS.some((key) => key in map);
    if (hasCanonical) {
      return normalizeSectionsMap(map);
    }

    const hasShort =
      "dashboard" in map ||
      "validacion" in map ||
      "pedidos" in map ||
      "catalogo" in map ||
      "categorias" in map ||
      "proveedores" in map ||
      "inventario" in map ||
      "administracion" in map ||
      "clientes" in map ||
      "rutas" in map ||
      "localidades" in map ||
      "salidas" in map ||
      "usuarios" in map;
    if (!hasShort) return null;

    return normalizeSectionsMap({
      "sections.dashboard": map["dashboard"],
      "sections.validacion": map["validacion"],
      "sections.pedidos": map["pedidos"],
      "sections.catalogo": map["catalogo"],
      "sections.categorias": map["categorias"],
      "sections.proveedores": map["proveedores"],
      "sections.inventario": map["inventario"],
      "sections.administracion": map["administracion"],
      "sections.clientes": map["clientes"] ?? map["clientas"],
      "sections.rutas": map["rutas"],
      "sections.localidades": map["localidades"],
      "sections.salidas": map["salidas"],
      "sections.usuarios": map["usuarios"],
    });
  }

  private normalizeCapabilitiesFromAny(raw: unknown): RoleDoc["capabilities"] | null {
    if (!raw || typeof raw !== "object") return null;
    const map = raw as Record<string, unknown>;
    const hasCanonical = CAPABILITY_KEYS.some((key) => key in map);
    if (!hasCanonical) return null;
    return normalizeCapabilitiesMap(map);
  }
}
