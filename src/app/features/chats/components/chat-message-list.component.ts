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

  visibleMessages(): ChatMessage[] {
    const rows = this.messages();
    return rows.filter((message, index) => !this.isSupersededWindowClosedImageFailure(message, rows, index));
  }

  trackById(_: number, message: ChatMessage): string {
    return message.messageId;
  }

  isOutbound(message: ChatMessage): boolean {
    return message.direction === "outbound";
  }

  isFailed(message: ChatMessage): boolean {
    return message.status.toLowerCase() === "failed";
  }

  hasRenderableText(message: ChatMessage): boolean {
    const text = String(message.text || "").trim();
    if (!text) return false;
    if (message.type === "image" && text === String(message.caption || "").trim()) return false;
    return true;
  }

  hasRenderableCaption(message: ChatMessage): boolean {
    const caption = String(message.caption || "").trim();
    if (!caption) return false;
    if (caption === String(message.text || "").trim()) return false;
    return true;
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

  private isSupersededWindowClosedImageFailure(
    message: ChatMessage,
    rows: ChatMessage[],
    index: number,
  ): boolean {
    if (message.direction !== "outbound") return false;
    if (message.type !== "image") return false;
    if (!this.isFailed(message)) return false;

    const code = Number(message.metaStatusCode);
    const details = String(message.metaStatusDetails || "").toLowerCase();
    const isWindowClosed =
      code === 131047 ||
      details.includes("24 hours") ||
      details.includes("24h") ||
      details.includes("re-engagement");
    if (!isWindowClosed) return false;

    const sourceTime = new Date(message.timestamp).getTime();
    const maxLagMs = 5 * 60 * 1000;

    for (let i = index + 1; i < rows.length; i += 1) {
      const candidate = rows[i];
      if (candidate.direction !== "outbound") continue;
      if (candidate.type !== "template") continue;
      if (this.isFailed(candidate)) continue;
      const candidateTime = new Date(candidate.timestamp).getTime();
      if (!Number.isFinite(sourceTime) || !Number.isFinite(candidateTime)) return true;
      if (candidateTime >= sourceTime && candidateTime - sourceTime <= maxLagMs) return true;
    }

    return false;
  }
}
