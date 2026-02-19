import { Component, computed, inject, signal } from "@angular/core";
import { DatePipe } from "@angular/common";
import { FormsModule } from "@angular/forms";
import { collection, getDocs, limit, orderBy, query } from "firebase/firestore";
import { environment } from "../../../environments/environment";
import {
  ALL_PERMISSIONS,
  AppPermission,
  AppRole,
  AccessService,
  PermissionMap,
  buildPermissionsForRole,
  normalizeRole,
} from "../../core/access.service";
import { FIREBASE_AUTH, FIRESTORE } from "../../core/firebase.providers";

interface AdminRow {
  uid: string;
  email: string | null;
  username: string | null;
  displayName: string | null;
  role: AppRole;
  active: boolean;
  permissions: PermissionMap;
  invitedAt: string | null;
  acceptedAt: string | null;
  lastLoginAt: string | null;
  invitationPending: boolean;
}

interface AuditRow {
  id: string;
  action: string;
  actor_email: string | null;
  created_at: string;
  meta: Record<string, any>;
}

@Component({
  standalone: true,
  selector: "app-usuarios",
  imports: [FormsModule, DatePipe],
  templateUrl: "./usuarios.html",
  styleUrl: "./usuarios.css",
})
export default class UsuariosPage {
  private access = inject(AccessService);

  loading = signal(false);
  saving = signal(false);
  error = signal<string | null>(null);
  success = signal<string | null>(null);

  search = signal("");
  rows = signal<AdminRow[]>([]);
  auditRows = signal<AuditRow[]>([]);
  editingUid = signal<string | null>(null);
  resettingUid = signal<string | null>(null);
  resendingUid = signal<string | null>(null);
  deletingUid = signal<string | null>(null);

  draftDisplayName = "";
  draftUsername = "";
  draftEmail = "";
  draftRole: AppRole = "administrativo";
  draftActive = true;
  draftPermissions: PermissionMap = buildPermissionsForRole("administrativo");
  readonly rolePreset: Record<AppRole, PermissionMap> = {
    super_admin: buildPermissionsForRole("super_admin"),
    admin: buildPermissionsForRole("admin"),
    administrativo: buildPermissionsForRole("administrativo"),
    repartidor: buildPermissionsForRole("repartidor"),
  };

  filteredRows = computed(() => {
    const term = this.search().trim().toLowerCase();
    return this.rows().filter((row) => {
      if (!term) return true;
      const blob = [row.displayName, row.username, row.email, row.uid].join(" ").toLowerCase();
      return blob.includes(term);
    });
  });

  constructor() {
    this.reload();
  }

  private adminApiBaseUrl(): string {
    const fromEnv = ((environment as { adminApiBaseUrl?: string }).adminApiBaseUrl || "").trim();
    const fromStorage = (typeof window !== "undefined" ? window.localStorage.getItem("adminApiBaseUrl") : "") || "";
    const fromWindow = (typeof window !== "undefined" ? (window as any).__ADMIN_API_BASE_URL__ : "") || "";
    const raw = (fromStorage || fromEnv || fromWindow || "").trim();
    return raw.endsWith("/") ? raw.slice(0, -1) : raw;
  }

  private buildUrl(path: string): string {
    return `${this.adminApiBaseUrl()}${path}`;
  }

  private async authHeaders(): Promise<Record<string, string>> {
    const user = FIREBASE_AUTH.currentUser;
    if (!user) throw new Error("No hay sesión activa");
    const token = await user.getIdToken(true);
    return {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    };
  }

  private mapApiError(status: number, code?: string): string {
    const normalized = (code || "").toUpperCase();
    if (status === 401 || normalized === "UNAUTHENTICATED") return "Sesión inválida. Inicia sesión de nuevo.";
    if (status === 403 || normalized === "FORBIDDEN") return "No tienes permisos para esta acción.";
    if (status === 404 || normalized === "USER_NOT_FOUND") return "Usuario no encontrado.";
    if (normalized === "SELF_DELETE_PROTECTED") return "No puedes borrarte a ti mismo.";
    if (status === 409 || normalized === "LAST_SUPER_ADMIN_PROTECTED") return "No puedes modificar/desactivar al último super admin activo.";
    if (status === 422 || normalized === "INVALID_ROLE_OR_PERMISSIONS") return "Rol o permisos inválidos.";
    return "Error interno del servidor.";
  }

