import { ChangeDetectionStrategy, Component, computed, inject, signal } from "@angular/core";
import { CurrencyPipe, DatePipe } from "@angular/common";
import { ActivatedRoute, RouterLink } from "@angular/router";
import { InventoryService } from "../../core/inventory.service";

@Component({
  standalone: true,
  selector: "app-inventario-detalle",
  imports: [RouterLink, CurrencyPipe, DatePipe],
  templateUrl: "./inventario-detalle.html",
  styleUrl: "./inventario-detalle.css",
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export default class InventarioDetallePage {
  private inventory = inject(InventoryService);
  private id = inject(ActivatedRoute).snapshot.paramMap.get("id") || "";
  loading = signal(true);
  scrapping = signal(false);

  item = computed(() => this.inventory.items().find((row) => row.inventory_id === this.id) || null);
  movements = computed(() => this.inventory.movementsFor(this.id));
  reservations = computed(() => Object.entries(this.item()?.reservations || {}).filter(([, value]) => value.status === "reserved").map(([key, value]) => ({ key, orderId: key.split(":")[0], ...value })));

  constructor() {
    this.inventory.loadFromFirestore().finally(() => this.loading.set(false));
  }

  qty(value: unknown): number {
    return Math.max(0, Math.trunc(Number(value || 0)));
  }

  movementLabel(type: string): string {
    return ({ receipt: "Recepción", reserve: "Reserva", release: "Liberación", sale: "Venta", return: "Devolución", quality_approve: "Aprobado", damage: "Daño", scrap: "Baja", adjustment: "Ajuste" } as Record<string, string>)[type] || type;
  }

  async discardDamaged(): Promise<void> {
    const item = this.item();
    const damaged = this.qty(item?.damaged_qty);
    if (!item || damaged <= 0) return;
    const raw = window.prompt(`¿Cuántas piezas dañadas quieres dar de baja? Máximo ${damaged}`, String(damaged));
    if (raw === null) return;
    const qty = Math.max(0, Math.trunc(Number(raw)));
    const reason = window.prompt("Motivo de la baja", "Mercancía dañada no recuperable") || "Baja de mercancía dañada";
    this.scrapping.set(true);
    try { await this.inventory.scrapDamaged(item.inventory_id, qty, reason); }
    finally { this.scrapping.set(false); }
  }
}
