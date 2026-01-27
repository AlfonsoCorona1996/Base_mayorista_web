import { Component, signal } from "@angular/core";
import { CommonModule } from "@angular/common";
import { FormsModule } from "@angular/forms";
import { Router } from "@angular/router";
import { AuthService } from "../../../core/auth.service";

@Component({
  selector: 'app-login',
  imports: [FormsModule],
  templateUrl: './login.html',
  styleUrl: './login.css',
})
export default class LoginPage {
  email = "";
  password = "";
  loading = signal(false);
  error = signal<string | null>(null);

  constructor(private auth: AuthService, private router: Router) {}

  async onLogin() {
    this.error.set(null);
    this.loading.set(true);
    try {
      await this.auth.login(this.email.trim(), this.password);
      const ok = await this.auth.isAdmin();
      if (!ok) {
        await this.auth.logout();
        throw new Error("No autorizado (no es admin).");
      }
      await this.router.navigateByUrl("/inbox");
    } catch (e: any) {
      this.error.set(e?.message || "Error al iniciar sesión");
    } finally {
      this.loading.set(false);
    }
  }
}