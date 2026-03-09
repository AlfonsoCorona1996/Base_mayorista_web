import { Timestamp } from "firebase/firestore";

export const SECTION_KEYS = [
  "sections.dashboard",
  "sections.pedidos",
  "sections.proveedores",
  "sections.validacion",
  "sections.clientes",
  "sections.inventario",
  "sections.catalogo",
  "sections.categorias",
  "sections.rutas",
  "sections.localidades",
  "sections.salidas",
  "sections.usuarios",
] as const;

export const CAPABILITY_KEYS = [
  "cap.users.view",
  "cap.users.invite",
  "cap.users.edit",
  "cap.users.disable",
  "cap.roles.view",
  "cap.roles.edit",
  "cap.orders.view",
  "cap.orders.create",
  "cap.orders.edit",
  "cap.orders.delete",
  "cap.orders.items.add",
  "cap.orders.items.edit",
  "cap.orders.items.remove",
  "cap.orders.override_stage_lock",
  "cap.validation.view",
  "cap.validation.confirm_stock",
  "cap.validation.override_stock",
  "cap.suppliers.ops.view",
  "cap.suppliers.ops.advance_state",
  "cap.suppliers.ops.partial_process",
  "cap.suppliers.ops.override",
  "cap.inventory.view",
  "cap.inventory.adjust",
  "cap.inventory.receive",
  "cap.inventory.reserve",
  "cap.inventory.release",
  "cap.inventory.transfer",
  "cap.inventory.override",
  "cap.packing.view",
  "cap.packing.box.create",
  "cap.packing.box.edit_open",
  "cap.packing.box.close",
  "cap.packing.box.reopen",
  "cap.packing.label.print",
  "cap.packing.finish",
  "cap.dispatch.request",
  "cap.dispatch.cancel_request",
  "cap.dispatch.accept_request",
  "cap.dispatch.reject_request",
  "cap.runs.view",
  "cap.runs.create",
  "cap.runs.schedule",
  "cap.runs.assign_driver",
  "cap.runs.add_order",
  "cap.runs.remove_order",
  "cap.runs.start",
  "cap.runs.complete",
  "cap.runs.cancel",
  "cap.transfers.create",
  "cap.transfers.execute",
  "cap.delivery.view",
  "cap.delivery.mark_delivered",
  "cap.delivery.mark_partial",
  "cap.delivery.report_incident",
  "cap.delivery.capture_proof",
  "cap.payments.view",
  "cap.payments.register",
  "cap.payments.refund",
  "cap.payments.override",
  "cap.returns.view",
  "cap.returns.create",
  "cap.returns.approve",
  "cap.returns.restock",
  "cap.returns.close",
  "cap.incidents.view",
  "cap.incidents.create",
  "cap.incidents.resolve",
  "cap.audit.view",
] as const;

export const ROLE_IDS = ["super_admin", "admin", "operativo", "repartidor"] as const;

export type SectionKey = (typeof SECTION_KEYS)[number];
export type CapabilityKey = (typeof CAPABILITY_KEYS)[number];
export type RoleId = (typeof ROLE_IDS)[number];

export type SectionsMap = Record<SectionKey, boolean>;
export type CapabilitiesMap = Record<CapabilityKey, boolean>;
export type SectionOverridesMap = Partial<Record<SectionKey, boolean>>;
export type CapabilityOverridesMap = Partial<Record<CapabilityKey, boolean>>;

export const USERNAME_AUTH_DOMAIN = "users.base-mayorista.local";

export type UserLoginType = "email" | "username";

export interface UserDoc {
  uid: string;
  email: string;
  authEmail: string;
  username: string;
  loginType: UserLoginType;
  displayName: string;
  roleId: RoleId;
  isActive: boolean;
  mustChangePassword: boolean;
  sections: SectionsMap;
  capabilities: CapabilitiesMap;
  sectionOverrides: SectionOverridesMap;
  capabilityOverrides: CapabilityOverridesMap;
  createdAt?: Timestamp | null;
  updatedAt?: Timestamp | null;
}

export interface RoleDoc {
  roleId: RoleId;
  label: string;
  sections: SectionsMap;
  capabilities: CapabilitiesMap;
  updatedAt?: Timestamp | null;
}

export function buildSectionsMap(defaultValue = false): SectionsMap {
  const out = {} as SectionsMap;
  for (const key of SECTION_KEYS) out[key] = defaultValue;
  return out;
}

export function buildCapabilitiesMap(defaultValue = false): CapabilitiesMap {
  const out = {} as CapabilitiesMap;
  for (const key of CAPABILITY_KEYS) out[key] = defaultValue;
  return out;
}

export function normalizeRoleId(value: unknown): RoleId {
  if (value === "super_admin" || value === "admin" || value === "operativo" || value === "repartidor") {
    return value;
  }
  if (value === "administrativo") return "operativo";
  return "operativo";
}

export function normalizeUsername(value: unknown): string {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, "");
}

export function buildUsernameAuthEmail(username: string): string {
  const normalized = normalizeUsername(username);
  if (!normalized) return "";
  return `${normalized}@${USERNAME_AUTH_DOMAIN}`;
}

export function isUsernameAuthEmail(value: unknown): boolean {
  const raw = String(value ?? "").trim().toLowerCase();
  return raw.endsWith(`@${USERNAME_AUTH_DOMAIN}`);
}

function applySectionKeys(target: SectionsMap, keys: SectionKey[]) {
  for (const key of keys) target[key] = true;
}

