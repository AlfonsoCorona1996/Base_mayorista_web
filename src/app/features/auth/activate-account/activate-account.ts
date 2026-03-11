import { Component, inject, signal } from "@angular/core";
import { FormsModule } from "@angular/forms";
import { Router } from "@angular/router";
import { updatePassword } from "firebase/auth";
import { FIREBASE_AUTH } from "../../../core/firebase.providers";
import { AccessService } from "../../../core/access.service";
import { AuthService } from "../../../core/auth.service";
import { UserAdminApiService } from "../../../services/user-admin-api.service";

@Component({
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
      await updatePassword(current, this.password);
      await current.getIdToken(true);

      const completeResult = await this.tryCompleteFirstLogin(current.uid);
      if (!completeResult.ok) {
        const boot = await this.userAdminApi.getSessionBootstrap().catch(() => null);
        if (!boot || boot.mustChangePassword) {
          if (boot?.isActive && boot.invitePending === false && boot.mustChangePassword) {
            throw new Error(
              "Backend devolvio estado inconsistente: mustChangePassword=true pero complete-first-login responde conflicto.",
            );
          }
          throw new Error(completeResult.message || "No se pudo cerrar el estado de primer login.");
        }
      }

      this.auth.invalidateAccessCache();
      const status = await this.auth.getAccessStatus();
      if (status.mustChangePassword) {
        throw new Error("No se pudo cerrar el estado de primer login.");
      }
      this.success.set("Contrasena actualizada.");
      await this.redirectToFirstAllowedRoute();
    } catch (error: any) {
      this.error.set(error?.message || "No se pudo actualizar la contrasena.");
    } finally {
      this.loading.set(false);
    }
  }

  private async redirectToFirstAllowedRoute() {
    await this.access.refreshProfile();
    const target = this.access.firstAllowedRoute();
    await this.router.navigateByUrl(target === "/login" ? "/main/dashboard" : target);
  }

  private async tryCompleteFirstLogin(uid: string): Promise<{ ok: true } | { ok: false; message: string }> {
    try {
      await this.userAdminApi.completeFirstLogin(uid);
      return { ok: true };
    } catch (firstError: any) {
      const firstMessage = String(firstError?.message || "");
      const messageLower = firstMessage.toLowerCase();
      const shouldRetryWithoutUid =
        messageLower.includes("first-login pending state") || messageLower.includes("invalid_state") || messageLower.includes("409");

      if (!shouldRetryWithoutUid) return { ok: false, message: firstMessage || "No se pudo cerrar el estado de primer login." };

      try {
        const current = FIREBASE_AUTH.currentUser;
        if (current) await current.getIdToken(true);
        await this.userAdminApi.completeFirstLogin();
        return { ok: true };
      } catch (secondError: any) {
        return {
          ok: false,
          message: String(secondError?.message || firstMessage || "No se pudo cerrar el estado de primer login."),
        };
      }
    }
  }
}
