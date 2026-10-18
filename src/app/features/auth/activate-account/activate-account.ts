import { Component, inject, signal, ChangeDetectionStrategy } from "@angular/core";
import { FormsModule } from "@angular/forms";
import { Router } from "@angular/router";
import { FIREBASE_AUTH } from "../../../core/firebase.providers";
import { AccessService } from "../../../core/access.service";
import { AuthService } from "../../../core/auth.service";
import { UserAdminApiService } from "../../../services/user-admin-api.service";

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  standalone: true,
  selector: "app-activate-account",
  imports: [FormsModule],
  templateUrl: "./activate-account.html",
  styleUrl: "./activate-account.css",
})
export default class ActivateAccountPage {
  password = "";
  confirmPassword = "";
  submitAttempted = false;
  loading = signal(false);
  error = signal<string | null>(null);
  success = signal<string | null>(null);

  private router = inject(Router);
  private auth = inject(AuthService);
  private access = inject(AccessService);
  private userAdminApi = inject(UserAdminApiService);

  async ngOnInit() {
    const status = await this.auth.getAccessStatus();
    if (!status.uid) {
      await this.router.navigateByUrl("/login");
      return;
    }
    if (!status.mustChangePassword && !status.invitePending && status.isActive) {
      await this.redirectToFirstAllowedRoute();
    }
  }

  private passwordError(value: string): string | null {
    if (!value) return "La contrasena es obligatoria.";
    if (value.length < 8) return "Usa al menos 8 caracteres.";
    if (value.length > 128) return "Usa como maximo 128 caracteres.";
    return null;
  }

  getPasswordError(): string | null {
    return this.passwordError(this.password);
  }

  getConfirmPasswordError(): string | null {
    if (!this.confirmPassword) return "Confirma la contrasena.";
    if (this.confirmPassword !== this.password) return "Las contrasenas no coinciden.";
    return null;
  }

  hasPasswordError(): boolean {
    return this.submitAttempted && !!this.getPasswordError();
  }

  hasConfirmPasswordError(): boolean {
    return this.submitAttempted && !!this.getConfirmPasswordError();
  }

  async submit() {
    if (this.loading()) return;
    this.submitAttempted = true;
    this.error.set(null);
    this.success.set(null);

    const passwordError = this.getPasswordError();
    const confirmError = this.getConfirmPasswordError();
    if (passwordError || confirmError) return;

    const current = FIREBASE_AUTH.currentUser;
    if (!current) {
      this.error.set("Sesion no valida.");
      await this.router.navigateByUrl("/login");
      return;
    }

    this.loading.set(true);
    try {
      // El servidor cambia la contraseña antes de cerrar el primer acceso.
      // Un cliente no puede activar la cuenta enviando solo su uid.
      await this.userAdminApi.completeFirstLogin(this.password);
      await this.auth.login(current.email || "", this.password);
      this.password = "";
      this.confirmPassword = "";
      this.submitAttempted = false;
      this.auth.invalidateAccessCache();
      const status = await this.auth.getAccessStatus();
      if (status.mustChangePassword || status.invitePending || !status.isActive) {
        throw new Error("No se pudo cerrar el estado de primer login.");
      }
      this.success.set("Contrasena actualizada.");
      await this.redirectToFirstAllowedRoute();
    } catch (error: unknown) {
      this.error.set(error instanceof Error ? error.message : "No se pudo actualizar la contrasena.");
    } finally {
      this.loading.set(false);
    }
  }

  private async redirectToFirstAllowedRoute() {
    await this.access.refreshProfile({ force: true });
    const target = this.access.firstAllowedRoute();
    await this.router.navigateByUrl(target);
  }
}