function applyCapabilityKeys(target: CapabilitiesMap, keys: CapabilityKey[]) {
  for (const key of keys) target[key] = true;
}

function applyCapabilityPrefixes(target: CapabilitiesMap, prefixes: string[]) {
  for (const key of CAPABILITY_KEYS) {
    if (prefixes.some((prefix) => key.startsWith(prefix))) {
      target[key] = true;
    }
  }
}

function allSectionsTrue(): SectionsMap {
  return buildSectionsMap(true);
}

function allCapabilitiesTrue(): CapabilitiesMap {
  return buildCapabilitiesMap(true);
}

export function roleLabel(roleId: RoleId): string {
  if (roleId === "super_admin") return "Super admin";
  if (roleId === "admin") return "Admin";
  if (roleId === "operativo") return "Operativo";
  return "Repartidor";
}

export function buildRolePreset(roleId: RoleId): RoleDoc {
  if (roleId === "super_admin") {
    return {
      roleId,
      label: roleLabel(roleId),
      sections: allSectionsTrue(),
      capabilities: allCapabilitiesTrue(),
      updatedAt: null,
    };
  }

  const sections = buildSectionsMap(false);
  const capabilities = buildCapabilitiesMap(false);

  if (roleId === "admin") {
    applySectionKeys(sections, [...SECTION_KEYS]);
    applyCapabilityPrefixes(capabilities, [
      "cap.orders.",
      "cap.validation.",
      "cap.suppliers.ops.",
      "cap.inventory.",
      "cap.packing.",
      "cap.runs.",
      "cap.incidents.",
      "cap.returns.",
    ]);
    applyCapabilityKeys(capabilities, [
      "cap.users.view",
      "cap.users.edit",
      "cap.users.disable",
      "cap.roles.view",
      "cap.dispatch.request",
      "cap.dispatch.cancel_request",
      "cap.dispatch.accept_request",
      "cap.dispatch.reject_request",
      "cap.transfers.create",
      "cap.transfers.execute",
      "cap.payments.view",
      "cap.payments.register",
      "cap.audit.view",
    ]);
    capabilities["cap.roles.edit"] = false;
    capabilities["cap.payments.override"] = false;
    capabilities["cap.inventory.override"] = false;
  } else if (roleId === "operativo") {
    applySectionKeys(sections, [
      "sections.pedidos",
      "sections.proveedores",
      "sections.validacion",
      "sections.clientes",
      "sections.inventario",
      "sections.salidas",
    ]);
    applyCapabilityKeys(capabilities, [
      "cap.orders.view",
      "cap.validation.confirm_stock",
      "cap.suppliers.ops.advance_state",
      "cap.suppliers.ops.partial_process",
      "cap.inventory.view",
      "cap.inventory.receive",
      "cap.inventory.reserve",
      "cap.inventory.release",
      "cap.packing.view",
      "cap.packing.box.create",
      "cap.packing.box.edit_open",
      "cap.packing.box.close",
      "cap.packing.label.print",
      "cap.packing.finish",
      "cap.dispatch.request",
      "cap.dispatch.cancel_request",
      "cap.incidents.view",
      "cap.incidents.create",
      "cap.incidents.resolve",
    ]);
    capabilities["cap.packing.box.reopen"] = false;
  } else {
    applySectionKeys(sections, ["sections.salidas", "sections.pedidos"]);
    applyCapabilityKeys(capabilities, [
      "cap.orders.view",
      "cap.runs.view",
      "cap.delivery.view",
      "cap.delivery.mark_delivered",
      "cap.delivery.mark_partial",
      "cap.delivery.report_incident",
      "cap.delivery.capture_proof",
      "cap.payments.view",
      "cap.payments.register",
      "cap.incidents.create",
      "cap.incidents.view",
    ]);
  }

  return {
    roleId,
    label: roleLabel(roleId),
    sections,
    capabilities,
    updatedAt: null,
  };
}

export const DEFAULT_ROLE_PRESETS: Record<RoleId, RoleDoc> = {
  super_admin: buildRolePreset("super_admin"),
  admin: buildRolePreset("admin"),
  operativo: buildRolePreset("operativo"),
  repartidor: buildRolePreset("repartidor"),
};

export function normalizeSectionsMap(raw: Partial<Record<string, unknown>> | null | undefined): SectionsMap {
  const out = buildSectionsMap(false);
  for (const key of SECTION_KEYS) {
    out[key] = Boolean(raw?.[key]);
  }
  return out;
}

export function normalizeCapabilitiesMap(raw: Partial<Record<string, unknown>> | null | undefined): CapabilitiesMap {
  const out = buildCapabilitiesMap(false);
  for (const key of CAPABILITY_KEYS) {
    out[key] = Boolean(raw?.[key]);
  }
  return out;
}

export function normalizeSectionOverridesMap(
  raw: Partial<Record<string, unknown>> | null | undefined,
): SectionOverridesMap {
  const out: SectionOverridesMap = {};
  for (const key of SECTION_KEYS) {
    const value = raw?.[key];
    if (typeof value === "boolean") out[key] = value;
  }
  return out;
}

export function normalizeCapabilityOverridesMap(
  raw: Partial<Record<string, unknown>> | null | undefined,
): CapabilityOverridesMap {
  const out: CapabilityOverridesMap = {};
  for (const key of CAPABILITY_KEYS) {
    const value = raw?.[key];
    if (typeof value === "boolean") out[key] = value;
  }
  return out;
}