  private async postAdmin(path: string, payload: Record<string, any>): Promise<any> {
    const baseUrl = this.adminApiBaseUrl();
    const response = await fetch(this.buildUrl(path), {
      method: "POST",
      headers: await this.authHeaders(),
      body: JSON.stringify(payload),
    });

    const raw = await response.text();
    const data = raw ? JSON.parse(raw) : {};

    if (!response.ok) {
      const code = (data?.error_code || data?.code || "") as string;
      if (response.status === 404 && !baseUrl) {
        throw new Error("Endpoint no encontrado (404). Configura adminApiBaseUrl con la URL del backend.");
      }
      throw new Error(this.mapApiError(response.status, code));
    }

    return data;
  }

  canViewUsers(): boolean {
    return this.access.canViewUsers();
  }

  canManageUsers(): boolean {
    return this.access.canManageUsers();
  }

  currentPermissionItems(): Array<{ key: AppPermission; label: string }> {
    return ALL_PERMISSIONS.map((key) => ({ key, label: this.permissionLabel(key) }));
  }

  canEditPermissions(): boolean {
    return this.canManageUsers();
  }

  async reload() {
    this.loading.set(true);
    this.error.set(null);
    this.success.set(null);
    try {
      await this.access.refreshProfile();
      if (!this.canViewUsers()) {
        this.error.set("No tienes permiso para ver usuarios.");
        this.rows.set([]);
        return;
      }
      await Promise.all([this.loadUsers(), this.loadAuditLogs()]);
    } catch (e: any) {
      this.error.set(e?.message || "No se pudieron cargar usuarios");
    } finally {
      this.loading.set(false);
    }
  }

  async loadUsers() {
    const snap = await getDocs(collection(FIRESTORE, "admins"));
    const maybeIso = (value: any): string | null => {
      if (!value) return null;
      if (typeof value === "string") return value;
      if (value?.toDate) return value.toDate().toISOString();
      return null;
    };
    const list: AdminRow[] = snap.docs.map((docSnap) => {
      const data = docSnap.data() as Record<string, any>;
      const role = normalizeRole(data["role"]);
      const invitedAt = maybeIso(data["invited_at"] || data["invite_sent_at"]);
      const acceptedAt = maybeIso(data["accepted_at"] || data["invite_accepted_at"] || data["password_set_at"]);
      const lastLoginAt = maybeIso(data["last_login_at"] || data["last_sign_in_at"]);
      const status = String(data["status"] || "").trim().toLowerCase();
      const invitationPending =
        data["invite_pending"] === true ||
        data["invitation_pending"] === true ||
        status === "pending" ||
        status === "invited";
      return {
        uid: docSnap.id,
        email: (data["email"] || null) as string | null,
        username: (data["username"] || null) as string | null,
        displayName: (data["display_name"] || data["name"] || null) as string | null,
        role,
        active: data["active"] === true,
        permissions: buildPermissionsForRole(role, data["permissions"] ?? null),
        invitedAt,
        acceptedAt,
        lastLoginAt,
        invitationPending,
      };
    });
    list.sort((a, b) => (a.displayName || a.email || "").localeCompare(b.displayName || b.email || ""));
    this.rows.set(list);
  }

  async loadAuditLogs() {
    const q = query(collection(FIRESTORE, "audit_logs"), orderBy("created_at", "desc"), limit(80));
    const snap = await getDocs(q);
    const toIso = (val: any) => {
      if (!val) return new Date().toISOString();
      if (val.toDate) return val.toDate().toISOString();
      return String(val);
    };
    this.auditRows.set(
      snap.docs.map((docSnap) => {
        const data = docSnap.data() as Record<string, any>;
        return {
          id: docSnap.id,
          action: String(data["action"] || ""),
          actor_email: (data["actor_email"] || null) as string | null,
          created_at: toIso(data["created_at"]),
          meta: (data["meta"] || {}) as Record<string, any>,
        };
      })
    );
  }

