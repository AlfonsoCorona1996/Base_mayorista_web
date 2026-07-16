import { Timestamp } from "firebase/firestore";

export const SECTION_KEYS = [
  "sections.dashboard",
  "sections.pedidos",
  "sections.proveedores",
  "sections.validacion",
  "sections.clientes",
  "sections.inventario",
  "sections.administracion",
  "sections.catalogo",
  "sections.categorias",
  "sections.rutas",
  "sections.localidades",
  "sections.salidas",
  "sections.embarques",
  "sections.durango",
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
  "cap.shipments.view",
  "cap.shipments.create",
  "cap.shipments.edit",
  "cap.shipments.send",
  "cap.shipments.receive",
  "cap.shipments.close",
  "cap.delivery.view",
  "cap.delivery.mark_delivered",
  "cap.delivery.mark_partial",
  "cap.delivery.report_incident",
  "cap.delivery.capture_proof",
  "cap.payments.view",
  "cap.payments.register",
  "cap.payments.refund",
  "cap.payments.override",
  "cap.settlement.view",
  "cap.settlement.send",
  "cap.settlement.reconcile",
  "cap.returns.view",
  "cap.returns.create",
  "cap.returns.approve",
  "cap.returns.restock",
  "cap.returns.close",
  "cap.incidents.view",
  "cap.incidents.create",
  "cap.incidents.resolve",
  "cap.finance.accounts.view",
  "cap.finance.accounts.create",
  "cap.finance.accounts.edit",
  "cap.finance.accounts.delete",
  "cap.finance.movements.view",
  "cap.finance.movements.create",
  "cap.finance.movements.edit",
  "cap.finance.movements.delete",
  "cap.finance.reports.view",
  "cap.audit.view",
] as const;

export const ROLE_IDS = ["super_admin", "admin", "administrativo", "operativo", "repartidor", "durango_operativo"] as const;
export const BUSINESS_IDS = ["bm", "catalogo"] as const;

export type SectionKey = (typeof SECTION_KEYS)[number];
export type CapabilityKey = (typeof CAPABILITY_KEYS)[number];
export type RoleId = (typeof ROLE_IDS)[number];
export type BusinessId = (typeof BUSINESS_IDS)[number];
export type BusinessScope = BusinessId | "both";

export type SectionsMap = Record<SectionKey, boolean>;
export type CapabilitiesMap = Record<CapabilityKey, boolean>;
export type SectionOverridesMap = Partial<Record<SectionKey, boolean>>;
export type CapabilityOverridesMap = Partial<Record<CapabilityKey, boolean>>;
export type BusinessMembershipsMap = Partial<Record<BusinessId, BusinessMembershipDoc>>;

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
  invitePending: boolean;
  mustChangePassword: boolean;
  sections: SectionsMap;
  capabilities: CapabilitiesMap;
  sectionOverrides: SectionOverridesMap;
  capabilityOverrides: CapabilityOverridesMap;
  businessMemberships: BusinessMembershipsMap;
  createdAt?: Timestamp | null;
  updatedAt?: Timestamp | null;
}

export interface BusinessMembershipDoc {
  businessId: BusinessId;
  enabled: boolean;
  roleId: RoleId;
  sections: SectionsMap;
  capabilities: CapabilitiesMap;
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
  if (
    value === "super_admin" ||
    value === "admin" ||
    value === "administrativo" ||
    value === "operativo" ||
    value === "repartidor" ||
    value === "durango_operativo"
  ) {
    return value;
  }
  return "operativo";
}

export function normalizeBusinessId(value: unknown): BusinessId {
  return value === "catalogo" ? "catalogo" : "bm";
}

export function businessLabel(value: BusinessId): string {
  return value === "catalogo" ? "Catalogo" : "Base Mayorista";
}

export function businessShortLabel(value: BusinessId): string {
  return value === "catalogo" ? "Catalogo" : "BM";
}

