import { CommonModule } from "@angular/common";
import { ChangeDetectionStrategy, Component, input, output } from "@angular/core";
import { ChatConversation, ChatFilter, ChatFilterCounts, CHAT_FILTER_OPTIONS } from "../data/chats.models";
import { ChatListItemComponent } from "./chat-list-item.component";

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: "app-chat-list",
  standalone: true,
  imports: [CommonModule, ChatListItemComponent],
  templateUrl: "./chat-list.component.html",
  styleUrl: "./chat-list.component.css",
})
export class ChatListComponent {
  chats = input<ChatConversation[]>([]);
  selectedChatId = input<string | null>(null);
  loading = input(false);
  error = input<string | null>(null);
  totalChats = input(0);
  activeFilter = input<ChatFilter>("all");
  searchTerm = input("");
  filterCounts = input<ChatFilterCounts>({
    all: 0,
    pending: 0,
    errors: 0,
    window_open: 0,
    closed: 0,
  });

  readonly filters = CHAT_FILTER_OPTIONS;
  readonly skeletonRows = [0, 1, 2, 3, 4];

  searchTermChanged = output<string>();
  filterChanged = output<ChatFilter>();
  refreshRequested = output<void>();
  chatSelected = output<string>();

  onSearch(event: Event): void {
    const target = event.target as HTMLInputElement | null;
    this.searchTermChanged.emit(target?.value || "");
  }

  onFilterChange(filter: ChatFilter): void {
    this.filterChanged.emit(filter);
  }

  onRefresh(): void {
    this.refreshRequested.emit();
  }

  onSelectChat(chatId: string): void {
    this.chatSelected.emit(chatId);
  }

  trackByChatId(_: number, chat: ChatConversation): string {
    return chat.chatId;
  }

  isFilterActive(filter: ChatFilter): boolean {
    return this.activeFilter() === filter;
  }

  filterCount(filter: ChatFilter): number {
    const counts = this.filterCounts();
    return counts[filter] ?? 0;
  }
}
