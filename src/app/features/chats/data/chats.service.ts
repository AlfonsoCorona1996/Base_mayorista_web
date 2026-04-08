import { Injectable, computed, inject, signal } from "@angular/core";
import { ChatsApi } from "./chats.api";
import { ChatConversation, ChatFilter, ChatFilterCounts, ChatMessage, ListChatsQuery } from "./chats.models";

const WINDOW_CLOSED_HINT = "La ventana de 24 horas esta cerrada. Debes usar una plantilla.";

@Injectable({ providedIn: "root" })
export class ChatsService {
  private readonly api = inject(ChatsApi);
  private readonly chatRows = signal<ChatConversation[]>([]);
  private listPollingHandle: number | null = null;
  private openChatPollingHandle: number | null = null;
  private readonly listPageSize = 20;
  private readonly messagesPageSize = 30;

  readonly chats = computed(() => this.chatRows());
  readonly activeFilter = signal<ChatFilter>("pending");
  readonly searchTerm = signal("");
  readonly selectedChatId = signal<string | null>(null);
  readonly selectedChat = signal<ChatConversation | null>(null);
  readonly selectedMessages = signal<ChatMessage[]>([]);
  readonly listNextCursor = signal<string | null>(null);
  readonly messagesNextCursor = signal<string | null>(null);

  readonly listLoading = signal(false);
  readonly detailLoading = signal(false);
  readonly messagesLoading = signal(false);
  readonly sendLoading = signal(false);

  readonly listError = signal<string | null>(null);
  readonly detailError = signal<string | null>(null);
  readonly messagesError = signal<string | null>(null);
  readonly sendError = signal<string | null>(null);

  readonly windowClosedHint = WINDOW_CLOSED_HINT;

  readonly hasFiltersApplied = computed(() => this.activeFilter() !== "all" || this.searchTerm().trim().length > 0);
  readonly canReplyInSelectedChat = computed(() => Boolean(this.selectedChat()?.isWindowOpen));

  readonly filterCounts = computed<ChatFilterCounts>(() => {
    const rows = this.chatRows();
    return {
      all: rows.length,
      pending: rows.filter((chat) => this.isPending(chat)).length,
      errors: rows.filter((chat) => this.isFailed(chat)).length,
      window_open: rows.filter((chat) => chat.isWindowOpen).length,
      closed: rows.filter((chat) => chat.status === "closed").length,
    };
  });

  readonly filteredChats = computed<ChatConversation[]>(() => {
    const filter = this.activeFilter();
    const query = this.searchTerm().trim().toLowerCase();

    const filtered = this.chatRows().filter((chat) => {
      if (filter === "pending" && !this.isPending(chat)) return false;
      if (filter === "errors" && !this.isFailed(chat)) return false;
      if (filter === "window_open" && !chat.isWindowOpen) return false;
      if (filter === "closed" && chat.status !== "closed") return false;

      if (!query) return true;
      const haystack = `${chat.customerDisplayName} ${chat.waId} ${chat.lastMessagePreview}`.toLowerCase();
      return haystack.includes(query);
    });

    return this.sortChats(filtered, { boostPending: filter === "all" });
  });

  setFilter(filter: ChatFilter): void {
    this.activeFilter.set(filter);
  }

  setSearchTerm(term: string): void {
    this.searchTerm.set(term || "");
  }

  clearSelection(): void {
    this.selectedChatId.set(null);
    this.selectedChat.set(null);
    this.selectedMessages.set([]);
    this.messagesNextCursor.set(null);
    this.detailError.set(null);
    this.messagesError.set(null);
    this.sendError.set(null);
  }

  async loadChats(options: { silent?: boolean; append?: boolean; cursor?: string | null } = {}): Promise<void> {
    const silent = Boolean(options.silent);
    const append = Boolean(options.append);
    const cursor = options.cursor ?? (append ? this.listNextCursor() : null);

    if (append && !cursor) return;

    if (!silent) this.listLoading.set(true);
    this.listError.set(null);

    try {
      const query = this.buildListQuery(cursor || undefined);
      const response = await this.api.listChats(query);
      this.listNextCursor.set(response.nextCursor);

      if (append) {
        this.chatRows.update((current) => this.sortChats(this.mergeChats(current, response.items), { boostPending: true }));
      } else {
        this.chatRows.set(this.sortChats(response.items, { boostPending: true }));
      }

      this.syncSelectedWithList();
    } catch (error: unknown) {
      this.listError.set(this.errorMessage(error, "No se pudo cargar la bandeja de chats."));
    } finally {
      if (!silent) this.listLoading.set(false);
    }
  }

  async loadMoreChats(): Promise<void> {
    if (!this.listNextCursor()) return;
    await this.loadChats({ append: true, silent: true });
  }

