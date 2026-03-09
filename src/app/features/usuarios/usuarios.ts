import { Component, computed, inject, signal } from "@angular/core";
import { FormsModule } from "@angular/forms";
import { environment } from "../../../environments/environment";
import { AuthzService } from "../../core/authz.service";
import {
  CAPABILITY_KEYS,
  CapabilityKey,
  CapabilityOverridesMap,
  RoleDoc,
  ROLE_IDS,
  RoleId,
  SECTION_KEYS,
  SectionKey,
  SectionsMap,
  SectionOverridesMap,
  UserDoc,
  UserLoginType,
  normalizeCapabilityOverridesMap,
  buildRolePreset,
  buildUsernameAuthEmail,
  normalizeCapabilitiesMap,
  normalizeSectionOverridesMap,
  normalizeSectionsMap,
  normalizeUsername,
  roleLabel,
} from "../../core/rbac.constants";
import { RolesService } from "../../services/roles.service";
import { UsersService } from "../../services/users.service";
import {
  AdminPermissionsPayload,
  CreateManagedUserInput,
  ListManagedUserRow,
  UserAdminApiService,
} from "../../services/user-admin-api.service";
import { ImpersonationService } from "../../core/impersonation.service";

type UsersTab = "users" | "roles";

type CapabilityGroup = {
  title: string;
  keys: CapabilityKey[];
};

type UserDraft = {
  uid: string;
  email: string;
  authEmail: string;
  username: string;
  loginType: UserLoginType;
  displayName: string;
  roleId: RoleId;
  isActive: boolean;
  mustChangePassword: boolean;
  sectionOverrides: SectionOverridesMap;
  capabilityOverrides: CapabilityOverridesMap;
};

const CAPABILITY_GROUPS: CapabilityGroup[] = [
  { title: "Usuarios y roles", keys: CAPABILITY_KEYS.filter((key) => key.startsWith("cap.users.") || key.startsWith("cap.roles.")) },
  { title: "Pedidos e items", keys: CAPABILITY_KEYS.filter((key) => key.startsWith("cap.orders.")) },
  { title: "Validacion", keys: CAPABILITY_KEYS.filter((key) => key.startsWith("cap.validation.")) },
  { title: "Operaciones proveedor", keys: CAPABILITY_KEYS.filter((key) => key.startsWith("cap.suppliers.ops.")) },
  { title: "Inventario", keys: CAPABILITY_KEYS.filter((key) => key.startsWith("cap.inventory.")) },
  { title: "Empaque", keys: CAPABILITY_KEYS.filter((key) => key.startsWith("cap.packing.")) },
  {
    title: "Despacho y rutas",
    keys: CAPABILITY_KEYS.filter(
      (key) => key.startsWith("cap.dispatch.") || key.startsWith("cap.runs.") || key.startsWith("cap.transfers."),
    ),
  },
  { title: "Entrega", keys: CAPABILITY_KEYS.filter((key) => key.startsWith("cap.delivery.")) },
  { title: "Pagos", keys: CAPABILITY_KEYS.filter((key) => key.startsWith("cap.payments.")) },
  { title: "Devoluciones", keys: CAPABILITY_KEYS.filter((key) => key.startsWith("cap.returns.")) },
  { title: "Incidencias y auditoria", keys: CAPABILITY_KEYS.filter((key) => key.startsWith("cap.incidents.") || key.startsWith("cap.audit.")) },
];

@Component({
  standalone: true,
  selector: "app-usuarios",
  imports: [FormsModule],
  templateUrl: "./usuarios.html",
  styleUrl: "./usuarios.css",
})
export default class UsuariosPage {
  private authz = inject(AuthzService);
  private usersService = inject(UsersService);
  private rolesService = inject(RolesService);
  private userAdminApi = inject(UserAdminApiService);
  private impersonation = inject(ImpersonationService);

  tab = signal<UsersTab>("users");
  loading = signal(false);
  saving = signal(false);
  error = signal<string | null>(null);
  success = signal<string | null>(null);

