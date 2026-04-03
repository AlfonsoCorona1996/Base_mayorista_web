import { CommonModule } from "@angular/common";
import { ChangeDetectionStrategy, Component, computed, input, output, signal } from "@angular/core";

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: "app-chat-composer",
  standalone: true,
  imports: [CommonModule],
  templateUrl: "./chat-composer.component.html",
  styleUrl: "./chat-composer.component.css",
})
export class ChatComposerComponent {
  disabled = input(false);
  sending = input(false);
  windowOpen = input(true);
  sendError = input<string | null>(null);
  windowClosedHint = input(
    "La ventana de 24 horas está cerrada. Para escribir primero debes usar una plantilla.",
  );

  sendRequested = output<string>();

  readonly draft = signal("");
  readonly canSend = computed(
    () => !this.disabled() && !this.sending() && this.windowOpen() && this.draft().trim().length > 0,
  );

  onDraftChange(event: Event): void {
    const target = event.target as HTMLTextAreaElement | null;
    this.draft.set(target?.value || "");
  }

  onSubmit(): void {
    if (!this.canSend()) return;
    this.sendRequested.emit(this.draft().trim());
  }

  onKeydown(event: KeyboardEvent): void {
    if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
      event.preventDefault();
      this.onSubmit();
    }
  }

  clear(): void {
    this.draft.set("");
  }
}
