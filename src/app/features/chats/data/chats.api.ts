import { Injectable, inject } from "@angular/core";
import { lastValueFrom } from "rxjs";
import { UserAdminApiService } from "../../../services/user-admin-api.service";
import {
  ChatConversation,
  ChatDetailQuery,
  ChatDetailResponse,
  ChatDirection,
  ChatMessage,
  ChatMessageMedia,
  ChatMessageType,
  ChatStatus,
  ListChatsQuery,
  ListChatsResponse,
  ListMessagesQuery,
  ListMessagesResponse,
  PendingSalesNoteData,
  SendMessagePayload,
  SendMessageResult,
} from "./chats.models";

@Injectable({ providedIn: "root" })
export class ChatsApi {
  private readonly api = inject(UserAdminApiService);

  async listChats(query: ListChatsQuery = {}): Promise<ListChatsResponse> {
    const path = this.withQuery("/api/chats", {
      status: query.status,
      search: query.search,
      onlyPending: this.booleanParam(query.onlyPending),
      onlyFailed: this.booleanParam(query.onlyFailed),
      window: query.window,
      limit: this.numberParam(query.limit),
      cursor: query.cursor,
      includeClosed: query.includeClosed ? "true" : undefined,
    });

    const response = await lastValueFrom(this.api.get<unknown>(path));
    const rows = this.extractRows(response, "items");
    const items = rows
      .map((row, index) => this.normalizeConversation(row, `chat-${index + 1}`))
      .filter((row): row is ChatConversation => row !== null);

    return {
      items,
      nextCursor: this.readNullableString(this.asRecord(response), ["nextCursor", "next_cursor"]),
    };
  }

  async getChat(chatId: string, query: ChatDetailQuery = {}): Promise<ChatDetailResponse> {
    const path = this.withQuery(`/api/chats/${encodeURIComponent(chatId)}`, {
      limit: this.numberParam(query.limit),
    });
    const response = await lastValueFrom(this.api.get<unknown>(path));
    const root = this.asRecord(response);
    const chatRaw = this.extractObject(response, "chat");
    const recentRows = this.extractRows(response, "recentMessages");

    const recentMessages = recentRows
      .map((row, index) => this.normalizeMessage(row, chatId, index))
      .filter((row): row is ChatMessage => row !== null)
      .sort((a, b) => this.toTimestamp(a.timestamp) - this.toTimestamp(b.timestamp));

    const normalizedChat = this.normalizeConversation(chatRaw, chatId);
    const chat = normalizedChat
      ? {
          ...normalizedChat,
          recentMessages,
        }
      : null;

    if (!chat && root) {
      return {
        chat: null,
        recentMessages,
      };
    }

    return {
      chat,
      recentMessages,
    };
  }

  async getChatMessages(chatId: string, query: ListMessagesQuery = {}): Promise<ListMessagesResponse> {
    const path = this.withQuery(`/api/chats/${encodeURIComponent(chatId)}/messages`, {
      limit: this.numberParam(query.limit),
      cursor: query.cursor,
    });
    const response = await lastValueFrom(this.api.get<unknown>(path));
    const rows = this.extractRows(response, "items");
    const items = rows
      .map((row, index) => this.normalizeMessage(row, chatId, index))
      .filter((row): row is ChatMessage => row !== null)
      .sort((a, b) => this.toTimestamp(a.timestamp) - this.toTimestamp(b.timestamp));

    return {
      items,
      nextCursor: this.readNullableString(this.asRecord(response), ["nextCursor", "next_cursor"]),
    };
  }

  async sendMessage(chatId: string, payload: SendMessagePayload): Promise<SendMessageResult> {
    const body =
      payload.type === "text"
        ? {
            type: "text",
            text: payload.text,
          }
        : {
            type: "image",
            imageUrl: payload.imageUrl,
            caption: payload.caption ?? null,
          };

    const response = await lastValueFrom(
      this.api.post<unknown>(`/api/chats/${encodeURIComponent(chatId)}/send`, body),
    );
    const root = this.asRecord(response);

    const result: SendMessageResult = {
      ok: this.readBoolean(root, ["ok"], true),
      messageId: this.readNullableString(root, ["messageId", "message_id"]),
      chat: this.normalizeConversation(root?.["chat"], chatId),
      code: this.readNullableString(root, ["code"]),
      message: this.readNullableString(root, ["message"]),
    };

    if (!result.ok) {
      const error = new Error(result.message || "No se pudo enviar el mensaje.") as Error & {
        code?: string;
      };
      error.code = result.code || undefined;
      throw error;
    }

    return result;
  }