  users = signal<UserDoc[]>([]);
  roles = signal<RoleDoc[]>([]);
  search = signal("");

  editDraft = signal<UserDraft | null>(null);
  activeRowActionUid = signal<string | null>(null);
  tempPasswordOut = signal<{ uid: string; password: string | null } | null>(null);

  newDisplayName = signal("");
  newEmail = signal("");
  newUsername = signal("");
  newRoleId = signal<RoleId>("operativo");
  newLoginType = signal<UserLoginType>("email");
  newSendActivationEmail = signal(true);

  selectedRoleId = signal<RoleId>("operativo");
  roleDraft = signal<RoleDoc>(buildRolePreset("operativo"));

  readonly roleIds = ROLE_IDS;
  readonly sectionKeys = SECTION_KEYS;
  readonly capGroups = CAPABILITY_GROUPS;

  filteredUsers = computed(() => {
    const term = this.search().trim().toLowerCase();
    if (!term) return this.users();
    return this.users().filter((row) => {
      const blob = `${row.displayName} ${row.email} ${row.authEmail} ${row.username} ${row.uid}`.toLowerCase();
      return blob.includes(term);
    });
  });

  canViewUsers = computed(() => this.authz.canSection("sections.usuarios") || this.authz.canCap("cap.users.view"));
  canViewRoles = computed(() => this.authz.canCap("cap.roles.view") || this.authz.canSection("sections.usuarios"));
  canEditRoles = computed(() => this.authz.canCap("cap.roles.edit"));
  isSuperAdmin = computed(() => this.authz.isRealSuperAdmin());
  isImpersonating = computed(() => this.authz.isImpersonatingSig());
  currentUid = computed(() => this.authz.currentUserSig()?.uid || null);

  constructor() {
    this.reload().catch(() => null);
  }

  async reload() {
    this.loading.set(true);
    this.error.set(null);
    this.success.set(null);
    try {
      await this.authz.refresh({ force: true });
      await this.rolesService.ensureDefaultsSeeded();
      const roles = await this.rolesService.listRoles();
      this.roles.set(roles);
      const users = await this.loadUsersFromBestSource();
      this.users.set(users);
      if (roles.length > 0) {
        const targetRole = roles.find((row) => row.roleId === this.selectedRoleId()) || roles[0];
        this.selectRole(targetRole.roleId);
      }
    } catch (error: any) {
      this.error.set(error?.message || "No se pudo cargar usuarios y roles.");
    } finally {
      this.loading.set(false);
    }
  }

  private async loadUsersFromBestSource(): Promise<UserDoc[]> {
    if (this.isSuperAdmin() && !this.isImpersonating()) {
      const rows = await this.userAdminApi.listManagedUsers();
      return rows.map((row) => this.mapApiRowToUser(row)).sort((a, b) => a.displayName.localeCompare(b.displayName));
    }
    return this.usersService.listUsers();
  }

  private mapApiRowToUser(row: ListManagedUserRow): UserDoc {
    const roleId = this.isRoleId(row.role) ? row.role : "operativo";
    const loginType: UserLoginType = row.email ? "email" : "username";
    const sections = normalizeSectionsMap(row.sections || this.mapApiPermissionsToSections(row.permissions, roleId));
    const capabilities = normalizeCapabilitiesMap(row.capabilities || buildRolePreset(roleId).capabilities);
    const sectionOverrides = normalizeSectionOverridesMap(row.sectionOverrides || this.deriveSectionOverrides(roleId, sections));
    const capabilityOverrides = normalizeCapabilityOverridesMap(
      row.capabilityOverrides || this.deriveCapabilityOverrides(roleId, capabilities),
    );
    return {
      uid: row.uid,
      email: row.email || "",
      authEmail: row.email || buildUsernameAuthEmail(row.username),
      username: normalizeUsername(row.username),
      loginType,
      displayName: row.display_name || row.username || row.uid,
      roleId,
      isActive: Boolean(row.active),
      mustChangePassword: Boolean(row.must_change_password),
      sections,
      capabilities,
      sectionOverrides,
      capabilityOverrides,
      createdAt: null,
      updatedAt: null,
    };
  }