  startCreate() {
    this.editingUid.set(null);
    this.draftDisplayName = "";
    this.draftUsername = "";
    this.draftEmail = "";
    this.draftRole = "administrativo";
    this.draftActive = true;
    this.draftPermissions = buildPermissionsForRole(this.draftRole);
    this.error.set(null);
    this.success.set(null);
  }

  startEdit(row: AdminRow) {
    this.editingUid.set(row.uid);
    this.draftDisplayName = row.displayName || "";
    this.draftUsername = row.username || "";
    this.draftEmail = row.email || "";
    this.draftRole = row.role;
    this.draftActive = row.active;
    this.draftPermissions = { ...row.permissions };
    this.error.set(null);
    this.success.set(null);
  }

  togglePermission(permission: AppPermission, checked: boolean) {
    if (!this.canEditPermissions()) return;
    this.draftPermissions = {
      ...this.draftPermissions,
      [permission]: checked,
    };
  }

  onRoleChange(role: AppRole) {
    this.draftRole = normalizeRole(role);
    this.draftPermissions = buildPermissionsForRole(this.draftRole);
  }

  setAllPermissions(checked: boolean) {
    if (!this.canEditPermissions()) return;
    const next = { ...this.draftPermissions };
    for (const key of ALL_PERMISSIONS) next[key] = checked;
    this.draftPermissions = next;
  }

  applyRoleTemplate() {
    if (!this.canEditPermissions()) return;
    this.draftPermissions = { ...this.rolePreset[this.draftRole] };
  }

  async saveUser() {
    if (!this.canManageUsers()) {
      this.error.set("Solo super admin puede crear o editar usuarios.");
      return;
    }

    this.saving.set(true);
    this.error.set(null);
    this.success.set(null);

    try {
      const displayName = this.draftDisplayName.trim();
      const username = this.draftUsername.trim().toLowerCase();
      const email = this.draftEmail.trim().toLowerCase();
      const isEdit = Boolean(this.editingUid());

      if (!displayName) throw new Error("Nombre visible es obligatorio");
      if (!username) throw new Error("Username es obligatorio");
      if (!email) throw new Error("Email es obligatorio");

      const role = normalizeRole(this.draftRole);
      const permissions = buildPermissionsForRole(role, this.draftPermissions);

      if (isEdit) {
        const uid = this.editingUid();
        if (!uid) throw new Error("UID inválido");

        await this.postAdmin("/admin/users/update-access", {
          uid,
          role,
          active: this.draftActive,
          permissions,
        });

        this.success.set("Acceso de usuario actualizado");
      } else {
        await this.postAdmin("/admin/users/invite", {
          email,
          display_name: displayName,
          username,
          role,
          permissions,
        });

        this.success.set("Usuario invitado. Se envió correo de acceso.");
      }

      await this.reload();
      this.startCreate();
    } catch (e: any) {
      this.error.set(e?.message || "No se pudo guardar usuario");
    } finally {
      this.saving.set(false);
    }
  }

  async resendInvite(row: AdminRow) {
    if (!this.canManageUsers()) {
      this.error.set("Solo super admin puede reenviar invitaciones");
      return;
    }

    this.resendingUid.set(row.uid);
    this.error.set(null);
    this.success.set(null);
    try {
      await this.postAdmin("/admin/users/resend-invite", {
        uid: row.uid,
        email: row.email || undefined,
      });
      this.success.set(`Invitación reenviada a ${row.email || row.uid}`);
      await this.loadAuditLogs();
    } catch (e: any) {
      this.error.set(e?.message || "No se pudo reenviar la invitación");
    } finally {
      this.resendingUid.set(null);
    }
  }