  async markRead(chatId: string): Promise<ChatConversation | null> {
    const response = await lastValueFrom(
      this.api.post<unknown>(`/api/chats/${encodeURIComponent(chatId)}/mark-read`, {}),
    );
    const root = this.asRecord(response);
    return this.normalizeConversation(root?.["chat"], chatId);
  }

  async closeChat(chatId: string, reason?: string | null): Promise<ChatConversation | null> {
    const body = reason ? { reason } : {};
    const response = await lastValueFrom(
      this.api.post<unknown>(`/api/chats/${encodeURIComponent(chatId)}/close`, body),
    );
    const root = this.asRecord(response);
    return this.normalizeConversation(root?.["chat"], chatId);
  }

  private normalizeConversation(raw: unknown, fallbackChatId: string): ChatConversation | null {
    const record = this.asRecord(raw);
    if (!record) return null;

    const chatId = this.readString(record, ["chatId", "chat_id", "id"], fallbackChatId) || fallbackChatId;
    const waId = this.readString(record, ["waId", "wa_id"], chatId) || chatId;
    const customerDisplayName =
      this.readString(record, ["customerDisplayName", "customer_display_name"], "") ||
      this.readString(record, ["customerName", "customer_name"], "") ||
      this.readString(record, ["profileName", "profile_name"], "") ||
      waId;
    const lastMessageText = this.readString(record, ["lastMessageText", "last_message_text"], "");
    const lastMessagePreview =
      this.readString(record, ["lastMessagePreview", "last_message_preview"], "") || lastMessageText;
    const isPending = this.readBoolean(record, ["isPending", "is_pending"], false);
    const hasPendingReply = this.readBoolean(record, ["hasPendingReply", "has_pending_reply"], isPending);
    const unreadCount = Math.max(0, this.readNumber(record, ["unreadCount", "unread_count"], 0));
    const hasFailedMessages = this.readBoolean(
      record,
      ["hasFailedMessages", "has_failed_messages"],
      this.readBoolean(record, ["isFailed", "is_failed"], false),
    );
    const isFailed = this.readBoolean(record, ["isFailed", "is_failed"], hasFailedMessages);
    const isWindowOpen = this.resolveWindowState(record);
    const status = this.normalizeStatus(record, { isPending, hasPendingReply, unreadCount });
    const pendingSalesNote = this.readBoolean(record, ["pendingSalesNote", "pending_sales_note"], false);
    const recentMessages = this.readArray(record, ["recentMessages", "recent_messages"])
      .map((entry, index) => this.normalizeMessage(entry, chatId, index))
      .filter((entry): entry is ChatMessage => entry !== null);

    return {
      chatId,
      waId,
      customerName: this.readNullableString(record, ["customerName", "customer_name"]),
      profileName: this.readNullableString(record, ["profileName", "profile_name"]),
      customerDisplayName,
      searchText: this.readString(record, ["searchText", "search_text"], ""),
      lastMessageText,
      lastMessagePreview,
      lastMessageType: this.normalizeMessageType(
        this.readString(record, ["lastMessageType", "last_message_type"], ""),
        null,
      ),
      lastMessageDirection: this.normalizeDirection(
        this.readString(record, ["lastMessageDirection", "last_message_direction"], ""),
      ),
      lastMessageAt: this.toIso(this.readUnknown(record, ["lastMessageAt", "last_message_at"])),
      lastInboundAt: this.toIso(this.readUnknown(record, ["lastInboundAt", "last_inbound_at"])),
      lastOutboundAt: this.toIso(this.readUnknown(record, ["lastOutboundAt", "last_outbound_at"])),
      lastUserReplyAt: this.toIso(this.readUnknown(record, ["lastUserReplyAt", "last_user_reply_at"])),
      windowExpiresAt: this.toIso(this.readUnknown(record, ["windowExpiresAt", "window_expires_at"])),
      isWindowOpen,
      unreadCount,
      hasPendingReply,
      hasFailedMessages,
      lastFailedMessageAt: this.toIso(this.readUnknown(record, ["lastFailedMessageAt", "last_failed_message_at"])),
      lastFailedReason: this.readNullableString(record, ["lastFailedReason", "last_failed_reason"]),
      status,
      pendingSalesNote,
      pendingSalesNoteData: this.normalizePendingSalesNoteData(record["pendingSalesNoteData"] ?? record["pending_sales_note_data"]),
      lastOrderId: this.readNullableString(record, ["lastOrderId", "last_order_id"]),
      lastSalesNoteId: this.readNullableString(record, ["lastSalesNoteId", "last_sales_note_id"]),
      tags: this.readArray(record, ["tags"])
        .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
        .filter((entry) => entry.length > 0),
      isPending,
      isFailed,
      createdAt: this.toIso(this.readUnknown(record, ["createdAt", "created_at"])),
      updatedAt: this.toIso(this.readUnknown(record, ["updatedAt", "updated_at"])),
      recentMessages,
    };
  }