  setTab(tab: UsersTab) {
    this.tab.set(tab);
  }

  roleName(roleId: RoleId): string {
    return roleLabel(roleId);
  }

  sectionLabel(key: SectionKey): string {
    return key.replace("sections.", "").replaceAll("_", " ");
  }

  capabilityLabel(key: CapabilityKey): string {
    return key.replace("cap.", "").replaceAll(".", " / ").replaceAll("_", " ");
  }

  userLoginLabel(row: UserDoc): string {
    return row.loginType === "username" ? "Usuario" : "Correo";
  }

  canManageUsers(): boolean {
    return this.isSuperAdmin() && !this.isImpersonating();
  }

  canEditUser(row: UserDoc): boolean {
    if (!this.canManageUsers()) return false;
    if (row.roleId === "super_admin") return false;
    return true;
  }

  canDisableUser(row: UserDoc): boolean {
    if (!this.canManageUsers()) return false;
    if (row.roleId === "super_admin") return false;
    if (row.uid === this.currentUid()) return false;
    return true;
  }

  canRegenerateTemporaryPassword(row: UserDoc): boolean {
    return this.canManageUsers() && row.roleId !== "super_admin" && !row.isActive;
  }

  canResendActivation(row: UserDoc): boolean {
    return this.canManageUsers() && row.roleId !== "super_admin" && !row.isActive && row.loginType === "email";
  }

  canImpersonateRow(row: UserDoc): boolean {
    if (!this.isSuperAdmin()) return false;
    if (row.roleId === "super_admin") return false;
    if (!row.isActive) return false;
    if (row.uid === this.currentUid()) return false;
    return true;
  }

  isImpersonatingRow(row: UserDoc): boolean {
    return this.isImpersonating() && this.impersonation.snapshotSig()?.uid === row.uid;
  }

  toggleImpersonation(row: UserDoc, checked: boolean) {
    if (!this.canImpersonateRow(row)) return;
    if (checked) {
      this.impersonation.startFromUser(row);
      this.success.set(`Vista activa desde ${row.displayName}.`);
      return;
    }
    if (this.isImpersonatingRow(row)) {
      this.impersonation.stop();
      this.success.set("Volviste a vista super admin.");
    }
  }

  startEditUser(row: UserDoc) {
    if (!this.canEditUser(row)) {
      if (!environment.production) {
        console.warn("[AUTHZ][EDIT_USER][BLOCKED]", {
          uid: row.uid,
          roleId: row.roleId,
          isActive: row.isActive,
          isSuperAdminSession: this.isSuperAdmin(),
          isImpersonating: this.isImpersonating(),
          currentUid: this.currentUid(),
        });
      }
      return;
    }
    this.error.set(null);
    this.success.set(null);
    this.tempPasswordOut.set(null);
    this.editDraft.set({
      uid: row.uid,
      email: row.email,
      authEmail: row.authEmail,
      username: row.username,
      loginType: row.loginType,
      displayName: row.displayName,
      roleId: row.roleId,
      isActive: row.isActive,
      mustChangePassword: row.mustChangePassword,
      sectionOverrides: { ...row.sectionOverrides },
      capabilityOverrides: { ...row.capabilityOverrides },
    });
    if (!environment.production) {
      console.info("[AUTHZ][EDIT_USER]", {
        uid: row.uid,
        roleId: row.roleId,
        isActive: row.isActive,
        sections: row.sections,
        capabilities: row.capabilities,
        sectionOverrides: row.sectionOverrides,
        capabilityOverrides: row.capabilityOverrides,
      });
    }
  }

  cancelUserEdit() {
    this.editDraft.set(null);
  }

  isEditingRow(row: UserDoc): boolean {
    return this.editDraft()?.uid === row.uid;
  }

  updateEditDisplayName(value: string) {
    this.editDraft.update((draft) => (draft ? { ...draft, displayName: value } : draft));
  }

  updateEditEmail(value: string) {
    this.editDraft.update((draft) => (draft ? { ...draft, email: value } : draft));
  }