  async sendReset(row: AdminRow) {
    if (!this.canManageUsers()) {
      this.error.set("Solo super admin puede forzar reset de contrasena");
      return;
    }

    this.resettingUid.set(row.uid);
    this.error.set(null);
    this.success.set(null);
    try {
      await this.postAdmin("/admin/users/force-reset-password", {
        uid: row.uid,
      });
      this.success.set(`Reset de contrasena enviado a ${row.email || row.uid}`);
      await this.loadAuditLogs();
    } catch (e: any) {
      this.error.set(e?.message || "No se pudo forzar el reset de contrasena");
    } finally {
      this.resettingUid.set(null);
    }
  }

  async softDelete(row: AdminRow) {
    if (!this.canManageUsers()) {
      this.error.set("Solo super admin puede borrar usuarios.");
      return;
    }
    const myUid = this.access.profile()?.uid || null;
    if (myUid && row.uid === myUid) {
      this.error.set("No puedes borrarte a ti mismo.");
      return;
    }
    const ok = typeof window === "undefined" ? true : window.confirm(`¿Borrar a ${row.displayName || row.email || row.uid}?`);
    if (!ok) return;

    this.deletingUid.set(row.uid);
    this.error.set(null);
    this.success.set(null);
    try {
      await this.postAdmin("/admin/users/delete", {
        uid: row.uid,
      });
      this.success.set(`Usuario ${row.displayName || row.email || row.uid} eliminado.`);
      await this.reload();
    } catch (e: any) {
      this.error.set(e?.message || "No se pudo borrar usuario");
    } finally {
      this.deletingUid.set(null);
    }
  }

  canDeleteRow(row: AdminRow): boolean {
    if (!this.canManageUsers()) return false;
    const myUid = this.access.profile()?.uid || null;
    return row.uid !== myUid;
  }

  isCurrentUser(row: AdminRow): boolean {
    const myUid = this.access.profile()?.uid || null;
    return Boolean(myUid && row.uid === myUid);
  }

  isInvitationPending(row: AdminRow): boolean {
    return Boolean(row.invitationPending || (row.invitedAt && !row.acceptedAt && !row.lastLoginAt));
  }

  isUserEffectivelyActive(row: AdminRow): boolean {
    return Boolean(row.active && !this.isInvitationPending(row));
  }

  canResendInvite(row: AdminRow): boolean {
    if (!this.canManageUsers()) return false;
    if (this.isCurrentUser(row)) return false;
    if (row.role === "super_admin") return false;
    return this.isInvitationPending(row);
  }

  canForceReset(row: AdminRow): boolean {
    if (!this.canManageUsers()) return false;
    if (this.isCurrentUser(row)) return false;
    if (row.role === "super_admin") return false;
    return this.isUserEffectivelyActive(row);
  }

  userStatusLabel(row: AdminRow): string {
    if (this.isInvitationPending(row)) return "Invitacion pendiente";
    if (!row.active) return "Inactivo";
    return "Activo";
  }

  userStatusClass(row: AdminRow): string {
    if (this.isInvitationPending(row)) return "pending";
    if (!row.active) return "off";
    return "on";
  }

  roleLabel(role: AppRole): string {
    const labels: Record<AppRole, string> = {
      super_admin: "Super admin",
      admin: "Admin",
      administrativo: "Administrativo",
      repartidor: "Repartidor",
    };
    return labels[role];
  }

  permissionLabel(permission: AppPermission): string {
    const labels: Record<AppPermission, string> = {
      dashboard: "Dashboard",
      validacion: "Validacion",
      pedidos: "Pedidos",
      catalogo: "Catalogo",
      edicion_productos: "Edicion productos",
      categorias: "Categorias",
      proveedores: "Proveedores",
      inventario: "Inventario",
      clientas: "Clientas",
      rutas: "Rutas",
      localidades: "Localidades",
      usuarios: "Usuarios",
    };
    return labels[permission];
  }
}
