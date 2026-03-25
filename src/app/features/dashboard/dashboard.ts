import { Component, ChangeDetectionStrategy, inject, OnInit } from "@angular/core";
import { RouterLink } from "@angular/router";
import { CurrencyPipe, DatePipe, NgClass } from "@angular/common";
import { SmartAlertsService, SmartAlert, AlertSeverity } from "../../core/smart-alerts.service";
import { OrdersService } from "../../core/orders.service";
import { CustomersService } from "../../core/customers.service";
import { RoutesService } from "../../core/routes.service";

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  standalone: true,
  selector: "app-dashboard",
  imports: [RouterLink, CurrencyPipe, DatePipe, NgClass],
  templateUrl: "./dashboard.html",
  styleUrl: "./dashboard.css",
})
export default class DashboardPage implements OnInit {
  readonly alertsSvc = inject(SmartAlertsService);
  private readonly ordersSvc = inject(OrdersService);
  private readonly customersSvc = inject(CustomersService);
  private readonly routesSvc = inject(RoutesService);

  readonly alerts = this.alertsSvc.allAlerts;
  readonly kpis = this.alertsSvc.kpis;
  readonly criticalCount = this.alertsSvc.criticalCount;

  /** IDs de alertas que el usuario ha descartado en esta sesión */
  dismissed = new Set<string>();

  async ngOnInit(): Promise<void> {
    await Promise.all([
      this.ordersSvc.loadFromFirestore(),
      this.customersSvc.loadFromFirestore(),
      this.routesSvc.loadFromFirestore(),
    ]);
  }

  visibleAlerts(): SmartAlert[] {
    return this.alerts().filter(a => !this.dismissed.has(a.id));
  }

  dismiss(id: string): void {
    this.dismissed.add(id);
  }

  severityLabel(s: AlertSeverity): string {
    return { critical: "Crítico", urgent: "Urgente", warning: "Aviso", opportunity: "Oportunidad" }[s];
  }

  now(): Date {
    return new Date();
  }
}
