import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  HostListener,
  computed,
  inject,
  signal,
} from "@angular/core";
import { takeUntilDestroyed } from "@angular/core/rxjs-interop";
import { ActivatedRoute, Router } from "@angular/router";
import { ChatDetailComponent } from "./components/chat-detail.component";
import { ChatListComponent } from "./components/chat-list.component";
import { WaTemplatePolicyPanelComponent } from "./components/wa-template-policy-panel.component";
import { ChatFilter } from "./data/chats.models";
import { ChatsService } from "./data/chats.service";

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  standalone: true,
  selector: "app-chats-page",
  imports: [ChatListComponent, ChatDetailComponent, WaTemplatePolicyPanelComponent],
  templateUrl: "./chats-page.component.html",
  styleUrl: "./chats-page.component.css",
})
export default class ChatsPageComponent {
  readonly chats = inject(ChatsService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly destroyRef = inject(DestroyRef);
  private searchDebounceHandle: number | null = null;

  readonly routeChatId = signal<string | null>(null);
  readonly isDesktop = signal(this.matchesDesktop());
  readonly showListPane = computed(() => this.isDesktop() || !this.routeChatId());
  readonly showDetailPane = computed(() => this.isDesktop() || Boolean(this.routeChatId()));
  readonly isMobileDetail = computed(() => !this.isDesktop() && Boolean(this.routeChatId()));
  readonly sendMessageFn = (message: string) => this.chats.sendMessage(message);

  constructor() {
    this.route.paramMap.pipe(takeUntilDestroyed(this.destroyRef)).subscribe((params) => {
      const chatId = params.get("chatId");
      this.routeChatId.set(chatId);
      if (!chatId) {
        this.chats.clearSelection();
        return;
      }
      this.chats.selectChat(chatId).catch(() => null);
    });
  }

  async ngOnInit(): Promise<void> {
    await this.chats.loadChats();
    this.chats.startPolling();
  }

  ngOnDestroy(): void {
    this.chats.stopPolling();
    if (this.searchDebounceHandle) {
      clearTimeout(this.searchDebounceHandle);
      this.searchDebounceHandle = null;
    }
  }

  @HostListener("window:resize")
  onResize(): void {
    this.isDesktop.set(this.matchesDesktop());
  }

  onSearchTermChange(value: string): void {
    this.chats.setSearchTerm(value);
    if (typeof window === "undefined") return;
    if (this.searchDebounceHandle) clearTimeout(this.searchDebounceHandle);
    this.searchDebounceHandle = window.setTimeout(() => {
      this.chats.loadChats({ silent: true }).catch(() => null);
      this.searchDebounceHandle = null;
    }, 250);
  }

  onFilterChange(filter: ChatFilter): void {
    this.chats.setFilter(filter);
    this.chats.loadChats({ silent: true }).catch(() => null);
  }

  onSelectChat(chatId: string): void {
    this.router.navigate(["/main/chats", chatId]);
  }

  onBackToList(): void {
    this.router.navigate(["/main/chats"]);
  }

  onRefreshList(): void {
    this.chats.refreshAll().catch(() => null);
  }

  onRefreshDetail(): void {
    this.chats.refreshSelected().catch(() => null);
  }

  onMarkRead(): void {
    this.chats.markSelectedAsRead().catch(() => null);
  }

  onCloseChat(): void {
    const active = this.chats.selectedChat();
    if (!active || active.status === "closed") return;
    if (typeof window !== "undefined") {
      const confirmed = window.confirm("¿Cerrar este chat manualmente?");
      if (!confirmed) return;
    }
    this.chats.closeSelectedChat().catch(() => null);
  }

  private matchesDesktop(): boolean {
    if (typeof window === "undefined") return true;
    return window.matchMedia("(min-width: 960px)").matches;
  }
}
