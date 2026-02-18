
  closeActionModal() {
    this.actionModalOpen.set(false);
  }

  closedPackagesCount(order: Order): number {
    return (order.packages || []).filter((pkg) => ["armado", "en_ruta", "entregado"].includes(pkg.state)).length;
  }

  deliveredPackagesCount(order: Order): number {
    return (order.packages || []).filter((pkg) => pkg.state === "entregado").length;
  }

  unassignedConfirmedItems(order: Order): number {
    const assigned = new Set<string>();
    for (const pkg of order.packages || []) {
      for (const id of pkg.item_ids || []) assigned.add(id);
    }
    return (order.items || []).filter((item) => {
      const isConfirmed = !["entregado", "pagado", "cancelado", "devuelto"].includes(item.state);
      return isConfirmed && !assigned.has(item.item_id);
    }).length;
  }

  canDispatch(order: Order): boolean {
    const planned = this.plannedPackages(order);
    if (planned === null) return false;
    if (this.closedPackagesCount(order) < planned) return false;
    if (this.unassignedConfirmedItems(order) > 0) return false;
    return true;
  }

  supplierNameById(supplierId: string | null | undefined): string {
    if (!supplierId) return "Sin proveedor";
    return this.suppliers.getById(supplierId)?.display_name || supplierId;
  }

  itemImage(item: OrderItem): string | null {
    if (item.image_url) return item.image_url;

    if (item.source === "inventario" && item.inventory_id) {
      return this.inventory.items().find((row) => row.inventory_id === item.inventory_id)?.image_urls?.[0] || null;
    }

    if (item.source === "catalogo" && item.product_id) {
      const doc = this.catalogRows.find((row) => row.normalized_id === item.product_id) || null;
      if (!doc) return null;
      const listing: any = doc.listing || { items: [] };
      const variant = (listing.items || []).find((v: any) => (v.variant_name || "") === (item.variant || "")) || null;
      return variant?.image_url || doc.cover_images?.[0] || doc.preview_image_url || null;
    }

    return null;
  }

  groupedItemsBySupplier(order: Order): { supplierId: string | null; supplierName: string; items: OrderItem[] }[] {
    const groups = new Map<string | null, OrderItem[]>();
    for (const item of order.items || []) {
      const key = item.supplier_id ?? null;
      const list = groups.get(key) || [];
      list.push(item);
      groups.set(key, list);
    }
    return Array.from(groups.entries()).map(([supplierId, items]) => ({
      supplierId,
      supplierName: this.supplierNameById(supplierId),
      items,
    }));
  }

  availableStock(item: OrderItem): number | null {
    if (item.source !== "inventario" || !item.inventory_id) return null;
    return this.inventoryById().get(item.inventory_id)?.quantity_on_hand ?? null;
  }

  hasInsufficientStock(item: OrderItem): boolean {
    const available = this.availableStock(item);
    if (available === null) return false;
    return available < this.itemQuantity(item);
  }

  showStockConfidence(item: OrderItem): boolean {
    const available = this.availableStock(item);
    if (available === null) return false;
    return available >= this.itemQuantity(item);
  }

  insufficientItems(order: Order): OrderItem[] {
    return (order.items || []).filter((item) => this.hasInsufficientStock(item) || this.isOutOfStockConfirmation(item));
  }

  insufficientItemsCount(order: Order): number {
    return this.insufficientItems(order).length;
  }

  readyItemsCount(order: Order): number {
    return (order.items || []).filter((item) => !this.hasInsufficientStock(item)).length;
  }

  filteredProductItems(order: Order): OrderItem[] {
    if (this.productStockFilter() === "insufficient") {
      const insufficient = this.insufficientItems(order);
      if (insufficient.length === 0) return order.items || [];
      return insufficient;
    }
    return order.items || [];
  }

  setProductStockFilter(filter: "all" | "insufficient") {
    this.productStockFilter.set(filter);
  }

  estado_confirmacion(item: OrderItem): EstadoConfirmacion {
    if (item.confirmation_state === "confirmed") return "confirmado";
    if (item.confirmation_state === "out_of_stock") return "sin_stock";
    return "pendiente";
  }

  isPendingConfirmation(item: OrderItem): boolean {
    return this.estado_confirmacion(item) === "pendiente";
  }

  isConfirmedConfirmation(item: OrderItem): boolean {
    return this.estado_confirmacion(item) === "confirmado";
  }

  isOutOfStockConfirmation(item: OrderItem): boolean {
    return this.estado_confirmacion(item) === "sin_stock";
  }

  confirmedReadyItems(order: Order): number {
    return (order.items || []).filter((item) => this.isConfirmedConfirmation(item)).length;
  }

  confirmExistencesActionLabel(order: Order): string {
    return `Confirmar existencias Â· ${this.confirmedReadyItems(order)}/${this.totalItems(order)}`;
  }

  isConfirmExistencesReady(order: Order): boolean {
    return this.totalItems(order) > 0 && this.allItemsResolved(order);
  }

  productCardId(item: OrderItem): string {
    return `product-card-${item.item_id}`;
  }

  shouldShowStockFab(order: Order): boolean {
    return this.showStockFab() && this.totalItems(order) >= 8 && this.insufficientItemsCount(order) > 0;
  }

  scrollToFirstInsufficientProduct(order: Order) {
    const target = this.insufficientItems(order)[0];
    if (!target) return;
    this.productStockFilter.set("all");
    setTimeout(() => {
      document.getElementById(this.productCardId(target))?.scrollIntoView({ behavior: "smooth", block: "center" });
    }, 60);
  }

  hasStockAvailable(item: OrderItem): boolean {
    const available = this.availableStock(item);
    if (available === null) return true;
    return available >= this.itemQuantity(item);
  }

  maxConfirmableQty(item: OrderItem): number {
    const qty = this.itemQuantity(item);
    const available = this.availableStock(item);
    if (available === null) return qty;
    return Math.max(0, Math.min(qty, Math.trunc(available)));
  }

  hasStockForSmartConfirm(item: OrderItem): boolean {
    return this.maxConfirmableQty(item) > 0;
  }

  canQuickCheck(item: OrderItem): boolean {
    return !this.isConfirmedConfirmation(item);
  }

  isQuickConfirmed(item: OrderItem): boolean {
    return this.isConfirmedConfirmation(item) && this.confirmedQty(item) >= this.itemQuantity(item);
  }

  async quickConfirmItem(order: Order, item: OrderItem) {
    if (!this.canQuickCheck(item) || this.isQuickConfirming(item)) return;
    this.quickConfirming.update((current) => ({ ...current, [item.item_id]: true }));
    try {
      this.confirmQtyDraft.update((current) => ({
        ...current,
        [item.item_id]: this.itemQuantity(item),
      }));
      await this.confirmItem(order, item);
    } finally {
      this.quickConfirming.update((current) => ({ ...current, [item.item_id]: false }));
    }
  }

  isQuickConfirming(item: OrderItem): boolean {
    return !!this.quickConfirming()[item.item_id];
  }

  getCardDraftConfirmedQty(item: OrderItem): number {
    const max = this.maxConfirmableQty(item);
    const draft = this.confirmQtyDraft()[item.item_id];
    if (typeof draft === "number") return this.normalizeConfirmedQty(draft, max);
    if (this.isConfirmedConfirmation(item)) return this.normalizeConfirmedQty(this.confirmedQty(item), max);
    return max;
  }

  setCardDraftConfirmedQty(item: OrderItem, value: unknown) {
    const max = this.maxConfirmableQty(item);
    const next = this.normalizeConfirmedQty(value, max);
    this.confirmQtyDraft.update((current) => ({ ...current, [item.item_id]: next }));
  }

  increaseCardConfirmedQty(item: OrderItem) {
    this.setCardDraftConfirmedQty(item, this.getCardDraftConfirmedQty(item) + 1);
  }

  decreaseCardConfirmedQty(item: OrderItem) {
    this.setCardDraftConfirmedQty(item, this.getCardDraftConfirmedQty(item) - 1);
  }

  async confirmarItem(item: OrderItem) {
    const order = this.order();
    if (!order || !this.isConfirmItemsPhase(order)) return;
    if (this.isQuickConfirming(item)) return;
    this.quickConfirming.update((current) => ({ ...current, [item.item_id]: true }));
    try {
      const qty = this.getCardDraftConfirmedQty(item);
      if (qty <= 0) {
        await this.markOutOfStock(order, item);
        return;
      }
      this.confirmQtyDraft.update((current) => ({ ...current, [item.item_id]: qty }));
      await this.orders.updateItemConfirmation(order.order_id, item.item_id, {
        confirmation_state: "confirmed",
        confirmed_qty: qty,
      });
    } finally {
      this.quickConfirming.update((current) => ({ ...current, [item.item_id]: false }));
    }
  }

  async marcarAgotado(item: OrderItem) {
    const order = this.order();
    if (!order || !this.isConfirmItemsPhase(order)) return;
    if (this.isOutOfStockConfirmation(item) || this.isQuickConfirming(item)) return;
    this.quickConfirming.update((current) => ({ ...current, [item.item_id]: true }));
    try {
      await this.markOutOfStock(order, item);
    } finally {
      this.quickConfirming.update((current) => ({ ...current, [item.item_id]: false }));
    }
  }

  async confirmarTodoDisponible() {
    const order = this.order();
    if (!order || !this.isConfirmItemsPhase(order)) return;
    await this.magicConfirmAvailable(order);
  }

  canMagicConfirm(order: Order): boolean {
    return (order.items || []).some((item) => !this.isConfirmedConfirmation(item) && this.hasStockForSmartConfirm(item));
  }

  async magicConfirmAvailable(order: Order) {
    const targets = (order.items || []).filter((item) => !this.isConfirmedConfirmation(item));
    if (targets.length === 0) return;
    await Promise.all(
      targets.map(async (item) => {
        const qty = this.maxConfirmableQty(item);
        if (qty <= 0) {
          await this.markOutOfStock(order, item);
          return;
        }
        this.confirmQtyDraft.update((current) => ({ ...current, [item.item_id]: qty }));
        await this.orders.updateItemConfirmation(order.order_id, item.item_id, {
          confirmation_state: "confirmed",
          confirmed_qty: qty,
        });
      }),
    );
  }

  hasPendingItems(order: Order): boolean {
    return (order.items || []).some((item) => !this.isConfirmedConfirmation(item));
  }

  canBatchMarkAvailable(order: Order): boolean {
    return this.canMagicConfirm(order);
  }

  async markVisibleAsAvailable(order: Order) {
    await this.magicConfirmAvailable(order);
  }

  shouldMagnetizeInsufficientTab(order: Order): boolean {
    return this.insufficientItemsCount(order) > 0;
  }

  confirmedItems(order: Order): OrderItem[] {
    return (order.items || []).filter((item) => item.confirmation_state === "confirmed");
  }

  totalPieces(order: Order): number {
    return (order.items || []).reduce((sum, item) => sum + this.itemQuantity(item), 0);
  }

  totalItems(order: Order): number {
    return (order.items || []).length;
  }

  resolvedItems(order: Order): number {
    return (order.items || []).filter((item) => item.confirmation_state && item.confirmation_state !== "pending").length;
  }

  confirmedPieces(order: Order): number {
    return (order.items || [])
      .filter((item) => item.confirmation_state === "confirmed")
      .reduce((sum, item) => sum + this.confirmedQty(item), 0);
  }

  outOfStockPieces(order: Order): number {
    return (order.items || [])
      .filter((item) => item.confirmation_state === "out_of_stock")
      .reduce((sum, item) => sum + this.itemQuantity(item), 0);
  }

  pendingPieces(order: Order): number {
    return (order.items || [])
      .filter((item) => !item.confirmation_state || item.confirmation_state === "pending")
      .reduce((sum, item) => sum + this.itemQuantity(item), 0);
  }

  allItemsResolved(order: Order): boolean {
    return (order.items || []).every((item) => item.confirmation_state && item.confirmation_state !== "pending");
  }

  unresolvedItemsCount(order: Order): number {
    return (order.items || []).filter((item) => !item.confirmation_state || item.confirmation_state === "pending").length;
  }

  missingSupplierCount(order: Order): number {
    return this.confirmedItems(order).filter((item) => !item.supplier_id).length;
  }

  canEditItems(order: Order | null): boolean {
    if (!order) return false;
    const base = this.allowedCapabilities(order, this.userRole()).canEditItems;
    return base || (order.status === "en_ruta" && this.lateChangeApproved());
  }

  nextStatus(order: Order | null): OrderStatus | null {
    if (!order) return null;
    const flow: OrderStatus[] = [
      "borrador",
      "confirmando_proveedor",
      "reservado_inventario",
      "solicitado_proveedor",
      "en_transito",
      "recibido_qa",
      "empaque",
      "en_ruta",
      "entregado",
      "pago_pendiente",
      "pagado",
    ];
    const idx = flow.indexOf(order.status);
    if (idx === -1 || idx === flow.length - 1) return null;
    return flow[idx + 1];
  }

  advance(order: Order | null) {
    const next = this.nextStatus(order);
    if (order && next) this.orders.updateStatus(order.order_id, next);
  }

  setItemState(orderId: string, item: OrderItem, state: OrderItemState) {
    this.orders.updateItemState(orderId, item.item_id, state);
  }

  async confirmItem(order: Order, item: OrderItem) {
    const qty = this.getDraftConfirmedQty(item);
    if (qty <= 0) {
      await this.markOutOfStock(order, item);
      return;
    }
    this.confirmQtyDraft.update((current) => ({ ...current, [item.item_id]: qty }));
    await this.orders.updateItemConfirmation(order.order_id, item.item_id, {
      confirmation_state: "confirmed",
      confirmed_qty: qty,
    });
  }

  async markOutOfStock(order: Order, item: OrderItem) {
    this.confirmQtyDraft.update((current) => ({ ...current, [item.item_id]: 0 }));
    await this.orders.updateItemConfirmation(order.order_id, item.item_id, {
      confirmation_state: "out_of_stock",
      confirmed_qty: 0,
    });
  }

  groupUnresolvedCount(items: OrderItem[]): number {
    return items.filter((item) => !item.confirmation_state || item.confirmation_state === "pending").length;
  }

  async confirmGroup(order: Order, items: OrderItem[]) {
    const pending = items.filter((item) => item.confirmation_state !== "confirmed");
    if (pending.length === 0) return;
    this.confirmQtyDraft.update((current) => {
      const next = { ...current };
      for (const item of pending) next[item.item_id] = this.normalizeConfirmedQty(item.quantity, item.quantity);
      return next;
    });
    await Promise.all(
      pending.map((item) =>
        this.orders.updateItemConfirmation(order.order_id, item.item_id, {
          confirmation_state: "confirmed",
          confirmed_qty: this.normalizeConfirmedQty(item.quantity, item.quantity),
        }),
      ),
    );
  }

  async outOfStockGroup(order: Order, items: OrderItem[]) {
    const pending = items.filter((item) => item.confirmation_state !== "out_of_stock");
    if (pending.length === 0) return;
    this.confirmQtyDraft.update((current) => {
      const next = { ...current };
      for (const item of pending) next[item.item_id] = 0;
      return next;
    });
    await Promise.all(
      pending.map((item) =>
        this.orders.updateItemConfirmation(order.order_id, item.item_id, {
          confirmation_state: "out_of_stock",
          confirmed_qty: 0,
        }),
      ),
    );
  }

  confirmedQty(item: OrderItem): number {
    if (typeof item.confirmed_qty === "number") {
      return this.normalizeConfirmedQty(item.confirmed_qty, item.quantity);
    }
    if (item.confirmation_state === "out_of_stock") return 0;
    return this.normalizeConfirmedQty(item.quantity, item.quantity);
  }

  getDraftConfirmedQty(item: OrderItem): number {
    const draft = this.confirmQtyDraft()[item.item_id];
    if (typeof draft === "number") return this.normalizeConfirmedQty(draft, item.quantity);
    return this.confirmedQty(item);
  }

  setDraftConfirmedQty(item: OrderItem, value: unknown) {
    const next = this.normalizeConfirmedQty(value, item.quantity);
    this.confirmQtyDraft.update((current) => ({ ...current, [item.item_id]: next }));
  }

  increaseDraftConfirmedQty(item: OrderItem) {
    this.setDraftConfirmedQty(item, this.getDraftConfirmedQty(item) + 1);
  }

  decreaseDraftConfirmedQty(item: OrderItem) {
    this.setDraftConfirmedQty(item, this.getDraftConfirmedQty(item) - 1);
  }

  hasPartialConfirmation(item: OrderItem): boolean {
    return item.confirmation_state === "confirmed" && this.confirmedQty(item) < item.quantity;
  }

  private itemQuantity(item: OrderItem): number {
    const qty = Number(item.quantity);
    if (!Number.isFinite(qty)) return 0;
    return Math.max(0, Math.trunc(qty));
  }

  private normalizeConfirmedQty(value: unknown, max: number): number {
    const qty = Number(value);
    if (!Number.isFinite(qty)) return 0;
    return Math.max(0, Math.min(max, Math.round(qty)));
  }

  async markSubstitute(order: Order, item: OrderItem) {
    await this.orders.updateItemConfirmationState(order.order_id, item.item_id, "substitute");
  }

  async receiveItem(order: Order, item: OrderItem) {
    await this.orders.updateItemState(order.order_id, item.item_id, "recibido_qa");
    await this.orders.logEvent(order.order_id, "ITEM_RECEIVED_QA", `Recibido/QA: ${item.title}`, {
      itemId: item.item_id,
    });
  }

  async markPacked(order: Order, item: OrderItem) {
    await this.orders.updateItemState(order.order_id, item.item_id, "empaque");
    await this.orders.logEvent(order.order_id, "ITEM_PACKED", `Empaque: ${item.title}`, {
      itemId: item.item_id,
    });
  }

  async markMissing(order: Order, item: OrderItem) {
    await this.orders.updateItemConfirmationState(order.order_id, item.item_id, "out_of_stock");
    await this.orders.updateItemState(order.order_id, item.item_id, "cancelado");
    await this.orders.createIncident(order.order_id, {
      orderId: order.order_id,
      packageId: null,
      itemId: item.item_id,
      type: "ITEM_MISSING",
      title: "Item faltante",
      severity: "high",
      reason: `Faltante en recepciÃ³n: ${item.title}`,
      evidenceUrls: [],
      createdBy: "admin",
    });
    await this.orders.logEvent(order.order_id, "ITEM_MISSING", `Faltante: ${item.title}`, {