export function normalizeBusinessMembershipsMap(
  raw: unknown,
  fallbackRoleId: RoleId,
  fallbackSections: SectionsMap,
  fallbackCapabilities: CapabilitiesMap,
  includeAllForSuperAdmin = false,
): BusinessMembershipsMap {
  const out: BusinessMembershipsMap = {};
  const source = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};

  for (const businessId of BUSINESS_IDS) {
    const rawMembership = source[businessId];
    if (!rawMembership || typeof rawMembership !== "object") continue;
    const membership = rawMembership as Record<string, unknown>;
    const roleId = normalizeRoleId(membership["roleId"] || fallbackRoleId);
    const preset = buildRolePreset(roleId);
    out[businessId] = {
      businessId,
      enabled: Boolean(membership["enabled"] ?? true),
      roleId,
      sections: normalizeSectionsMap((membership["sections"] as Record<string, unknown> | null) || preset.sections),
      capabilities: normalizeCapabilitiesMap(
        (membership["capabilities"] as Record<string, unknown> | null) || preset.capabilities,
      ),
    };
  }

  if (!out.bm) {
    out.bm = {
      businessId: "bm",
      enabled: true,
      roleId: fallbackRoleId,
      sections: normalizeSectionsMap(fallbackSections),
      capabilities: normalizeCapabilitiesMap(fallbackCapabilities),
    };
  }

  if (includeAllForSuperAdmin && !out.catalogo) {
    out.catalogo = {
      businessId: "catalogo",
      enabled: true,
      roleId: "super_admin",
      sections: buildSectionsMap(true),
      capabilities: buildCapabilitiesMap(true),
    };
  }

  return out;
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
  if (roleId === "administrativo") return "Administrativo";
  if (roleId === "operativo") return "Operativo";
  if (roleId === "durango_operativo") return "Durango operativo";
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
      "cap.shipments.",
      "cap.settlement.",
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
      "cap.payments.refund",
      "cap.audit.view",
    ]);
    capabilities["cap.roles.edit"] = false;
    capabilities["cap.payments.override"] = false;
    capabilities["cap.inventory.override"] = false;
  } else if (roleId === "administrativo") {
    applySectionKeys(sections, [
      "sections.pedidos",
      "sections.proveedores",
      "sections.validacion",
      "sections.clientes",
      "sections.inventario",
      "sections.salidas",
      "sections.embarques",
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
      "cap.returns.view",
      "cap.returns.create",
      "cap.returns.approve",
      "cap.returns.restock",
      "cap.packing.view",
      "cap.packing.box.create",
      "cap.packing.box.edit_open",
      "cap.packing.box.close",
      "cap.packing.label.print",
      "cap.packing.finish",
      "cap.dispatch.request",
      "cap.dispatch.cancel_request",
      "cap.shipments.view",
      "cap.shipments.create",
      "cap.shipments.edit",
      "cap.shipments.send",
      "cap.shipments.receive",
      "cap.shipments.close",
      "cap.incidents.view",
      "cap.incidents.create",
      "cap.incidents.resolve",
    ]);
    capabilities["cap.packing.box.reopen"] = false;
  } else if (roleId === "operativo") {
    applySectionKeys(sections, [
      "sections.pedidos",
      "sections.proveedores",
      "sections.validacion",
      "sections.clientes",
      "sections.inventario",
      "sections.salidas",
      "sections.embarques",
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
      "cap.shipments.view",
      "cap.shipments.create",
      "cap.shipments.edit",
      "cap.shipments.send",
      "cap.shipments.receive",
      "cap.incidents.view",
      "cap.incidents.create",
      "cap.incidents.resolve",
      "cap.settlement.view",
      "cap.settlement.reconcile",
    ]);
    capabilities["cap.packing.box.reopen"] = false;
  } else if (roleId === "durango_operativo") {
    applySectionKeys(sections, ["sections.durango"]);
    applyCapabilityKeys(capabilities, [
      "cap.orders.view",
      "cap.packing.view",
      "cap.packing.box.create",
      "cap.packing.box.edit_open",
      "cap.packing.box.close",
      "cap.packing.finish",
      "cap.shipments.view",
      "cap.shipments.receive",
      "cap.delivery.view",
      "cap.delivery.mark_delivered",
      "cap.delivery.mark_partial",
      "cap.delivery.report_incident",
      "cap.payments.view",
      "cap.payments.register",
      "cap.settlement.view",
      "cap.settlement.send",
      "cap.incidents.view",
      "cap.incidents.create",
    ]);
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
      "cap.settlement.view",
      "cap.settlement.send",
      "cap.incidents.create",
      "cap.incidents.view",
    ]);
  }

  if (roleId === "admin" || roleId === "administrativo") {
    sections["sections.administracion"] = true;
    applyCapabilityKeys(capabilities, [
      "cap.finance.accounts.view",
      "cap.finance.accounts.create",
      "cap.finance.accounts.edit",
      "cap.finance.accounts.delete",
      "cap.finance.movements.view",
      "cap.finance.movements.create",
      "cap.finance.movements.edit",
      "cap.finance.movements.delete",
      "cap.finance.reports.view",
    ]);
  } else {
    sections["sections.administracion"] = false;
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
  administrativo: buildRolePreset("administrativo"),
  operativo: buildRolePreset("operativo"),
  repartidor: buildRolePreset("repartidor"),
  durango_operativo: buildRolePreset("durango_operativo"),
};

