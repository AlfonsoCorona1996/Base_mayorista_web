import { Component, signal, inject } from "@angular/core";
import { FormsModule } from "@angular/forms";
import { Router, ActivatedRoute } from "@angular/router";
import { AuthService } from "../../../core/auth.service";

@Component({
  selector: "app-login",
  imports: [FormsModule],
  templateUrl: "./login.html",
  styleUrl: "./login.css",
})
export default class LoginPage {
  email = "";
  password = "";
  loading = signal(false);
  error = signal<string | null>(null);
  returnUrl = signal<string>("/main/dashboard");

  private auth = inject(AuthService);
  private router = inject(Router);
  private route = inject(ActivatedRoute);

  ngOnInit() {
    const returnUrlParam = this.route.snapshot.queryParams["returnUrl"];

    if (!returnUrlParam) return;

    if (this.isExternalUrl(returnUrlParam)) {
      console.warn("URL externa bloqueada:", returnUrlParam);
      this.returnUrl.set("/main/dashboard");
      return;
    }

    const normalizedReturnUrl = this.normalizeReturnUrl(returnUrlParam);
    console.log("returnUrl capturado:", normalizedReturnUrl);
    this.returnUrl.set(normalizedReturnUrl);
  }

  private isExternalUrl(url: string): boolean {
    return url.startsWith("http://") || url.startsWith("https://") || url.startsWith("//");
  }

  private normalizeReturnUrl(url: string): string {
    if (url.startsWith("/main/")) return url;
    if (url.startsWith("/review/")) return `/main${url}`;
    return "/main/dashboard";
  }

  async onLogin() {
    this.error.set(null);
    this.loading.set(true);
    try {
      await this.auth.login(this.email.trim(), this.password);
      const status = await this.auth.bootstrapSession();
      if (status !== "OK") {
        await this.auth.logout();
        if (status === "INVITE_PENDING") {
          throw new Error("Cuenta pendiente de activacion. Acepta la invitacion desde tu correo para continuar.");
        }
        throw new Error("No autorizado (no es admin).");
      }

      const destination = this.returnUrl();
      console.log("Login exitoso, redirigiendo a:", destination);
      await this.router.navigateByUrl(destination);
    } catch (e: any) {
      this.error.set(e?.message || "Error al iniciar sesion");
    } finally {
      this.loading.set(false);
    }
  }
}
