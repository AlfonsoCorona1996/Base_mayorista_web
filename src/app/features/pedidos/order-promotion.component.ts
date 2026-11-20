import { ChangeDetectionStrategy, Component, ElementRef, computed, effect, inject, input, model, signal, viewChild } from "@angular/core";
import { CurrencyPipe } from "@angular/common";
import { FormsModule } from "@angular/forms";
import { Order, OrdersService } from "../../core/orders.service";
import { calculateOrderFinancials } from "../../core/order-financials";
import { hasDeliveryEvidence } from "../../core/order-closure";
import { applyPromotionChanges, PromotionChange, promotionChanges, promotionRevision, promotionRows, PromotionScope, validPromotionPercent } from "./order-promotion";

@Component({
  selector: "app-order-promotion",
  standalone: true,
  imports: [CurrencyPipe, FormsModule],
  templateUrl: "./order-promotion.component.html",
  styleUrl: "./order-promotion.component.css",
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class OrderPromotionComponent {
  private readonly orders = inject(OrdersService);
  readonly order = input.required<Order>();
  readonly editable = input(false);
  readonly open = model(false);
  readonly dialog = viewChild<ElementRef<HTMLDialogElement>>("dialog");
  readonly percent = signal<number | null>(30);
  readonly preset = signal<number | "custom">(30);
  readonly scope = signal<PromotionScope>("standard");
  readonly selected = signal<string[]>([]);
  readonly saving = signal(false);
  readonly savingCount = signal(0);
  readonly error = signal<string | null>(null);
  readonly result = signal<string | null>(null);
  readonly undoChanges = signal<PromotionChange[]>([]);
  readonly validPercent = computed(() => validPromotionPercent(this.percent()));
  readonly rows = computed(() => promotionRows(this.order().items, this.percent(), this.scope(), this.selected()));
  readonly changes = computed(() => this.validPercent() ? promotionChanges(this.rows(), this.percent()!) : []);
  readonly eligible = computed(() => this.rows().filter(row => !row.reason));
  readonly skipped = computed(() => this.rows().filter(row => row.reason).length);
  readonly increases = computed(() => this.rows().filter(row => row.selected && row.after > row.before).length);
  readonly allSelected = computed(() => this.eligible().length > 0 && this.eligible().every(row => this.selected().includes(row.item.item_id)));
  readonly totals = computed(() => ({
    before: calculateOrderFinancials(this.order()).netAmount,
    after: calculateOrderFinancials({ ...this.order(), items: applyPromotionChanges(this.order().items, this.changes()) }).netAmount,
  }));
  private focusReturn: HTMLElement | null = null;
  private activeOrderId: string | null = null;

  constructor() {
    effect(() => {
      const id = this.order().order_id;
      if (this.activeOrderId !== id) {
        if (this.activeOrderId !== null) this.open.set(false);
        this.activeOrderId = id;
        this.undoChanges.set([]);
        this.result.set(null);
        this.error.set(null);
        this.selected.set([]);
      }
      const dialog = this.dialog()?.nativeElement;
      if (!dialog) return;
      if (this.open() && !dialog.open) {
        this.focusReturn = document.querySelector<HTMLElement>(".products-more-btn");
        this.error.set(null);
        dialog.showModal();
      } else if (!this.open() && dialog.open) {
        dialog.close();
        this.focusReturn?.focus();
      }
    });
  }

  close(event?: Event): void {
    event?.preventDefault();
    if (!this.saving()) this.open.set(false);
  }

  onDialogKeydown(event: KeyboardEvent): void {
    if (event.key !== "Tab") return;
    const dialog = this.dialog()?.nativeElement;
    if (!dialog) return;
    const controls = Array.from(dialog.querySelectorAll<HTMLElement>("button, input, select"))
      .filter(control => !control.matches(":disabled") && control.getClientRects().length > 0);
    const first = controls[0];
    const last = controls[controls.length - 1];
    if (!first || (event.shiftKey && document.activeElement === first) || (!event.shiftKey && document.activeElement === last)) {
      event.preventDefault();
      (event.shiftKey ? last : first)?.focus();
    }
  }

  choosePreset(value: number | "custom"): void {
    this.preset.set(value);
    if (value !== "custom") this.percent.set(value);
  }

  toggleItem(id: string, checked: boolean): void {
    this.selected.update(ids => checked ? [...new Set([...ids, id])] : ids.filter(value => value !== id));
  }

  toggleAll(checked: boolean): void {
    this.selected.set(checked ? this.eligible().map(row => row.item.item_id) : []);
  }

  private canSave(order: Order): boolean {
    return this.editable() && !["entregado", "entregado_parcial", "pagado", "cancelado", "devuelto", "closed"].includes(order.status)
      && order.delivery_status !== "delivered" && !hasDeliveryEvidence(order);
  }

  async save(undo = false): Promise<void> {
    if (this.saving()) return;
    const reviewed = this.order();
    const live = this.orders.getById(reviewed.order_id);
    const changes = undo ? this.undoChanges() : this.changes();
    const percent = this.percent();
    this.error.set(null);
    if (!live || !this.canSave(live)) {
      this.error.set("Este pedido ya no permite editar sus productos.");
      return;
    }
    if (promotionRevision(live) !== promotionRevision(reviewed)) {
      this.error.set("El pedido cambió. Revisa la vista previa actualizada antes de volver a aplicar.");
      return;
    }
    if (!changes.length || (!undo && !this.validPercent())) return;
    if (undo && changes.some(change => {
      const item = live.items.find(row => row.item_id === change.itemId);
      return !item || item.price_clienta !== change.after || item.discount_pct !== change.afterPct
        || (item.returned_qty ?? 0) > 0 || item.state === "cancelado" || item.state === "devuelto"
        || (change.before ?? item.price_public ?? 0) < (item.price_cost ?? 0);
    })) {
      this.error.set("Hay productos modificados después de la promoción. Revisa sus precios individualmente para no sobrescribir esos cambios.");
      return;
    }
    this.saving.set(true);
    this.savingCount.set(changes.length);
    try {
      await this.orders.updateItems(live.order_id, applyPromotionChanges(live.items, changes, undo), live.items);
      let result = undo ? `Precios anteriores restaurados en ${changes.length} productos.`
        : `Promoción del ${percent} % aplicada: ${changes.length} de ${live.items.length} productos actualizados; ${live.items.length - changes.length} sin cambios.`;
      // Logging is separate: an audit failure must never report a successful price write as failed.
      try {
        await this.orders.logEvent(live.order_id, "ITEM_UPDATED", undo ? "Promoción deshecha" : "Promoción masiva aplicada", {
          action: undo ? "promotion_undo" : "promotion_apply", changes,
        });
      } catch {
        result += " No se pudo registrar en la bitácora.";
      }
      if (this.order().order_id !== live.order_id) return;
      this.undoChanges.set(undo ? [] : changes);
      this.result.set(result);
      this.open.set(false);
    } catch {
      if (this.order().order_id === live.order_id) {
        this.error.set(`No se pudo confirmar el ${undo ? "restablecimiento" : "guardado"} de ${changes.length} productos. Revisa los precios y vuelve a intentar.`);
      }
    } finally {
      this.saving.set(false);
    }
  }
}