  async selectChat(chatId: string, options: { force?: boolean; silent?: boolean } = {}): Promise<void> {
    const normalizedId = chatId.trim();
    if (!normalizedId) {
      this.clearSelection();
      return;
    }

    const changed = this.selectedChatId() !== normalizedId;
    this.selectedChatId.set(normalizedId);

    if (!changed && !options.force && this.selectedChat() && this.selectedMessages().length > 0) return;

    await Promise.all([
      this.loadSelectedChatDetail(normalizedId, options),
      this.loadSelectedMessages(normalizedId, options),
    ]);

    const active = this.selectedChat();
    if (this.selectedChatId() === normalizedId && active && active.unreadCount > 0) {
      this.markSelectedAsRead().catch(() => null);
    }
  }

  async refreshSelected(options: { silent?: boolean } = {}): Promise<void> {
    const chatId = this.selectedChatId();
    if (!chatId) return;
    await Promise.all([
      this.loadSelectedChatDetail(chatId, options),
      this.loadSelectedMessages(chatId, { ...options, append: false, cursor: null }),
    ]);
  }

  async refreshAll(): Promise<void> {
    const selectedId = this.selectedChatId();
    if (!selectedId) {
      await this.loadChats();
      return;
    }
    await Promise.all([this.loadChats(), this.refreshSelected({ silent: true })]);
  }

  async markSelectedAsRead(): Promise<void> {
    const chatId = this.selectedChatId();
    if (!chatId) return;

    this.detailError.set(null);
    try {
      const updated = await this.api.markRead(chatId);
      if (updated) {
        this.upsertChat(updated);
      } else {
        this.patchChat(chatId, { unreadCount: 0 });
      }
      await this.loadChats({ silent: true });
    } catch (error: unknown) {
      this.detailError.set(this.errorMessage(error, "No se pudo marcar el chat como leido."));
    }
  }

  async closeSelectedChat(): Promise<void> {
    const chatId = this.selectedChatId();
    if (!chatId) return;

    this.detailError.set(null);
    try {
      const updated = await this.api.closeChat(chatId, "Atendido");
      if (updated) {
        this.upsertChat(updated);
      } else {
        this.patchChat(chatId, {
          status: "closed",
          unreadCount: 0,
          hasPendingReply: false,
          isPending: false,
        });
      }
      await this.loadChats({ silent: true });
    } catch (error: unknown) {
      this.detailError.set(this.errorMessage(error, "No se pudo cerrar el chat."));
    }
  }

  async sendMessage(messageText: string): Promise<boolean> {
    const chat = this.selectedChat();
    const chatId = this.selectedChatId();
    if (!chat || !chatId) return false;

    const text = messageText.trim();
    if (!text) return false;

    this.sendError.set(null);
    if (!chat.isWindowOpen) {
      this.sendError.set(WINDOW_CLOSED_HINT);
      return false;
    }

    const optimistic = this.buildOptimisticMessage(chat, text);
    this.selectedMessages.update((rows) => [...rows, optimistic]);
    this.sendLoading.set(true);

    try {
      const result = await this.api.sendMessage(chatId, {
        type: "text",
        text,
      });

      if (this.selectedChatId() === chatId) {
        this.selectedMessages.update((rows) =>
          rows.map((row) =>
            row.messageId === optimistic.messageId
              ? { ...row, messageId: result.messageId || row.messageId, status: "sent" }
              : row,
          ),
        );
      }

      if (result.chat) {
        this.upsertChat(result.chat);
      } else {
        this.patchChat(chatId, {
          lastMessageText: text,
          lastMessagePreview: text,
          lastMessageType: "text",
          lastMessageDirection: "outbound",
          lastMessageAt: optimistic.timestamp,
          status: chat.status === "closed" ? "closed" : "waiting",
        });
      }

      await Promise.all([
        this.loadChats({ silent: true }),
        this.loadSelectedChatDetail(chatId, { silent: true }),
        this.loadSelectedMessages(chatId, { silent: true, append: false, cursor: null }),
      ]);
      return true;
    } catch (error: unknown) {
      const status = this.readHttpStatus(error);
      const fallback =
        status === 409
          ? WINDOW_CLOSED_HINT
          : "No se pudo enviar el mensaje.";
      const message = this.errorMessage(error, fallback);
      this.sendError.set(message);

      this.selectedMessages.update((rows) =>
        rows.map((row) =>
          row.messageId === optimistic.messageId
            ? { ...row, status: "failed", metaStatusDetails: message }
            : row,
        ),
      );

      if (status === 409 || this.looksLikeWindowClosed(message)) {
        this.patchChat(chatId, { isWindowOpen: false });
      }
      return false;
    } finally {
      this.sendLoading.set(false);
    }
  }

