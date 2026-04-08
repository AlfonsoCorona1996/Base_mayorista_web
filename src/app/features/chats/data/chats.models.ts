export type ChatStatus = "new" | "pending" | "waiting" | "closed";

export type ChatFilter = "all" | "pending" | "errors" | "window_open" | "closed";

export type ChatDirection = "inbound" | "outbound";

export type ChatMessageType = "text" | "template" | "image";

export type ChatWindowFilter = "open" | "closed";

export interface PendingSalesNoteData {
  salesNoteId: string | null;
  imageUrl: string | null;
  customerName: string | null;
  total: string | null;
  amountDue: string | null;
  createdAt: string | null;
}

export interface ChatMessageMedia {
  url: string | null;
  mimeType: string | null;
}

export interface ChatMessage {
  messageId: string;
  chatId: string;
  waId: string;
  direction: ChatDirection;
  type: ChatMessageType;
  text: string | null;
  caption: string | null;
  templateName: string | null;
  interactivePayload: Record<string, unknown> | null;
  media: ChatMessageMedia | null;
  status: string;
  metaStatusCode: string | null;
  metaStatusTitle: string | null;
  metaStatusDetails: string | null;
  timestamp: string;
  raw: Record<string, unknown> | null;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface ChatConversation {
  chatId: string;
  waId: string;
  customerName: string | null;
  profileName: string | null;
  customerDisplayName: string;
  searchText: string;
  lastMessageText: string;
  lastMessagePreview: string;
  lastMessageType: ChatMessageType;
  lastMessageDirection: ChatDirection;
  lastMessageAt: string | null;
  lastInboundAt: string | null;
  lastOutboundAt: string | null;
  lastUserReplyAt: string | null;
  windowExpiresAt: string | null;
  isWindowOpen: boolean;
  unreadCount: number;
  hasPendingReply: boolean;
  hasFailedMessages: boolean;
  lastFailedMessageAt: string | null;
  lastFailedReason: string | null;
  status: ChatStatus;
  pendingSalesNote: boolean;
  pendingSalesNoteData: PendingSalesNoteData | null;
  lastOrderId: string | null;
  lastSalesNoteId: string | null;
  tags: string[];
  isPending: boolean;
  isFailed: boolean;
  createdAt: string | null;
  updatedAt: string | null;
  recentMessages: ChatMessage[];
}

export interface ChatFilterCounts {
  all: number;
  pending: number;
  errors: number;
  window_open: number;
  closed: number;
}

export interface ListChatsQuery {
  status?: ChatStatus;
  search?: string;
  onlyPending?: boolean;
  onlyFailed?: boolean;
  window?: ChatWindowFilter;
  limit?: number;
  cursor?: string;
  includeClosed?: boolean;
}

export interface ListChatsResponse {
  items: ChatConversation[];
  nextCursor: string | null;
}

export interface ChatDetailQuery {
  limit?: number;
}

export interface ChatDetailResponse {
  chat: ChatConversation | null;
  recentMessages: ChatMessage[];
}

export interface ListMessagesQuery {
  limit?: number;
  cursor?: string;
}

export interface ListMessagesResponse {
  items: ChatMessage[];
  nextCursor: string | null;
}

export type SendMessagePayload =
  | {
      type: "text";
      text: string;
    }
  | {
      type: "image";
      imageUrl: string;
      caption?: string | null;
    };

export interface SendMessageResult {
  ok: boolean;
  messageId: string | null;
  chat: ChatConversation | null;
  code: string | null;
  message: string | null;
}

export const CHAT_FILTER_OPTIONS: Array<{ id: ChatFilter; label: string }> = [
  { id: "all", label: "Todos" },
  { id: "pending", label: "Pendientes" },
  { id: "errors", label: "Errores" },
  { id: "window_open", label: "Ventana abierta" },
  { id: "closed", label: "Cerrados" },
];
