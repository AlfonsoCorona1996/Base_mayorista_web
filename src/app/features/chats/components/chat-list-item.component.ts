import { CommonModule } from "@angular/common";
import { ChangeDetectionStrategy, Component, input, output } from "@angular/core";
import { ChatConversation, ChatStatus } from "../data/chats.models";

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: "app-chat-list-item",
  standalone: true,
  imports: [CommonModule],
  templateUrl: "./chat-list-item.component.html",
  styleUrl: "./chat-list-item.component.css",
})
export class ChatListItemComponent {
  chat = input.required<ChatConversation>();
  selected = input(false);
  openRequested = output<string>();

  onOpen(): void {
    this.openRequested.emit(this.chat().chatId);
  }

  displayName(): string {
    const chat = this.chat();
    return chat.customerDisplayName || chat.customerName || chat.profileName || chat.waId;
  }

  preview(): string {
    const preview = this.chat().lastMessagePreview.trim();
    if (preview.length > 0) return preview;
    return "Sin mensajes recientes";
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

  activityLabel(): string {
    const value = this.chat().lastMessageAt;
    if (!value) return "";

    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "";

    const now = new Date();
    const sameDay =
      date.getFullYear() === now.getFullYear() &&
      date.getMonth() === now.getMonth() &&
      date.getDate() === now.getDate();

    if (sameDay) {
      return new Intl.DateTimeFormat("es-MX", { hour: "2-digit", minute: "2-digit" }).format(date);
    }

    return new Intl.DateTimeFormat("es-MX", { day: "2-digit", month: "short" }).format(date);
  }

  hasPending(): boolean {
    const chat = this.chat();
    return chat.isPending || chat.hasPendingReply || chat.unreadCount > 0 || chat.status === "pending";
  }

  hasFailures(): boolean {
    const chat = this.chat();
    return chat.isFailed || chat.hasFailedMessages;
  }
}