  async loadOlderMessages(): Promise<void> {
    if (!this.messagesNextCursor()) return;
    const chatId = this.selectedChatId();
    if (!chatId) return;
    await this.loadSelectedMessages(chatId, {
      silent: true,
      append: true,
      cursor: this.messagesNextCursor(),
    });
  }

  startPolling(listIntervalMs = 12_000, openChatIntervalMs = 6_000): void {
    if (typeof window === "undefined") return;
    if (this.listPollingHandle || this.openChatPollingHandle) return;

    const safeListInterval = Math.max(10_000, Math.trunc(listIntervalMs));
    const safeOpenInterval = Math.max(5_000, Math.trunc(openChatIntervalMs));

    this.listPollingHandle = window.setInterval(() => {
      this.loadChats({ silent: true }).catch(() => null);
    }, safeListInterval);

    this.openChatPollingHandle = window.setInterval(() => {
      const selectedId = this.selectedChatId();
      if (!selectedId) return;
      this.loadSelectedChatDetail(selectedId, { silent: true }).catch(() => null);
      this.loadSelectedMessages(selectedId, { silent: true, append: false, cursor: null }).catch(() => null);
    }, safeOpenInterval);
  }

  stopPolling(): void {
    if (this.listPollingHandle) {
      clearInterval(this.listPollingHandle);
      this.listPollingHandle = null;
    }
    if (this.openChatPollingHandle) {
      clearInterval(this.openChatPollingHandle);
      this.openChatPollingHandle = null;
    }
  }

  private async loadSelectedChatDetail(chatId: string, options: { silent?: boolean } = {}): Promise<void> {
    const silent = Boolean(options.silent);
    if (!silent) this.detailLoading.set(true);
    this.detailError.set(null);

    try {
      const detail = await this.api.getChat(chatId, { limit: this.messagesPageSize });
      if (this.selectedChatId() !== chatId) return;
      if (!detail.chat) return;

      this.selectedChat.set(detail.chat);
      this.upsertChat(detail.chat);

      if (this.selectedMessages().length === 0 && detail.recentMessages.length > 0) {
        this.selectedMessages.set(detail.recentMessages);
      }
    } catch (error: unknown) {
      if (this.selectedChatId() !== chatId) return;
      this.detailError.set(this.errorMessage(error, "No se pudo cargar el detalle del chat."));
    } finally {
      if (!silent && this.selectedChatId() === chatId) this.detailLoading.set(false);
    }
  }

  private async loadSelectedMessages(
    chatId: string,
    options: { silent?: boolean; append?: boolean; cursor?: string | null } = {},
  ): Promise<void> {
    const silent = Boolean(options.silent);
    const append = Boolean(options.append);
    const cursor = options.cursor ?? (append ? this.messagesNextCursor() : null);
    if (append && !cursor) return;

    if (!silent) this.messagesLoading.set(true);
    this.messagesError.set(null);

    try {
      const response = await this.api.getChatMessages(chatId, {
        limit: this.messagesPageSize,
        cursor: cursor || undefined,
      });
      if (this.selectedChatId() !== chatId) return;

      this.messagesNextCursor.set(response.nextCursor);

      if (append) {
        this.selectedMessages.update((current) => this.mergeMessages(current, response.items));
      } else if (response.items.length > 0) {
        this.selectedMessages.set(response.items);
      } else {
        this.selectedMessages.set(this.selectedChat()?.recentMessages || []);
      }
    } catch (error: unknown) {
      if (this.selectedChatId() !== chatId) return;
      this.messagesError.set(this.errorMessage(error, "No se pudieron cargar los mensajes."));
    } finally {
      if (!silent && this.selectedChatId() === chatId) this.messagesLoading.set(false);
    }
  }

  private buildListQuery(cursor?: string): ListChatsQuery {
    const search = this.searchTerm().trim();
    const filter = this.activeFilter();
    const query: ListChatsQuery = {
      limit: this.listPageSize,
      cursor,
    };

    if (search.length > 0) query.search = search;

    if (filter === "pending") {
      query.onlyPending = true;
      return query;
    }
    if (filter === "errors") {
      query.onlyFailed = true;
      query.includeClosed = true;
      return query;
    }
    if (filter === "window_open") {
      query.window = "open";
      return query;
    }
    if (filter === "closed") {
      query.status = "closed";
      query.includeClosed = true;
      return query;
    }

    return query;
  }

  private buildOptimisticMessage(chat: ChatConversation, text: string): ChatMessage {
    const now = new Date().toISOString();
    return {
      messageId: `tmp-${Date.now()}`,
      chatId: chat.chatId,
      waId: chat.waId,
      direction: "outbound",
      type: "text",
      text,
      caption: null,
      templateName: null,
      interactivePayload: null,
      media: null,
      status: "sent",
      metaStatusCode: null,
      metaStatusTitle: null,
      metaStatusDetails: null,
      timestamp: now,
      raw: null,
      createdAt: now,
      updatedAt: now,
    };
  }

