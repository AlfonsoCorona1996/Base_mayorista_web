import { Component, computed, inject, signal, ChangeDetectionStrategy } from "@angular/core";
import { FormsModule } from "@angular/forms";
import { environment } from "../../../environments/environment";
import { AuthzService } from "../../core/authz.service";
import {
  CAPABILITY_KEYS,
  CAPABILITY_KEYS as ALL_CAPABILITY_KEYS,
  CapabilityKey,
  CapabilityOverridesMap,
  RoleDoc,
  ROLE_IDS,
  RoleId,
  SECTION_KEYS,
  SECTION_KEYS as ALL_SECTION_KEYS,
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

type UserPermissionGroup = {
  sectionKey: SectionKey | "general";
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
  { title: "Administracion financiera", keys: CAPABILITY_KEYS.filter((key) => key.startsWith("cap.finance.")) },
  { title: "Devoluciones", keys: CAPABILITY_KEYS.filter((key) => key.startsWith("cap.returns.")) },
  { title: "Incidencias y auditoria", keys: CAPABILITY_KEYS.filter((key) => key.startsWith("cap.incidents.") || key.startsWith("cap.audit.")) },
];

const SECTION_CAPABILITY_PREFIXES: Record<SectionKey, string[]> = {
  "sections.dashboard": [],
  "sections.pedidos": ["cap.orders."],
  "sections.proveedores": ["cap.suppliers.ops."],
  "sections.validacion": ["cap.validation."],
  "sections.clientes": ["cap.payments.", "cap.returns."],
  "sections.inventario": ["cap.inventory."],
  "sections.administracion": ["cap.finance."],
  "sections.catalogo": [],
  "sections.categorias": [],
  "sections.rutas": ["cap.runs.", "cap.delivery."],
  "sections.localidades": [],
  "sections.salidas": ["cap.packing.", "cap.dispatch.", "cap.transfers."],
  "sections.usuarios": ["cap.users.", "cap.roles.", "cap.audit."],
};

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  standalone: true,
  selector: "app-usuarios",
  imports: [FormsModule],
  templateUrl: "./usuarios.html",
  styleUrl: "./usuarios.css",
})
export default class UsuariosPage {
  private authz = inject(AuthzService);
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
  readonly userPermissionGroups = this.buildUserPermissionGroups();

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
    const rows = await this.userAdminApi.listManagedUsers();
    return rows.map((row) => this.mapApiRowToUser(row)).sort((a, b) => a.displayName.localeCompare(b.displayName));
  }

  private mapApiRowToUser(row: ListManagedUserRow): UserDoc {
    const roleId = this.isRoleId(row.roleId) ? row.roleId : "operativo";
    const username = normalizeUsername(row.username);
    const loginType: UserLoginType = row.email ? "email" : "username";
    const sections = this.normalizeSectionsFromApi(row.sections, roleId);
    const capabilities = normalizeCapabilitiesMap(row.capabilities || buildRolePreset(roleId).capabilities);
    const serverSectionOverrides = this.normalizeSectionOverridesFromApi(row.sectionOverrides);
    const serverCapabilityOverrides = normalizeCapabilityOverridesMap(row.capabilityOverrides || null);
    const derivedSectionOverrides = this.deriveSectionOverrides(roleId, sections);
    const derivedCapabilityOverrides = this.deriveCapabilityOverrides(roleId, capabilities);
    const sectionOverrides = { ...derivedSectionOverrides, ...serverSectionOverrides };
    const capabilityOverrides = { ...derivedCapabilityOverrides, ...serverCapabilityOverrides };
    return {
      uid: row.uid,
      email: row.email || "",
      authEmail: row.email || buildUsernameAuthEmail(username),
      username,
      loginType,
      displayName: row.displayName || username || row.uid,
      roleId,
      isActive: Boolean(row.isActive),
      invitePending: Boolean(row.invitePending),
      mustChangePassword: Boolean(row.mustChangePassword),
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
    if (!this.canManageUsers()) return false;
    if (row.roleId === "super_admin") return false;
    if (row.loginType === "username") return true;
    return !row.isActive;
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
    this.editDraft.update((draft) => {
      if (!draft) return draft;
      const next: UserDraft = {
        ...draft,
        roleId: value,
        sectionOverrides: { ...draft.sectionOverrides },
        capabilityOverrides: { ...draft.capabilityOverrides },
      };
      if (value !== "super_admin") {
        next.sectionOverrides["sections.usuarios"] = false;
        for (const key of ALL_CAPABILITY_KEYS) {
          if (this.isCapabilityLockedForRole(value, key)) {
            next.capabilityOverrides[key] = false;
          }
        }
      }
      return next;
    });
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
    if (this.isSectionLockedForRole(draft.roleId, key)) return false;
    const override = draft.sectionOverrides[key];
    if (typeof override === "boolean") return override;
    return this.baseSectionByRole(draft.roleId, key);
  }

  userCapValue(key: CapabilityKey): boolean {
    const draft = this.editDraft();
    if (!draft) return false;
    if (this.isCapabilityLockedForRole(draft.roleId, key)) return false;
    const override = draft.capabilityOverrides[key];
    if (typeof override === "boolean") return override;
    return this.baseCapByRole(draft.roleId, key);
  }

  setUserSectionValue(key: SectionKey, checked: boolean) {
    const draft = this.editDraft();
    if (!draft) return;
    if (this.isSectionLockedForRole(draft.roleId, key)) return;
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
    if (this.isCapabilityLockedForRole(draft.roleId, key)) return;
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
      const sectionOverridesPayload = this.buildChangedSectionOverridesPayload(row, draft);
      const capabilityOverridesPayload = this.buildChangedCapabilityOverridesPayload(row, draft);
      const profileChanged = this.hasProfileChanges(row, draft);
      const accessChanged =
        draft.roleId !== row.roleId ||
        draft.isActive !== row.isActive ||
        Boolean(sectionOverridesPayload) ||
        Boolean(capabilityOverridesPayload);

      if (profileChanged) {
        await this.userAdminApi.updateManagedUserProfile({
          uid: row.uid,
          displayName: draft.displayName.trim(),
          username: normalizeUsername(draft.username),
          email: draft.loginType === "email" ? draft.email.trim().toLowerCase() : null,
        });
      }

      if (accessChanged) {
        const accessPayload: Parameters<UserAdminApiService["updateManagedUser"]>[1] = {
          roleId: draft.roleId,
          isActive: draft.isActive,
        };
        if (sectionOverridesPayload) {
          accessPayload.sectionOverrides = sectionOverridesPayload;
        }
        if (capabilityOverridesPayload) {
          accessPayload.capabilityOverrides = capabilityOverridesPayload;
        }
        await this.userAdminApi.updateManagedUser(row.uid, accessPayload);
      }
      const nextRow = this.buildUserFromDraft(row, draft);
      this.users.update((current) =>
        current
          .map((entry) => (entry.uid === row.uid ? nextRow : entry))
          .sort((a, b) => a.displayName.localeCompare(b.displayName)),
      );
      this.success.set("Usuario actualizado.");
      this.cancelUserEdit();
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
    const restorePayload: Parameters<UserAdminApiService["updateManagedUser"]>[1] = {
      roleId: row.roleId,
      isActive: row.isActive,
    };
    if (Object.keys(row.sectionOverrides).length > 0) {
      restorePayload.sectionOverrides = { ...row.sectionOverrides };
    }
    if (Object.keys(row.capabilityOverrides).length > 0) {
      restorePayload.capabilityOverrides = { ...row.capabilityOverrides };
    }
    try {
      const result = await this.userAdminApi.regenerateTemporaryPassword(row.uid);
      await this.userAdminApi.updateManagedUser(row.uid, restorePayload);
      await this.reload();
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

  roleSectionGroupValue(key: SectionKey | "general"): boolean {
    if (key === "general") return false;
    return Boolean(this.roleDraft().sections[key]);
  }

  setRoleSectionGroupValue(key: SectionKey | "general", checked: boolean) {
    if (key === "general") return;
    this.setSectionValue(key, checked);
  }

  isRoleSectionGroupToggleDisabled(key: SectionKey | "general"): boolean {
    if (key === "general") return true;
    return this.isRoleDraftSuperAdmin() || !this.canEditRoles();
  }

  isRoleCapabilityToggleDisabled(_key: CapabilityKey): boolean {
    return this.isRoleDraftSuperAdmin() || !this.canEditRoles();
  }

  roleEnabledSectionsCount(): number {
    const sections = this.roleDraft().sections;
    return this.sectionKeys.reduce((total, key) => total + (sections[key] ? 1 : 0), 0);
  }

  roleEnabledCapabilitiesCount(): number {
    const capabilities = this.roleDraft().capabilities;
    return ALL_CAPABILITY_KEYS.reduce((total, key) => total + (capabilities[key] ? 1 : 0), 0);
  }

  roleGroupEnabledCount(keys: CapabilityKey[]): number {
    const capabilities = this.roleDraft().capabilities;
    return keys.reduce((total, key) => total + (capabilities[key] ? 1 : 0), 0);
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

  userSectionGroupValue(key: SectionKey | "general"): boolean {
    if (key === "general") return false;
    return this.userSectionValue(key);
  }

  setUserSectionGroupValue(key: SectionKey | "general", checked: boolean) {
    if (key === "general") return;
    this.setUserSectionValue(key, checked);
  }

  isSectionGroupToggleDisabled(key: SectionKey | "general"): boolean {
    if (key === "general") return true;
    return this.isSectionToggleDisabled(key);
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
      administracion: this.resolveSectionValue(roleId, sectionOverrides, "sections.administracion"),
      clientas: this.resolveSectionValue(roleId, sectionOverrides, "sections.clientes"),
      rutas: this.resolveSectionValue(roleId, sectionOverrides, "sections.rutas"),
      localidades: this.resolveSectionValue(roleId, sectionOverrides, "sections.localidades"),
      salidas: this.resolveSectionValue(roleId, sectionOverrides, "sections.salidas"),
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

  private normalizeSectionsFromApi(raw: Record<string, boolean> | null, roleId: RoleId): SectionsMap {
    if (!raw) return buildRolePreset(roleId).sections;
    const canonical = this.toCanonicalSectionsRecord(raw);
    if (Object.keys(canonical).length === 0) return buildRolePreset(roleId).sections;
    return normalizeSectionsMap(canonical);
  }

  private normalizeSectionOverridesFromApi(raw: Record<string, boolean> | null): SectionOverridesMap {
    if (!raw) return {};
    return normalizeSectionOverridesMap(this.toCanonicalSectionsRecord(raw));
  }

  private toCanonicalSectionsRecord(raw: Record<string, boolean>): Partial<Record<SectionKey, boolean>> {
    const out: Partial<Record<SectionKey, boolean>> = {};
    for (const key of this.sectionKeys) {
      const shortKey = key.slice("sections.".length);
      if (typeof raw[key] === "boolean") {
        out[key] = raw[key];
        continue;
      }
      if (typeof raw[shortKey] === "boolean") {
        out[key] = raw[shortKey];
      }
    }
    return out;
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

  private buildChangedSectionOverridesPayload(row: UserDoc, draft: UserDraft): Record<string, boolean> | undefined {
    const out: Record<string, boolean> = {};
    for (const key of ALL_SECTION_KEYS) {
      const before = row.sectionOverrides[key];
      const after = draft.sectionOverrides[key];
      if (before === after) continue;
      if (typeof after === "boolean") {
        out[this.toApiSectionKey(key)] = this.isSectionLockedForRole(draft.roleId, key) ? false : after;
        continue;
      }
      out[this.toApiSectionKey(key)] = this.baseSectionByRole(draft.roleId, key);
    }
    return Object.keys(out).length ? out : undefined;
  }

  private buildChangedCapabilityOverridesPayload(row: UserDoc, draft: UserDraft): Record<string, boolean> | undefined {
    const out: Record<string, boolean> = {};
    for (const key of ALL_CAPABILITY_KEYS) {
      const before = row.capabilityOverrides[key];
      const after = draft.capabilityOverrides[key];
      if (before === after) continue;
      if (typeof after === "boolean") {
        out[key] = this.isCapabilityLockedForRole(draft.roleId, key) ? false : after;
        continue;
      }
      out[key] = this.isCapabilityLockedForRole(draft.roleId, key) ? false : this.baseCapByRole(draft.roleId, key);
    }
    return Object.keys(out).length ? out : undefined;
  }

  private hasProfileChanges(row: UserDoc, draft: UserDraft): boolean {
    const currentDisplayName = row.displayName.trim();
    const nextDisplayName = draft.displayName.trim();
    if (currentDisplayName !== nextDisplayName) return true;

    const currentUsername = normalizeUsername(row.username);
    const nextUsername = normalizeUsername(draft.username);
    if (currentUsername !== nextUsername) return true;

    const currentEmail = row.loginType === "email" ? row.email.trim().toLowerCase() : null;
    const nextEmail = draft.loginType === "email" ? draft.email.trim().toLowerCase() : null;
    if (currentEmail !== nextEmail) return true;

    return false;
  }

  private buildUserFromDraft(row: UserDoc, draft: UserDraft): UserDoc {
    const username = normalizeUsername(draft.username);
    const loginType = draft.loginType;
    const email = loginType === "email" ? draft.email.trim().toLowerCase() : "";
    const authEmail = loginType === "email" ? email : buildUsernameAuthEmail(username);
    const sectionOverrides = this.normalizeDraftSectionOverrides(draft.roleId, draft.sectionOverrides);
    const capabilityOverrides = this.normalizeDraftCapabilityOverrides(draft.roleId, draft.capabilityOverrides);
    const sections = this.resolveSectionsForRole(draft.roleId, sectionOverrides);
    const capabilities = this.resolveCapabilitiesForRole(draft.roleId, capabilityOverrides);
    return {
      ...row,
      displayName: draft.displayName.trim(),
      username,
      loginType,
      email,
      authEmail,
      roleId: draft.roleId,
      isActive: draft.isActive,
      mustChangePassword: draft.mustChangePassword,
      sections,
      capabilities,
      sectionOverrides,
      capabilityOverrides,
    };
  }

  private normalizeDraftSectionOverrides(roleId: RoleId, overrides: SectionOverridesMap): SectionOverridesMap {
    const out: SectionOverridesMap = {};
    for (const key of ALL_SECTION_KEYS) {
      const raw = overrides[key];
      if (typeof raw !== "boolean") continue;
      const safe = this.isSectionLockedForRole(roleId, key) ? false : raw;
      const base = this.baseSectionByRole(roleId, key);
      if (safe === base) continue;
      out[key] = safe;
    }
    return out;
  }

  private normalizeDraftCapabilityOverrides(roleId: RoleId, overrides: CapabilityOverridesMap): CapabilityOverridesMap {
    const out: CapabilityOverridesMap = {};
    for (const key of ALL_CAPABILITY_KEYS) {
      const raw = overrides[key];
      if (typeof raw !== "boolean") continue;
      const safe = this.isCapabilityLockedForRole(roleId, key) ? false : raw;
      const base = this.baseCapByRole(roleId, key);
      if (safe === base) continue;
      out[key] = safe;
    }
    return out;
  }

  private resolveSectionsForRole(roleId: RoleId, overrides: SectionOverridesMap): SectionsMap {
    const out = { ...buildRolePreset(roleId).sections };
    for (const key of ALL_SECTION_KEYS) {
      const override = overrides[key];
      if (this.isSectionLockedForRole(roleId, key)) {
        out[key] = false;
        continue;
      }
      out[key] = typeof override === "boolean" ? override : this.baseSectionByRole(roleId, key);
    }
    return normalizeSectionsMap(out);
  }

  private resolveCapabilitiesForRole(roleId: RoleId, overrides: CapabilityOverridesMap): RoleDoc["capabilities"] {
    const out = { ...buildRolePreset(roleId).capabilities };
    for (const key of ALL_CAPABILITY_KEYS) {
      const override = overrides[key];
      if (this.isCapabilityLockedForRole(roleId, key)) {
        out[key] = false;
        continue;
      }
      out[key] = typeof override === "boolean" ? override : this.baseCapByRole(roleId, key);
    }
    return normalizeCapabilitiesMap(out);
  }

  private toApiSectionKey(key: SectionKey): string {
    return key.slice("sections.".length);
  }

  private buildUserPermissionGroups(): UserPermissionGroup[] {
    const assigned = new Set<CapabilityKey>();
    const allCapabilities = this.capGroups.flatMap((group) => group.keys);
    const groups: UserPermissionGroup[] = this.sectionKeys.map((sectionKey) => {
      const prefixes = SECTION_CAPABILITY_PREFIXES[sectionKey] ?? [];
      const keys = allCapabilities.filter((capabilityKey) => prefixes.some((prefix) => capabilityKey.startsWith(prefix)));
      for (const key of keys) assigned.add(key);
      return {
        sectionKey,
        title: this.sectionLabel(sectionKey),
        keys,
      };
    });

    const generalKeys = allCapabilities.filter((capabilityKey) => !assigned.has(capabilityKey));
    groups.push({
      sectionKey: "general",
      title: "Permisos generales",
      keys: generalKeys,
    });
    return groups;
  }

  isSectionToggleDisabled(key: SectionKey): boolean {
    const draft = this.editDraft();
    if (!draft) return true;
    if (!this.canManageUsers()) return true;
    return this.isSectionLockedForRole(draft.roleId, key);
  }

  isCapabilityToggleDisabled(key: CapabilityKey): boolean {
    const draft = this.editDraft();
    if (!draft) return true;
    if (!this.canManageUsers()) return true;
    return this.isCapabilityLockedForRole(draft.roleId, key);
  }

  private isSectionLockedForRole(roleId: RoleId, key: SectionKey): boolean {
    return roleId !== "super_admin" && key === "sections.usuarios";
  }

  private isCapabilityLockedForRole(roleId: RoleId, key: CapabilityKey): boolean {
    if (roleId === "super_admin") return false;
    return key.startsWith("cap.users.") || key.startsWith("cap.roles.");
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
    return value === "super_admin" || value === "admin" || value === "administrativo" || value === "operativo" || value === "repartidor";
  }

  private isLoginType(value: string): value is UserLoginType {
    return value === "email" || value === "username";
  }

  trackUser = (_: number, row: UserDoc) => row.uid;
  trackRole = (_: number, row: RoleDoc) => row.roleId;
  trackSection = (_: number, key: SectionKey) => key;
  trackCap = (_: number, key: CapabilityKey) => key;
}
