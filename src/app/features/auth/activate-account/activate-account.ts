import { Component, inject, signal } from "@angular/core";
import { FormsModule } from "@angular/forms";
import { Router } from "@angular/router";
import { updatePassword } from "firebase/auth";
import { FIREBASE_AUTH } from "../../../core/firebase.providers";
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
  private userAdminApi = inject(UserAdminApiService);

  async ngOnInit() {
    const status = await this.auth.getAccessStatus();
    if (!status.uid) {
      await this.router.navigateByUrl("/login");
      return;
    }
    if (!status.mustChangePassword && status.isActive) {
      await this.router.navigateByUrl("/main/dashboard");
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
      await this.userAdminApi.completeFirstLogin(current.uid);
      this.auth.invalidateAccessCache();
      const status = await this.auth.getAccessStatus();
      if (status.mustChangePassword) {
        throw new Error("No se pudo cerrar el estado de primer login.");
      }
      this.success.set("Contrasena actualizada.");
      await this.router.navigateByUrl("/main/dashboard");
    } catch (error: any) {
      this.error.set(error?.message || "No se pudo actualizar la contrasena.");
    } finally {
      this.loading.set(false);
    }
  }
}
