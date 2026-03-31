import { Component, inject, signal, ChangeDetectionStrategy } from "@angular/core";
import { FormsModule } from "@angular/forms";
import { ActivatedRoute, Router } from "@angular/router";
import { AuthService } from "../../../core/auth.service";
import { AccessService } from "../../../core/access.service";

const REMEMBER_IDENTIFIER_KEY = "bm_login_saved_identifier";
const REMEMBER_ENABLED_KEY = "bm_login_remember_identifier";

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: "app-login",
  imports: [FormsModule],
  templateUrl: "./login.html",
  styleUrl: "./login.css",
})
export default class LoginPage {
  identifier = "";
  password = "";
  showPassword = false;
  submitAttempted = false;
  identifierTouched = false;
  passwordTouched = false;
  rememberIdentifier = false;
  loading = signal(false);
  error = signal<string | null>(null);
  info = signal<string | null>(null);
  returnUrl = signal<string>("");

  private auth = inject(AuthService);
  private access = inject(AccessService);
  private router = inject(Router);
  private route = inject(ActivatedRoute);

  ngOnInit() {
    this.restoreRememberedIdentifier();

    const returnUrlParam = this.route.snapshot.queryParams["returnUrl"];
    const reasonParam = this.route.snapshot.queryParams["reason"];
    const permissionParam = this.route.snapshot.queryParams["permission"];
    const sectionParam = this.route.snapshot.queryParams["section"];
    const capabilityParam = this.route.snapshot.queryParams["capability"];

    if (reasonParam) {
      this.error.set(this.mapGuardReasonToMessage(reasonParam, { permissionParam, sectionParam, capabilityParam }));
    }

    if (!returnUrlParam) return;
    if (this.isExternalUrl(returnUrlParam)) {
      this.returnUrl.set("");
      return;
    }
    this.returnUrl.set(this.normalizeReturnUrl(returnUrlParam));
  }

  private isExternalUrl(url: string): boolean {
    return url.startsWith("http://") || url.startsWith("https://") || url.startsWith("//");
  }

  private normalizeReturnUrl(url: string): string {
    if (url.startsWith("/main/review/")) return url;
    if (url.startsWith("/review/")) return `/main${url}`;
    return "";
  }

  private getStorage(): Storage | null {
    try {
      return globalThis.localStorage;
    } catch {
      return null;
    }
  }

  private restoreRememberedIdentifier() {
    const storage = this.getStorage();
    if (!storage) return;

    const rememberEnabled = storage.getItem(REMEMBER_ENABLED_KEY) === "1";
    const savedIdentifier = storage.getItem(REMEMBER_IDENTIFIER_KEY) ?? "";

    this.rememberIdentifier = rememberEnabled;
    if (rememberEnabled && savedIdentifier) {
      this.identifier = savedIdentifier;
    }
  }

  private persistRememberedIdentifier(identifier: string) {
    const storage = this.getStorage();
    if (!storage) return;

    if (this.rememberIdentifier && identifier) {
      storage.setItem(REMEMBER_ENABLED_KEY, "1");
      storage.setItem(REMEMBER_IDENTIFIER_KEY, identifier);
      return;
    }

    storage.setItem(REMEMBER_ENABLED_KEY, "0");
    storage.removeItem(REMEMBER_IDENTIFIER_KEY);
  }

  togglePasswordVisibility() {
    this.showPassword = !this.showPassword;
  }

  markSubmitAttempt() {
    this.submitAttempted = true;
  }

  markIdentifierTouched() {
    this.identifierTouched = true;
  }

  markPasswordTouched() {
    this.passwordTouched = true;
  }

  private isEmailValid(value: string): boolean {
    return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/i.test(value);
  }

  private isUsernameValid(value: string): boolean {
    return /^[a-z0-9._-]{3,40}$/i.test(value);
  }

  getIdentifierError(): string | null {
    const value = this.identifier.trim();
    if (!value) return "El correo o usuario es obligatorio.";
    if (value.includes("@") && !this.isEmailValid(value)) return "Ingresa un correo valido.";
    if (!value.includes("@") && !this.isUsernameValid(value)) return "Usuario invalido (3-40, letras, numeros, . _ -).";
    return null;
  }

  getPasswordError(): string | null {
    if (!this.password) return "La contrasena es obligatoria.";
    return null;
  }

  hasIdentifierError(): boolean {
    return (this.submitAttempted || this.identifierTouched) && !!this.getIdentifierError();
  }

  hasPasswordError(): boolean {
    return (this.submitAttempted || this.passwordTouched) && !!this.getPasswordError();
  }

  hasIdentifierValid(): boolean {
    const shouldValidate = this.submitAttempted || this.identifierTouched;
    return shouldValidate && !this.getIdentifierError();
  }

  hasPasswordValid(): boolean {
    const shouldValidate = this.submitAttempted || this.passwordTouched;
    return shouldValidate && !this.getPasswordError();
  }

