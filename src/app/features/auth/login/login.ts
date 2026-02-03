import { Component, signal, inject } from "@angular/core";
import { FormsModule } from "@angular/forms";
import { Router, ActivatedRoute } from "@angular/router";
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
  returnUrl = signal<string>("/inbox");

  private auth = inject(AuthService);
  private router = inject(Router);
  private route = inject(ActivatedRoute);

  ngOnInit() {
    // 🔑 DEEP LINKING: Capturar returnUrl del query param
    const returnUrlParam = this.route.snapshot.queryParams['returnUrl'];
    
    if (returnUrlParam) {
      // 🔒 SEGURIDAD: Validar que sea una ruta interna
      if (this.isExternalUrl(returnUrlParam)) {
        console.warn('⚠️ URL externa bloqueada:', returnUrlParam);
        this.returnUrl.set("/inbox");
      } else {
        console.log('🔗 returnUrl capturado:', returnUrlParam);
        this.returnUrl.set(returnUrlParam);
      }
    }
  }

  private isExternalUrl(url: string): boolean {
    return url.startsWith('http://') || 
           url.startsWith('https://') || 
           url.startsWith('//');
  }

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
      
      // 🔑 DEEP LINKING: Redirigir a la URL original
      const destination = this.returnUrl();
      console.log('✅ Login exitoso, redirigiendo a:', destination);
      await this.router.navigateByUrl(destination);
      
    } catch (e: any) {
      this.error.set(e?.message || "Error al iniciar sesión");
    } finally {
      this.loading.set(false);
    }
  }
}