  updateEditUsername(value: string) {
    this.editDraft.update((draft) => (draft ? { ...draft, username: normalizeUsername(value) } : draft));
  }

  updateEditRoleId(value: string) {
    if (!this.isRoleId(value)) return;
    this.editDraft.update((draft) => (draft ? { ...draft, roleId: value } : draft));
  }

  updateEditLoginType(value: string) {
    if (!this.isLoginType(value)) return;
    this.editDraft.update((draft) => (draft ? { ...draft, loginType: value, email: value === "email" ? draft.email : "" } : draft));
  }

  updateEditIsActive(value: boolean) {
    this.editDraft.update((draft) => (draft ? { ...draft, isActive: value } : draft));
  }

  updateEditMustChangePassword(value: boolean) {
    this.editDraft.update((draft) => (draft ? { ...draft, mustChangePassword: value } : draft));
  }

  roleOptionsForRow(row: UserDoc): RoleId[] {
    if (this.isSuperAdmin()) return [...this.roleIds];
    if (row.roleId === "super_admin") return ["super_admin"];
    return this.roleIds.filter((roleId) => roleId !== "super_admin");
  }

  baseSectionByRole(roleId: RoleId, key: SectionKey): boolean {
    const role = this.roles().find((entry) => entry.roleId === roleId) || buildRolePreset(roleId);
    return Boolean(role.sections[key]);
  }

  baseCapByRole(roleId: RoleId, key: CapabilityKey): boolean {
    const role = this.roles().find((entry) => entry.roleId === roleId) || buildRolePreset(roleId);
    return Boolean(role.capabilities[key]);
  }

  userSectionValue(key: SectionKey): boolean {
    const draft = this.editDraft();
    if (!draft) return false;
    const override = draft.sectionOverrides[key];
    if (typeof override === "boolean") return override;
    return this.baseSectionByRole(draft.roleId, key);
  }

  userCapValue(key: CapabilityKey): boolean {
    const draft = this.editDraft();
    if (!draft) return false;
    const override = draft.capabilityOverrides[key];
    if (typeof override === "boolean") return override;
    return this.baseCapByRole(draft.roleId, key);
  }

  setUserSectionValue(key: SectionKey, checked: boolean) {
    const draft = this.editDraft();
    if (!draft) return;
    const base = this.baseSectionByRole(draft.roleId, key);
    const nextOverrides = { ...draft.sectionOverrides };
    if (checked === base) {
      delete nextOverrides[key];
    } else {
      nextOverrides[key] = checked;
    }
    this.editDraft.set({ ...draft, sectionOverrides: nextOverrides });
  }

  setUserCapValue(key: CapabilityKey, checked: boolean) {
    const draft = this.editDraft();
    if (!draft) return;
    const base = this.baseCapByRole(draft.roleId, key);
    const nextOverrides = { ...draft.capabilityOverrides };
    if (checked === base) {
      delete nextOverrides[key];
    } else {
      nextOverrides[key] = checked;
    }
    this.editDraft.set({ ...draft, capabilityOverrides: nextOverrides });
  }

  clearUserOverrides() {
    const draft = this.editDraft();
    if (!draft) return;
    this.editDraft.set({
      ...draft,
      sectionOverrides: {},
      capabilityOverrides: {},
    });
  }

  async createUser() {
    if (!this.canManageUsers()) return;
    this.error.set(null);
    this.success.set(null);
    this.tempPasswordOut.set(null);

    const inputError = this.validateCreateInput();
    if (inputError) {
      this.error.set(inputError);
      return;
    }

    const payload: CreateManagedUserInput = {
      displayName: this.newDisplayName().trim(),
      username: normalizeUsername(this.newUsername()),
      loginType: this.newLoginType(),
      roleId: this.newRoleId(),
      email: this.newLoginType() === "email" ? this.newEmail().trim().toLowerCase() : undefined,
      sendActivationEmail: this.newLoginType() === "email" ? this.newSendActivationEmail() : false,
      permissions: this.buildAdminPermissions(this.newRoleId(), {}),
    };

    this.saving.set(true);
    try {
      const result = await this.userAdminApi.createManagedUser(payload);
      this.success.set("Usuario creado.");
      if (result.temporaryPassword) {
        this.tempPasswordOut.set({ uid: result.uid, password: result.temporaryPassword });
      }
      this.resetCreateForm();
      await this.reload();
    } catch (error: any) {
      this.error.set(error?.message || "No se pudo crear el usuario.");
    } finally {
      this.saving.set(false);
    }
  }

