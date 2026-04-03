import { CommonModule } from "@angular/common";
import { ChangeDetectionStrategy, Component, input } from "@angular/core";
import { ChatMessage } from "../data/chats.models";

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: "app-chat-message-list",
  standalone: true,
  imports: [CommonModule],
  templateUrl: "./chat-message-list.component.html",
  styleUrl: "./chat-message-list.component.css",
})
export class ChatMessageListComponent {
  messages = input<ChatMessage[]>([]);
  loading = input(false);
  error = input<string | null>(null);
  readonly skeletonRows = [0, 1, 2, 3, 4];

  trackById(_: number, message: ChatMessage): string {
    return message.messageId;
  }

  isOutbound(message: ChatMessage): boolean {
    return message.direction === "outbound";
  }

  isFailed(message: ChatMessage): boolean {
    return message.status.toLowerCase() === "failed" || Boolean(message.metaStatusDetails);
  }

  statusLabel(message: ChatMessage): string {
    const status = message.status.toLowerCase();
    if (status === "failed") return "Falló";
    if (status === "read") return "Leído";
    if (status === "delivered") return "Entregado";
    if (status === "sent") return "Enviado";
    if (status === "received") return "Recibido";
    return status;
  }

  timestampLabel(message: ChatMessage): string {
    const date = new Date(message.timestamp);
    if (Number.isNaN(date.getTime())) return "";
    return new Intl.DateTimeFormat("es-MX", { hour: "2-digit", minute: "2-digit" }).format(date);
  }
}