  private normalizePendingSalesNoteData(raw: unknown): PendingSalesNoteData | null {
    const record = this.asRecord(raw);
    if (!record) return null;

    return {
      salesNoteId: this.readNullableString(record, ["salesNoteId", "sales_note_id"]),
      imageUrl: this.readNullableString(record, ["imageUrl", "image_url"]),
      customerName: this.readNullableString(record, ["customerName", "customer_name"]),
      total: this.readNullableString(record, ["total"]),
      amountDue: this.readNullableString(record, ["amountDue", "amount_due"]),
      createdAt: this.toIso(this.readUnknown(record, ["createdAt", "created_at"])),
    };
  }

  private normalizeMessage(raw: unknown, fallbackChatId: string, index: number): ChatMessage | null {
    const record = this.asRecord(raw);
    if (!record) return null;

    const chatId = this.readString(record, ["chatId", "chat_id"], fallbackChatId) || fallbackChatId;
    const waId = this.readString(record, ["waId", "wa_id"], chatId) || chatId;
    const media = this.normalizeMedia(record["media"]);
    const type = this.normalizeMessageType(this.readString(record, ["type"], ""), media);
    const createdAtIso = this.toIso(this.readUnknown(record, ["createdAt", "created_at"]));
    const timestampIso =
      this.toIso(this.readUnknown(record, ["timestamp"])) ||
      createdAtIso ||
      new Date().toISOString();

    return {
      messageId: this.readString(record, ["messageId", "message_id", "id"], `${chatId}-m-${index + 1}`),
      chatId,
      waId,
      direction: this.normalizeDirection(this.readString(record, ["direction"], "")),
      type,
      text: this.readNullableString(record, ["text"]),
      caption: this.readNullableString(record, ["caption"]),
      templateName: this.readNullableString(record, ["templateName", "template_name"]),
      interactivePayload: this.asRecord(record["interactivePayload"] ?? record["interactive_payload"]),
      media,
      status: this.readString(record, ["status"], "sent"),
      metaStatusCode: this.readNullableString(record, ["metaStatusCode", "meta_status_code"]),
      metaStatusTitle: this.readNullableString(record, ["metaStatusTitle", "meta_status_title"]),
      metaStatusDetails: this.readNullableString(record, ["metaStatusDetails", "meta_status_details"]),
      timestamp: timestampIso,
      raw: this.asRecord(record["raw"]),
      createdAt: createdAtIso,
      updatedAt: this.toIso(this.readUnknown(record, ["updatedAt", "updated_at"])),
    };
  }

  private normalizeMedia(raw: unknown): ChatMessageMedia | null {
    const record = this.asRecord(raw);
    if (!record) return null;
    const url = this.readNullableString(record, ["url"]);
    const mimeType = this.readNullableString(record, ["mimeType", "mime_type"]);
    if (!url && !mimeType) return null;
    return { url, mimeType };
  }

  private normalizeStatus(
    record: Record<string, unknown>,
    context: { isPending: boolean; hasPendingReply: boolean; unreadCount: number },
  ): ChatStatus {
    const raw = this.readString(record, ["status"], "").trim().toLowerCase();
    if (raw === "new" || raw === "pending" || raw === "waiting" || raw === "closed") return raw;

    const isClosed = this.readBoolean(record, ["isClosed", "closed", "is_closed"], false);
    if (isClosed) return "closed";
    if (context.isPending || context.hasPendingReply || context.unreadCount > 0) return "pending";

    const lastOutboundAt = this.toIso(this.readUnknown(record, ["lastOutboundAt", "last_outbound_at"]));
    const lastInboundAt = this.toIso(this.readUnknown(record, ["lastInboundAt", "last_inbound_at"]));
    if (lastOutboundAt && (!lastInboundAt || this.toTimestamp(lastOutboundAt) >= this.toTimestamp(lastInboundAt))) {
      return "waiting";
    }
    return "new";
  }

  private normalizeDirection(raw: string): ChatDirection {
    const value = raw.trim().toLowerCase();
    if (value === "outbound" || value === "sent") return "outbound";
    return "inbound";
  }

  private normalizeMessageType(raw: string, media: ChatMessageMedia | null): ChatMessageType {
    const value = raw.trim().toLowerCase();
    if (value === "template") return "template";
    if (value === "image" || media?.url) return "image";
    return "text";
  }