  async saveUser(row: UserDoc) {
    if (!this.canEditUser(row)) return;
    const draft = this.editDraft();
    if (!draft || draft.uid !== row.uid) return;

    const draftError = this.validateDraft(draft);
    if (draftError) {
      this.error.set(draftError);
      return;
    }

    this.saving.set(true);
    this.error.set(null);
    this.success.set(null);
    try {
      await this.userAdminApi.updateManagedUser(row.uid, {
        roleId: draft.roleId,
        isActive: draft.isActive,
        permissions: this.buildAdminPermissions(draft.roleId, draft.sectionOverrides),
      });
      await this.userAdminApi.updateManagedUserProfile({
        uid: row.uid,
        displayName: draft.displayName.trim(),
        username: normalizeUsername(draft.username),
        email: draft.loginType === "email" ? draft.email.trim().toLowerCase() : null,
      });
      this.success.set("Usuario actualizado.");
      this.cancelUserEdit();
      await this.reload();
    } catch (error: any) {
      this.error.set(error?.message || "No se pudo guardar el usuario.");
    } finally {
      this.saving.set(false);
    }
  }

  async disableUser(row: UserDoc) {
    if (!this.canDisableUser(row)) return;
    this.saving.set(true);
    this.error.set(null);
    this.success.set(null);
    try {
      await this.userAdminApi.updateManagedUser(row.uid, {
        roleId: row.roleId,
        isActive: false,
        permissions: this.buildAdminPermissions(row.roleId, row.sectionOverrides),
      });
      this.success.set("Usuario desactivado.");
      await this.reload();
    } catch (error: any) {
      this.error.set(error?.message || "No se pudo desactivar el usuario.");
    } finally {
      this.saving.set(false);
    }
  }

  async resendActivation(row: UserDoc) {
    if (!this.canResendActivation(row)) return;
    this.activeRowActionUid.set(row.uid);
    this.error.set(null);
    this.success.set(null);
    try {
      await this.userAdminApi.resendActivationEmail(row.uid);
      this.success.set("Correo de activacion reenviado.");
    } catch (error: any) {
      this.error.set(error?.message || "No se pudo reenviar el correo de activacion.");
    } finally {
      this.activeRowActionUid.set(null);
    }
  }

  async regenerateTemporaryPassword(row: UserDoc) {
    if (!this.canRegenerateTemporaryPassword(row)) return;
    this.activeRowActionUid.set(row.uid);
    this.error.set(null);
    this.success.set(null);
    this.tempPasswordOut.set(null);
    try {
      const result = await this.userAdminApi.regenerateTemporaryPassword(row.uid);
      if (result.temporaryPassword) {
        this.tempPasswordOut.set({ uid: row.uid, password: result.temporaryPassword });
        this.success.set("Contrasena temporal regenerada.");
      } else if (result.resetSent) {
        this.success.set("Correo de reset de contrasena enviado.");
      } else {
        this.success.set("Reset de contrasena solicitado.");
      }
    } catch (error: any) {
      this.error.set(error?.message || "No se pudo enviar el reset de contrasena.");
    } finally {
      this.activeRowActionUid.set(null);
    }
  }

  selectRole(roleId: RoleId) {
    const role = this.roles().find((row) => row.roleId === roleId) || buildRolePreset(roleId);
    this.selectedRoleId.set(role.roleId);
    this.roleDraft.set({
      roleId: role.roleId,
      label: role.label,
      sections: { ...role.sections },
      capabilities: { ...role.capabilities },
      updatedAt: role.updatedAt ?? null,
    });
  }