  private isPending(chat: ChatConversation): boolean {
    return chat.status === "pending" || chat.isPending || chat.hasPendingReply || chat.unreadCount > 0;
  }

  private isFailed(chat: ChatConversation): boolean {
    return chat.isFailed || chat.hasFailedMessages;
  }

  private sortChats(rows: ChatConversation[], options: { boostPending: boolean }): ChatConversation[] {
    return [...rows].sort((a, b) => {
      if (options.boostPending) {
        const aPending = this.isPending(a) ? 0 : 1;
        const bPending = this.isPending(b) ? 0 : 1;
        if (aPending !== bPending) return aPending - bPending;
      }

      if (this.isFailed(a) !== this.isFailed(b)) return this.isFailed(a) ? -1 : 1;

      const dateDiff = this.toTimestamp(b.lastMessageAt) - this.toTimestamp(a.lastMessageAt);
      if (dateDiff !== 0) return dateDiff;

      return a.customerDisplayName.localeCompare(b.customerDisplayName, "es");
    });
  }

  private patchChat(chatId: string, patch: Partial<ChatConversation>): void {
    this.chatRows.update((rows) =>
      rows.map((chat) => (chat.chatId === chatId ? { ...chat, ...patch } : chat)),
    );

    this.selectedChat.update((chat) => {
      if (!chat || chat.chatId !== chatId) return chat;
      return { ...chat, ...patch };
    });
  }

  private upsertChat(chat: ChatConversation): void {
    this.chatRows.update((rows) => {
      const index = rows.findIndex((entry) => entry.chatId === chat.chatId);
      if (index < 0) return this.sortChats([...rows, chat], { boostPending: true });
      const next = [...rows];
      next[index] = { ...next[index], ...chat };
      return this.sortChats(next, { boostPending: true });
    });
  }

  private mergeChats(current: ChatConversation[], incoming: ChatConversation[]): ChatConversation[] {
    const map = new Map<string, ChatConversation>();
    for (const chat of current) map.set(chat.chatId, chat);
    for (const chat of incoming) {
      const existing = map.get(chat.chatId);
      map.set(chat.chatId, existing ? { ...existing, ...chat } : chat);
    }
    return [...map.values()];
  }

  private mergeMessages(current: ChatMessage[], incoming: ChatMessage[]): ChatMessage[] {
    const map = new Map<string, ChatMessage>();
    for (const message of current) map.set(message.messageId, message);
    for (const message of incoming) {
      const existing = map.get(message.messageId);
      map.set(message.messageId, existing ? { ...existing, ...message } : message);
    }
    return [...map.values()].sort((a, b) => this.toTimestamp(a.timestamp) - this.toTimestamp(b.timestamp));
  }

  private syncSelectedWithList(): void {
    const selectedId = this.selectedChatId();
    if (!selectedId) return;
    const summary = this.chatRows().find((entry) => entry.chatId === selectedId);
    if (!summary) return;
    this.selectedChat.update((chat) => {
      if (!chat) return chat;
      return { ...chat, ...summary };
    });
  }

  private looksLikeWindowClosed(message: string): boolean {
    const value = message.toLowerCase();
    return value.includes("window_closed") || (value.includes("ventana") && value.includes("24"));
  }

  private readHttpStatus(error: unknown): number | null {
    if (typeof error !== "object" || error === null) return null;
    const maybeStatus = (error as { status?: unknown }).status;
    if (typeof maybeStatus === "number" && Number.isFinite(maybeStatus)) return maybeStatus;
    return null;
  }

  private toTimestamp(value: string | null): number {
    if (!value) return 0;
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return 0;
    return date.getTime();
  }

  private errorMessage(error: unknown, fallback: string): string {
    const status = this.readHttpStatus(error);

    if (error instanceof Error && error.message.trim()) {
      const message = error.message.trim();
      if (message.toLowerCase().includes("http failure response")) {
        if (status === 500) return "Error interno del servidor. Intenta de nuevo.";
        if (status === 401) return "Sesion expirada. Vuelve a iniciar sesion.";
        if (status === 404) return "No se encontro el chat solicitado.";
        return fallback;
      }
      return message;
    }

    if (typeof error === "object" && error !== null) {
      const value = error as Record<string, unknown>;
      if (typeof value["message"] === "string" && value["message"].trim()) {
        return value["message"].trim();
      }
      if (typeof value["error"] === "string" && value["error"].trim()) {
        return value["error"].trim();
      }
      const nested = value["error"];
      if (typeof nested === "object" && nested !== null) {
        const nestedMessage = (nested as Record<string, unknown>)["message"];
        if (typeof nestedMessage === "string" && nestedMessage.trim()) {
          return nestedMessage.trim();
        }
      }
    }

    return fallback;
  }
}
