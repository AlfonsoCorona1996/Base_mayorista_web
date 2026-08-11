import { ChangeDetectionStrategy, Component, computed, input, output } from "@angular/core";

export type ClientaDiscountMode = "pct" | "fixed";

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  standalone: true,
  selector: "app-clienta-discount-panel",
  templateUrl: "./clienta-discount-panel.component.html",
  styleUrl: "./clienta-discount-panel.component.css",
})
export class ClientaDiscountPanelComponent {
  readonly panelId = input("clienta-discount-panel");
  readonly title = input("Definir precio clienta");
  readonly mode = input<ClientaDiscountMode>("pct");
  readonly percent = input(25);
  readonly fixedAmount = input(0);
  readonly previewText = input("—");
  readonly saving = input(false);
  readonly applyDisabled = input(false);
  readonly applyLabel = input("Aplicar");
  readonly helpText = input<string | null>(null);
  readonly errorText = input<string | null>(null);
  readonly presets = input<readonly number[]>([10, 15, 20, 25, 30]);

  readonly modeChange = output<ClientaDiscountMode>();
  readonly percentChange = output<number>();
  readonly fixedAmountChange = output<number>();
  readonly cancel = output<void>();
  readonly apply = output<void>();

  readonly titleId = computed(() => `${this.panelId()}-title`);
  readonly errorId = computed(() => `${this.panelId()}-error`);
  readonly helpId = computed(() => `${this.panelId()}-help`);
  readonly descriptionIds = computed(() => {
    const ids: string[] = [];
    if (this.errorText()) ids.push(this.errorId());
    if (this.helpText()) ids.push(this.helpId());
    return ids.length ? ids.join(" ") : null;
  });
  readonly isApplyDisabled = computed(() => this.applyDisabled() || this.saving());

  selectMode(mode: ClientaDiscountMode): void {
    if (this.saving()) return;
    this.modeChange.emit(mode);
  }

  selectPercent(percent: number): void {
    if (this.saving()) return;
    this.percentChange.emit(percent);
  }

  onPercentInput(event: Event): void {
    this.percentChange.emit(this.readNumber(event));
  }

  onFixedAmountInput(event: Event): void {
    this.fixedAmountChange.emit(this.readNumber(event));
  }

  private readNumber(event: Event): number {
    const inputElement = event.target as HTMLInputElement | null;
    const value = inputElement?.valueAsNumber;
    return value !== undefined && Number.isFinite(value) ? value : 0;
  }
}