  isRoleDraftSuperAdmin(): boolean {
    return this.roleDraft().roleId === "super_admin";
  }

  setSectionValue(key: SectionKey, checked: boolean) {
    if (this.isRoleDraftSuperAdmin() || !this.canEditRoles()) return;
    this.roleDraft.update((current) => ({
      ...current,
      sections: {
        ...current.sections,
        [key]: checked,
      },
    }));
  }

  setCapValue(key: CapabilityKey, checked: boolean) {
    if (this.isRoleDraftSuperAdmin() || !this.canEditRoles()) return;
    this.roleDraft.update((current) => ({
      ...current,
      capabilities: {
        ...current.capabilities,
        [key]: checked,
      },
    }));
  }

  markAllRole() {
    if (this.isRoleDraftSuperAdmin() || !this.canEditRoles()) return;
    this.roleDraft.update((current) => ({
      ...current,
      sections: Object.keys(current.sections).reduce(
        (acc, key) => ({ ...acc, [key]: true }),
        {} as RoleDoc["sections"],
      ),
      capabilities: Object.keys(current.capabilities).reduce(
        (acc, key) => ({ ...acc, [key]: true }),
        {} as RoleDoc["capabilities"],
      ),
    }));
  }

  clearRole() {
    if (this.isRoleDraftSuperAdmin() || !this.canEditRoles()) return;
    this.roleDraft.update((current) => ({
      ...current,
      sections: Object.keys(current.sections).reduce(
        (acc, key) => ({ ...acc, [key]: false }),
        {} as RoleDoc["sections"],
      ),
      capabilities: Object.keys(current.capabilities).reduce(
        (acc, key) => ({ ...acc, [key]: false }),
        {} as RoleDoc["capabilities"],
      ),
    }));
  }

  async saveRoleDraft() {
    if (!this.canEditRoles()) {
      this.error.set("No tienes permiso para editar roles.");
      return;
    }
    if (this.isRoleDraftSuperAdmin()) {
      this.error.set("Super admin siempre tiene todo.");
      return;
    }

    this.saving.set(true);
    this.error.set(null);
    this.success.set(null);
    try {
      const draft = this.roleDraft();
      await this.rolesService.saveRole({
        roleId: draft.roleId,
        label: draft.label,
        sections: draft.sections,
        capabilities: draft.capabilities,
      });
      this.success.set("Rol actualizado.");
      await this.reload();
    } catch (error: any) {
      this.error.set(error?.message || "No se pudo guardar el rol.");
    } finally {
      this.saving.set(false);
    }
  }

  getTempPasswordForRow(row: UserDoc): string | null {
    return this.tempPasswordOut()?.uid === row.uid ? this.tempPasswordOut()?.password || null : null;
  }

  private buildAdminPermissions(roleId: RoleId, sectionOverrides: SectionOverridesMap): AdminPermissionsPayload {
    return {
      dashboard: this.resolveSectionValue(roleId, sectionOverrides, "sections.dashboard"),
      validacion: this.resolveSectionValue(roleId, sectionOverrides, "sections.validacion"),
      pedidos: this.resolveSectionValue(roleId, sectionOverrides, "sections.pedidos"),
      catalogo: this.resolveSectionValue(roleId, sectionOverrides, "sections.catalogo"),
      edicion_productos: this.resolveSectionValue(roleId, sectionOverrides, "sections.catalogo"),
      categorias: this.resolveSectionValue(roleId, sectionOverrides, "sections.categorias"),
      proveedores: this.resolveSectionValue(roleId, sectionOverrides, "sections.proveedores"),
      inventario: this.resolveSectionValue(roleId, sectionOverrides, "sections.inventario"),
      clientas: this.resolveSectionValue(roleId, sectionOverrides, "sections.clientes"),
      rutas: this.resolveSectionValue(roleId, sectionOverrides, "sections.rutas"),
      localidades: this.resolveSectionValue(roleId, sectionOverrides, "sections.localidades"),
      usuarios: roleId === "super_admin" ? this.resolveSectionValue(roleId, sectionOverrides, "sections.usuarios") : false,
    };
  }