  private resolveWindowState(record: Record<string, unknown>): boolean {
    const explicit = this.readBoolean(
      record,
      ["isWindowOpen", "is_window_open", "windowOpen", "window_open"],
      true,
    );
    const windowExpiresAt = this.toIso(this.readUnknown(record, ["windowExpiresAt", "window_expires_at"]));
    if (!windowExpiresAt) return explicit;
    return this.toTimestamp(windowExpiresAt) > Date.now();
  }

  private withQuery(path: string, query: Record<string, string | null | undefined>): string {
    const params = new URLSearchParams();

    for (const [key, value] of Object.entries(query)) {
      if (!value) continue;
      params.set(key, value);
    }

    const serialized = params.toString();
    return serialized ? `${path}?${serialized}` : path;
  }

  private booleanParam(value: boolean | undefined): string | undefined {
    if (typeof value !== "boolean") return undefined;
    return value ? "true" : "false";
  }

  private numberParam(value: number | undefined): string | undefined {
    if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
    return String(Math.trunc(value));
  }

  private extractRows(payload: unknown, key: string): unknown[] {
    if (Array.isArray(payload)) return payload;
    const record = this.asRecord(payload);
    if (!record) return [];
    if (Array.isArray(record[key])) return record[key];
    if (Array.isArray(record["items"])) return record["items"];
    const data = this.asRecord(record["data"]);
    if (data && Array.isArray(data[key])) return data[key];
    if (data && Array.isArray(data["items"])) return data["items"];
    return [];
  }

  private extractObject(payload: unknown, key: string): Record<string, unknown> | null {
    const record = this.asRecord(payload);
    if (!record) return null;
    const direct = this.asRecord(record[key]);
    if (direct) return direct;
    const data = this.asRecord(record["data"]);
    if (!data) return null;
    return this.asRecord(data[key]);
  }

  private asRecord(value: unknown): Record<string, unknown> | null {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    return value as Record<string, unknown>;
  }

  private readUnknown(record: Record<string, unknown> | null, keys: string[]): unknown {
    if (!record) return undefined;
    for (const key of keys) {
      if (!(key in record)) continue;
      const value = record[key];
      if (value !== undefined && value !== null) return value;
    }
    return undefined;
  }

  private readString(record: Record<string, unknown> | null, keys: string[], fallback: string): string {
    const value = this.readUnknown(record, keys);
    if (typeof value !== "string") return fallback;
    const normalized = value.trim();
    return normalized.length > 0 ? normalized : fallback;
  }

  private readNullableString(record: Record<string, unknown> | null, keys: string[]): string | null {
    const value = this.readUnknown(record, keys);
    if (typeof value !== "string") return null;
    const normalized = value.trim();
    return normalized.length > 0 ? normalized : null;
  }

  private readBoolean(record: Record<string, unknown> | null, keys: string[], fallback: boolean): boolean {
    const value = this.readUnknown(record, keys);
    if (typeof value === "boolean") return value;
    if (typeof value === "number") return value !== 0;
    if (typeof value === "string") {
      const normalized = value.trim().toLowerCase();
      if (normalized === "true" || normalized === "1" || normalized === "yes") return true;
      if (normalized === "false" || normalized === "0" || normalized === "no") return false;
    }
    return fallback;
  }

  private readNumber(record: Record<string, unknown> | null, keys: string[], fallback: number): number {
    const value = this.readUnknown(record, keys);
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string") {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return parsed;
    }
    return fallback;
  }

  private readArray(record: Record<string, unknown> | null, keys: string[]): unknown[] {
    const value = this.readUnknown(record, keys);
    if (Array.isArray(value)) return value;
    return [];
  }

  private toIso(value: unknown): string | null {
    if (!value) return null;
    if (value instanceof Date) {
      if (Number.isNaN(value.getTime())) return null;
      return value.toISOString();
    }
    if (typeof value === "string") {
      const date = new Date(value);
      if (Number.isNaN(date.getTime())) return null;
      return date.toISOString();
    }
    if (typeof value === "number") {
      const date = new Date(value);
      if (Number.isNaN(date.getTime())) return null;
      return date.toISOString();
    }
    if (typeof value === "object" && value !== null) {
      const withToDate = value as { toDate?: () => Date };
      if (typeof withToDate.toDate === "function") {
        const date = withToDate.toDate();
        if (!Number.isNaN(date.getTime())) return date.toISOString();
      }
      const seconds = (value as { seconds?: unknown }).seconds;
      if (typeof seconds === "number" && Number.isFinite(seconds)) {
        const date = new Date(seconds * 1000);
        if (!Number.isNaN(date.getTime())) return date.toISOString();
      }
    }
    return null;
  }

  private toTimestamp(value: string | null): number {
    if (!value) return 0;
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return 0;
    return date.getTime();
  }
}
