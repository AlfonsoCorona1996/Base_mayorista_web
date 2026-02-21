import { Component, signal, inject } from "@angular/core";
import { FormsModule } from "@angular/forms";
import { Router, ActivatedRoute } from "@angular/router";
import { AuthService } from "../../../core/auth.service";

const REMEMBER_EMAIL_KEY = "bm_login_saved_email";
const REMEMBER_ENABLED_KEY = "bm_login_remember_email";

@Component({
  selector: "app-login",
  imports: [FormsModule],
  templateUrl: "./login.html",
  styleUrl: "./login.css",
})
export default class LoginPage {
  email = "";
  password = "";
  showPassword = false;
  submitAttempted = false;
  emailTouched = false;
  passwordTouched = false;
  rememberEmail = false;
  loading = signal(false);
  error = signal<string | null>(null);
  returnUrl = signal<string>("/main/dashboard");

  private auth = inject(AuthService);
  private router = inject(Router);
  private route = inject(ActivatedRoute);

  ngOnInit() {
    this.restoreRememberedEmail();

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
    // Deep links de revision se respetan; todo lo demas entra por dashboard.
    if (url.startsWith("/main/review/")) return url;
    if (url.startsWith("/review/")) return `/main${url}`;
    return "/main/dashboard";
  }

  private getStorage(): Storage | null {
    try {
      return globalThis.localStorage;
    } catch {
      return null;
    }
  }

  private restoreRememberedEmail() {
    const storage = this.getStorage();
    if (!storage) return;

    const rememberEnabled = storage.getItem(REMEMBER_ENABLED_KEY) === "1";
    const savedEmail = storage.getItem(REMEMBER_EMAIL_KEY) ?? "";

    this.rememberEmail = rememberEnabled;
    if (rememberEnabled && savedEmail) {
      this.email = savedEmail;
    }
  }

  private persistRememberedEmail(email: string) {
    const storage = this.getStorage();
    if (!storage) return;

    if (this.rememberEmail && email) {
      storage.setItem(REMEMBER_ENABLED_KEY, "1");
      storage.setItem(REMEMBER_EMAIL_KEY, email);
      return;
    }

    storage.setItem(REMEMBER_ENABLED_KEY, "0");
    storage.removeItem(REMEMBER_EMAIL_KEY);
  }

  togglePasswordVisibility() {
    this.showPassword = !this.showPassword;
  }

  markSubmitAttempt() {
    this.submitAttempted = true;
  }

  markEmailTouched() {
    this.emailTouched = true;
  }

  markPasswordTouched() {
    this.passwordTouched = true;
  }

  private isEmailValid(value: string): boolean {
    // Validation deliberately strict enough for auth input, while avoiding very complex RFC regex.
    return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/i.test(value);
  }

  getEmailError(): string | null {
    const value = this.email.trim();
    if (!value) return "El correo es obligatorio.";
    if (!this.isEmailValid(value)) return "Ingresa un correo valido.";
    return null;
  }

  getPasswordError(): string | null {
    if (!this.password) return "La contrasena es obligatoria.";
    return null;
  }

  hasEmailError(): boolean {
    return (this.submitAttempted || this.emailTouched) && !!this.getEmailError();
  }

  hasPasswordError(): boolean {
    return (this.submitAttempted || this.passwordTouched) && !!this.getPasswordError();
  }

  hasEmailValid(): boolean {
    const shouldValidate = this.submitAttempted || this.emailTouched;
    return shouldValidate && !this.getEmailError();
  }

  hasPasswordValid(): boolean {
    const shouldValidate = this.submitAttempted || this.passwordTouched;
    return shouldValidate && !this.getPasswordError();
  }

  async onLogin() {
    this.markSubmitAttempt();
    this.error.set(null);

    const normalizedEmail = this.email.trim();
    const emailError = this.getEmailError();
    const passwordError = this.getPasswordError();

    if (emailError || passwordError) {
      return;
    }

    this.loading.set(true);

    try {
      await this.auth.login(normalizedEmail, this.password);
      const ok = await this.auth.isAdmin();
      if (!ok) {
        await this.auth.logout();
        throw new Error("No autorizado (no es admin).");
      }

      this.persistRememberedEmail(normalizedEmail);

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