  private resolveSectionValue(roleId: RoleId, sectionOverrides: SectionOverridesMap, key: SectionKey): boolean {
    const override = sectionOverrides[key];
    if (typeof override === "boolean") return override;
    return this.baseSectionByRole(roleId, key);
  }

  private validateCreateInput(): string | null {
    const displayName = this.newDisplayName().trim();
    const username = normalizeUsername(this.newUsername());
    const loginType = this.newLoginType();
    const email = this.newEmail().trim().toLowerCase();
    if (!displayName) return "El nombre es obligatorio.";
    if (!username || username.length < 3) return "El usuario debe tener al menos 3 caracteres validos.";
    if (loginType === "email") {
      if (!email) return "El correo es obligatorio para este tipo de usuario.";
      if (!this.isValidEmail(email)) return "Ingresa un correo valido.";
    }
    return null;
  }

  private validateDraft(draft: UserDraft): string | null {
    if (!draft.displayName.trim()) return "El nombre es obligatorio.";
    if (!normalizeUsername(draft.username)) return "El nombre de usuario es obligatorio.";
    if (draft.loginType === "email") {
      const email = draft.email.trim().toLowerCase();
      if (!email) return "El correo es obligatorio.";
      if (!this.isValidEmail(email)) return "Ingresa un correo valido.";
    }
    if (draft.roleId === "super_admin") return "No se permite editar usuarios super admin desde esta pantalla.";
    return null;
  }

  private mapApiPermissionsToSections(permissions: AdminPermissionsPayload, roleId: RoleId): SectionsMap {
    const fallback = buildRolePreset(roleId).sections;
    if (!permissions || typeof permissions !== "object") {
      return fallback;
    }
    return normalizeSectionsMap({
      "sections.dashboard": permissions.dashboard,
      "sections.validacion": permissions.validacion,
      "sections.pedidos": permissions.pedidos,
      "sections.catalogo": Boolean(permissions.catalogo || permissions.edicion_productos),
      "sections.categorias": permissions.categorias,
      "sections.proveedores": permissions.proveedores,
      "sections.inventario": permissions.inventario,
      "sections.clientes": permissions.clientas,
      "sections.rutas": permissions.rutas,
      "sections.localidades": permissions.localidades,
      "sections.salidas": fallback["sections.salidas"],
      "sections.usuarios": permissions.usuarios,
    });
  }

  private deriveSectionOverrides(roleId: RoleId, effective: SectionsMap): SectionOverridesMap {
    const out: SectionOverridesMap = {};
    for (const key of this.sectionKeys) {
      const base = this.baseSectionByRole(roleId, key);
      const value = Boolean(effective[key]);
      if (value !== base) out[key] = value;
    }
    return out;
  }

  private deriveCapabilityOverrides(roleId: RoleId, effective: RoleDoc["capabilities"]): CapabilityOverridesMap {
    const out: CapabilityOverridesMap = {};
    for (const key of this.capGroups.flatMap((entry) => entry.keys)) {
      const base = this.baseCapByRole(roleId, key);
      const value = Boolean(effective[key]);
      if (value !== base) out[key] = value;
    }
    return out;
  }

  private isValidEmail(value: string): boolean {
    return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/i.test(value);
  }

  private resetCreateForm() {
    this.newDisplayName.set("");
    this.newEmail.set("");
    this.newUsername.set("");
    this.newRoleId.set("operativo");
    this.newLoginType.set("email");
    this.newSendActivationEmail.set(true);
  }

  private isRoleId(value: string): value is RoleId {
    return value === "super_admin" || value === "admin" || value === "operativo" || value === "repartidor";
  }

  private isLoginType(value: string): value is UserLoginType {
    return value === "email" || value === "username";
  }

  trackUser = (_: number, row: UserDoc) => row.uid;
  trackRole = (_: number, row: RoleDoc) => row.roleId;
  trackSection = (_: number, key: SectionKey) => key;
  trackCap = (_: number, key: CapabilityKey) => key;
}