/** Etiquetas en español para cada sección del sistema. */
export const SECTION_LABELS: Record<SectionKey, string> = {
  "sections.dashboard": "Dashboard",
  "sections.pedidos": "Pedidos",
  "sections.proveedores": "Proveedores",
  "sections.validacion": "Validación de catálogo",
  "sections.clientes": "Clientas",
  "sections.inventario": "Inventario",
  "sections.administracion": "Administración financiera",
  "sections.catalogo": "Catálogo de productos",
  "sections.categorias": "Categorías",
  "sections.rutas": "Rutas y entregas",
  "sections.localidades": "Localidades",
  "sections.salidas": "Salidas y empaque",
  "sections.embarques": "Embarques GDL-Durango",
  "sections.durango": "Operación Durango",
  "sections.usuarios": "Usuarios y roles",
};

/** Etiquetas en español para cada capability del sistema. */
export const CAPABILITY_LABELS: Record<CapabilityKey, string> = {
  // Usuarios
  "cap.users.view": "Ver usuarios",
  "cap.users.invite": "Invitar usuarios",
  "cap.users.edit": "Editar usuarios",
  "cap.users.disable": "Desactivar usuarios",
  // Roles
  "cap.roles.view": "Ver roles",
  "cap.roles.edit": "Editar roles",
  // Pedidos
  "cap.orders.view": "Ver pedidos",
  "cap.orders.create": "Crear pedidos",
  "cap.orders.edit": "Editar pedidos",
  "cap.orders.delete": "Eliminar pedidos",
  "cap.orders.items.add": "Agregar artículos al pedido",
  "cap.orders.items.edit": "Editar artículos del pedido",
  "cap.orders.items.remove": "Quitar artículos del pedido",
  "cap.orders.override_stage_lock": "Forzar cambio de etapa",
  // Validación
  "cap.validation.view": "Ver validaciones pendientes",
  "cap.validation.confirm_stock": "Confirmar stock disponible",
  "cap.validation.override_stock": "Forzar confirmación de stock",
  // Operaciones proveedor
  "cap.suppliers.ops.view": "Ver operaciones de proveedores",
  "cap.suppliers.ops.advance_state": "Avanzar estado de operación",
  "cap.suppliers.ops.partial_process": "Procesar operación parcial",
  "cap.suppliers.ops.override": "Forzar operación de proveedor",
  // Inventario
  "cap.inventory.view": "Ver inventario",
  "cap.inventory.adjust": "Ajustar inventario",
  "cap.inventory.receive": "Recibir mercancía",
  "cap.inventory.reserve": "Reservar stock",
  "cap.inventory.release": "Liberar stock reservado",
  "cap.inventory.transfer": "Transferir stock entre ubicaciones",
  "cap.inventory.override": "Forzar operación de inventario",
  // Empaque
  "cap.packing.view": "Ver empaque",
  "cap.packing.box.create": "Crear caja",
  "cap.packing.box.edit_open": "Editar caja abierta",
  "cap.packing.box.close": "Cerrar caja",
  "cap.packing.box.reopen": "Reabrir caja cerrada",
  "cap.packing.label.print": "Imprimir etiquetas",
  "cap.packing.finish": "Finalizar empaque del pedido",
  // Despacho
  "cap.dispatch.request": "Solicitar despacho",
  "cap.dispatch.cancel_request": "Cancelar solicitud de despacho",
  "cap.dispatch.accept_request": "Aceptar solicitud de despacho",
  "cap.dispatch.reject_request": "Rechazar solicitud de despacho",
  // Rutas
  "cap.runs.view": "Ver rutas",
  "cap.runs.create": "Crear ruta",
  "cap.runs.schedule": "Programar ruta",
  "cap.runs.assign_driver": "Asignar repartidor",
  "cap.runs.add_order": "Agregar pedido a ruta",
  "cap.runs.remove_order": "Quitar pedido de ruta",
  "cap.runs.start": "Iniciar ruta",
  "cap.runs.complete": "Completar ruta",
  "cap.runs.cancel": "Cancelar ruta",
  // Transferencias
  "cap.transfers.create": "Crear transferencia",
  "cap.transfers.execute": "Ejecutar transferencia",
  // Embarques
  "cap.shipments.view": "Ver embarques",
  "cap.shipments.create": "Crear embarques",
  "cap.shipments.edit": "Editar embarques",
  "cap.shipments.send": "Marcar embarque enviado",
  "cap.shipments.receive": "Recibir embarque",
  "cap.shipments.close": "Cerrar embarque",
  // Entregas
  "cap.delivery.view": "Ver entregas",
  "cap.delivery.mark_delivered": "Marcar como entregado",
  "cap.delivery.mark_partial": "Marcar entrega parcial",
  "cap.delivery.report_incident": "Reportar incidencia en entrega",
  "cap.delivery.capture_proof": "Capturar comprobante de entrega",
  // Pagos
  "cap.payments.view": "Ver pagos",
  "cap.payments.register": "Registrar pago",
  "cap.payments.refund": "Reembolsar pago",
  "cap.payments.override": "Forzar pago",
  // Conciliación
  "cap.settlement.view": "Ver conciliación",
  "cap.settlement.send": "Registrar dinero enviado",
  "cap.settlement.reconcile": "Conciliar dinero recibido",
  // Devoluciones
  "cap.returns.view": "Ver devoluciones",
  "cap.returns.create": "Crear devolución",
  "cap.returns.approve": "Aprobar devolución",
  "cap.returns.restock": "Restituir mercancía a inventario",
  "cap.returns.close": "Cerrar devolución",
  // Incidencias
  "cap.incidents.view": "Ver incidencias",
  "cap.incidents.create": "Crear incidencia",
  "cap.incidents.resolve": "Resolver incidencia",
  // Finanzas
  "cap.finance.accounts.view": "Ver cuentas financieras",
  "cap.finance.accounts.create": "Crear cuenta financiera",
  "cap.finance.accounts.edit": "Editar cuenta financiera",
  "cap.finance.accounts.delete": "Eliminar cuenta financiera",
  "cap.finance.movements.view": "Ver movimientos financieros",
  "cap.finance.movements.create": "Registrar movimiento financiero",
  "cap.finance.movements.edit": "Editar movimiento financiero",
  "cap.finance.movements.delete": "Eliminar movimiento financiero",
  "cap.finance.reports.view": "Ver reportes financieros",
  // Auditoría
  "cap.audit.view": "Ver auditoría del sistema",
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
