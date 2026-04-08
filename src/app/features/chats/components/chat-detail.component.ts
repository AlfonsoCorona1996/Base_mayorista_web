import { CommonModule } from "@angular/common";
import { ChangeDetectionStrategy, Component, ViewChild, input, output } from "@angular/core";
import { ChatComposerComponent } from "./chat-composer.component";
import { ChatMessageListComponent } from "./chat-message-list.component";
import { ChatConversation, ChatMessage, ChatStatus } from "../data/chats.models";

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: "app-chat-detail",
  standalone: true,
  imports: [CommonModule, ChatMessageListComponent, ChatComposerComponent],
  templateUrl: "./chat-detail.component.html",
  styleUrl: "./chat-detail.component.css",
})
export class ChatDetailComponent {
  chat = input<ChatConversation | null>(null);
  messages = input<ChatMessage[]>([]);
  loading = input(false);
  messagesLoading = input(false);
  detailError = input<string | null>(null);
  messagesError = input<string | null>(null);
  sending = input(false);
  sendError = input<string | null>(null);
  isMobile = input(false);
  canReply = input(true);
  windowClosedHint = input(
    "La ventana de 24 horas está cerrada. Para escribir primero debes usar una plantilla.",
  );
  sendMessageFn = input.required<(message: string) => Promise<boolean>>();

  backRequested = output<void>();
  refreshRequested = output<void>();
  markReadRequested = output<void>();
  closeRequested = output<void>();

  @ViewChild(ChatComposerComponent) composer?: ChatComposerComponent;

  async onSendRequested(message: string): Promise<void> {
    const success = await this.sendMessageFn()(message);
    if (success) this.composer?.clear();
  }

  onBack(): void {
    this.backRequested.emit();
  }

  onRefresh(): void {
    this.refreshRequested.emit();
  }

  onMarkRead(): void {
    this.markReadRequested.emit();
  }

  onCloseChat(): void {
    this.closeRequested.emit();
  }

  displayName(): string {
    const chat = this.chat();
    if (!chat) return "Sin selección";
    return chat.customerDisplayName || chat.customerName || chat.profileName || chat.waId;
  }

  statusLabel(status: ChatStatus): string {
    if (status === "new") return "Nuevo";
    if (status === "pending") return "Pendiente";
    if (status === "waiting") return "En espera";
    return "Cerrado";
  }

  statusClass(status: ChatStatus): string {
    if (status === "new") return "status-new";
    if (status === "pending") return "status-pending";
    if (status === "waiting") return "status-waiting";
    return "status-closed";
  }

  hasUnread(): boolean {
    const chat = this.chat();
    if (!chat) return false;
    return chat.unreadCount > 0;
  }

  pendingNoteAmount(): string | null {
    const amountDue = this.chat()?.pendingSalesNoteData?.amountDue || null;
    if (!amountDue) return null;
    return amountDue;
  }
}