  private mapLoginError(error: unknown): string {
    const code = String((error as any)?.code || "").toLowerCase();
    const message = String((error as any)?.message || "");
    const normalizedMessage = message.toLowerCase();
    const looksLikeFirebaseAuthError =
      code.startsWith("auth/") || normalizedMessage.includes("firebase: error (auth/");

    if (looksLikeFirebaseAuthError) {
      if (
        code.includes("auth/invalid-credential") ||
        code.includes("auth/wrong-password") ||
        code.includes("auth/user-not-found") ||
        normalizedMessage.includes("auth/invalid-credential") ||
        normalizedMessage.includes("auth/wrong-password") ||
        normalizedMessage.includes("auth/user-not-found")
      ) {
        return "Correo/usuario o contrasena incorrectos.";
      }
      if (code.includes("auth/invalid-email") || normalizedMessage.includes("auth/invalid-email")) {
        return "El correo no tiene un formato valido.";
      }
      if (code.includes("auth/too-many-requests") || normalizedMessage.includes("auth/too-many-requests")) {
        return "Demasiados intentos fallidos. Espera unos minutos e intenta de nuevo.";
      }
      if (code.includes("auth/user-disabled") || normalizedMessage.includes("auth/user-disabled")) {
        return "Tu cuenta esta deshabilitada. Contacta al administrador.";
      }
      if (
        code.includes("auth/network-request-failed") ||
        normalizedMessage.includes("auth/network-request-failed")
      ) {
        return "No pudimos conectar con el servidor. Revisa tu conexion a internet.";
      }
      return "No pudimos iniciar sesion. Verifica tus datos e intenta de nuevo.";
    }

    if (message) return message;
    return "Error al iniciar sesion.";
  }

  async onLogin() {
    this.markSubmitAttempt();
    this.error.set(null);
    this.info.set(null);

    const normalizedIdentifier = this.identifier.trim().toLowerCase();
    const identifierError = this.getIdentifierError();
    const passwordError = this.getPasswordError();

    if (identifierError || passwordError) return;

    this.loading.set(true);

    try {
      console.info("[LOGIN] Attempting Firebase auth", { identifier: normalizedIdentifier });
      await this.auth.login(normalizedIdentifier, this.password);
      const status = await this.auth.getAccessStatus();
      console.info("[LOGIN] Access status", status);

      if (status.mustChangePassword || status.invitePending) {
        const moved = await this.router.navigateByUrl("/activate-account");
        if (!moved) {
          this.error.set("No se pudo navegar a la pantalla de activacion.");
        }
        return;
      }

      if (!status.isActive) {
        await this.auth.logout();
        throw new Error("Usuario pendiente de activacion.");
      }

      this.persistRememberedIdentifier(normalizedIdentifier);
      const profile = await this.access.refreshProfile({ force: true });
      const firstAllowed = this.access.firstAllowedRoute();
      const preferred = this.returnUrl() || firstAllowed;
      console.info("[LOGIN] Route resolution", {
        preferred,
        firstAllowed,
        role: profile?.role,
        active: profile?.active,
        permissions: profile?.permissions,
      });

      if (firstAllowed === "/login") {
        const granted = Object.entries(profile?.permissions || {})
          .filter((entry) => entry[1] === true)
          .map((entry) => entry[0]);
        throw new Error(
          `Sesion iniciada, pero sin rutas permitidas. Rol: ${profile?.role || "desconocido"}, permisos activos: ${
            granted.length ? granted.join(", ") : "ninguno"
          }.`,
        );
      }

      const moved = await this.router.navigateByUrl(preferred);
      if (!moved) {
        const fallbackMoved = preferred === firstAllowed ? false : await this.router.navigateByUrl(firstAllowed);
        if (!fallbackMoved) {
          this.error.set("Sesion iniciada, pero no fue posible entrar al sistema.");
        }
      }
    } catch (e: any) {
      console.error("[LOGIN] Failed", e);
      this.error.set(this.mapLoginError(e));
    } finally {
      this.loading.set(false);
    }
  }

  async onForgotPassword() {
    if (this.loading()) return;
    this.error.set(null);
    this.info.set(null);
    this.identifierTouched = true;

    const identifier = this.identifier.trim().toLowerCase();
    if (!identifier) {
      this.error.set("Ingresa tu correo o usuario para recuperar contrasena.");
      return;
    }
    if (this.getIdentifierError()) {
      this.error.set(this.getIdentifierError());
      return;
    }

    this.loading.set(true);
    try {
      const mode = await this.auth.requestPasswordReset(identifier);
      if (mode === "username") {
        this.info.set("Este acceso es de tipo usuario. Solicita al administrador una contrasena temporal.");
        return;
      }
      this.info.set("Si el correo existe, enviamos instrucciones para restablecer la contrasena.");
    } catch (error: any) {
      this.error.set(error?.message || "No se pudo procesar la recuperacion.");
    } finally {
      this.loading.set(false);
    }
  }

  private mapGuardReasonToMessage(
    reason: string,
    ctx: { permissionParam?: string; sectionParam?: string; capabilityParam?: string },
  ): string {
    if (reason === "UNAUTHENTICATED") return "Debes iniciar sesion para continuar.";
    if (reason === "INACTIVE_USER") return "Tu usuario esta inactivo o pendiente de activacion.";
    if (reason === "NO_ROUTE_PERMISSION") {
      return `No tienes permiso para la ruta solicitada${ctx.permissionParam ? ` (${ctx.permissionParam})` : ""}.`;
    }
    if (reason === "NO_SECTION_PERMISSION") {
      return `No tienes acceso a la seccion solicitada${ctx.sectionParam ? ` (${ctx.sectionParam})` : ""}.`;
    }
    if (reason === "NO_CAPABILITY_PERMISSION") {
      return `No tienes capability para esta accion${ctx.capabilityParam ? ` (${ctx.capabilityParam})` : ""}.`;
    }
    return `Acceso bloqueado (${reason}).`;
  }
}
