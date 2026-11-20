import { ComponentFixture, TestBed } from "@angular/core/testing";
import { Order, OrderItem, OrdersService } from "../../core/orders.service";
import { OrderPromotionComponent } from "./order-promotion.component";
import { applyPromotionChanges, promotionChanges, promotionRows, validPromotionPercent } from "./order-promotion";

function item(overrides: Partial<OrderItem> = {}): OrderItem {
  return { item_id: "one", title: "Pantalón", quantity: 2, source: "catalogo", state: "borrador",
    price_public: 199, price_clienta: 149.25, price_cost: 90, discount_pct: 25, ...overrides };
}
function order(items: OrderItem[] = [item()]): Order {
  return { order_id: "order-one", business_id: "bm", customer_id: "customer", route_id: null,
    status: "borrador", created_at: "", updated_at: "", items, packages: [], timeline: [],
    packing: { status: "in_progress", packages_count: 0 }, dispatch_request: { status: "none" },
    totals: { total_amount: 0, paid_amount: 0, balance_due: 0, discount_amount: 10, shipping_fee: 30 } };
}

describe("Order promotions", () => {
  it("replaces 25% using public price and rounds cents, without compounding", () => {
    const rows = promotionRows([item()], 35, "standard", []);
    expect(rows[0].after).toBe(129.35);
    expect(promotionChanges(rows, 35)[0].before).toBe(149.25);
  });

  it("selects actual 25% prices and preserves custom prices by default", () => {
    const rows = promotionRows([item(), item({ item_id: "two", price_clienta: 120, discount_pct: 25 })], 30, "standard", []);
    expect(rows.map(row => row.selected)).toEqual([true, false]);
    expect(promotionRows(rows.map(row => row.item), 30, "selected", ["two"]).map(row => row.selected)).toEqual([false, true]);
  });

  it("excludes missing bases, returns, canceled items and below-cost prices even with an old override", () => {
    const items = [item({ price_public: null }), item({ returned_qty: 1 }), item({ state: "cancelado" }),
      item({ price_cost: 150, price_override_below_cost: true })];
    expect(promotionRows(items, 40, "all", []).every(row => !!row.reason && !row.selected)).toBeTrue();
  });

  it("rejects invalid percentages and ignores already matching prices", () => {
    for (const percent of [null, NaN, Infinity, 0, -5, 100, 110]) expect(validPromotionPercent(percent)).toBeFalse();
    expect(validPromotionPercent(32.5)).toBeTrue();
    expect(promotionChanges(promotionRows([item()], 25, "all", []), 25)).toEqual([]);
  });

  it("restores exact optional values and preserves unrelated edits", () => {
    const original = item({ price_clienta: null, discount_pct: undefined });
    const changes = promotionChanges(promotionRows([original], 35, "all", []), 35);
    const changed = applyPromotionChanges([original], changes);
    const restored = applyPromotionChanges([{ ...changed[0], title: "Nuevo título" }], changes, true)[0];
    expect(restored.price_clienta).toBeNull();
    expect(Object.hasOwn(restored, "discount_pct")).toBeFalse();
    expect(restored.title).toBe("Nuevo título");
  });
});

describe("OrderPromotionComponent", () => {
  let fixture: ComponentFixture<OrderPromotionComponent>;
  let component: OrderPromotionComponent;
  let current: Order;
  let updateItems: jasmine.Spy;
  let logEvent: jasmine.Spy;

  beforeEach(async () => {
    current = order();
    updateItems = jasmine.createSpy("updateItems").and.callFake(async (_id: string, items: OrderItem[]) => {
      current = { ...current, items };
      fixture.componentRef.setInput("order", current);
    });
    logEvent = jasmine.createSpy("logEvent").and.resolveTo();
    await TestBed.configureTestingModule({ imports: [OrderPromotionComponent], providers: [
      { provide: OrdersService, useValue: { getById: () => current, updateItems, logEvent } },
    ] }).compileComponents();
    fixture = TestBed.createComponent(OrderPromotionComponent);
    component = fixture.componentInstance;
    fixture.componentRef.setInput("order", current);
    fixture.componentRef.setInput("editable", true);
    fixture.detectChanges();
  });

  it("previews existing shipping and global discount, saves once and undoes exactly", async () => {
    component.percent.set(35);
    expect(component.totals()).toEqual({ before: 318.5, after: 278.7 });
    await component.save();
    expect(updateItems).toHaveBeenCalledTimes(1);
    expect(current.items[0].price_clienta).toBe(129.35);
    expect(current.items[0].discount_pct).toBe(35);
    expect(current.totals.shipping_fee).toBe(30);
    expect(current.totals.discount_amount).toBe(10);
    await component.save(true);
    expect(current.items[0].price_clienta).toBe(149.25);
    expect(current.items[0].discount_pct).toBe(25);
    expect(component.undoChanges()).toEqual([]);
  });

  it("blocks double submissions and Escape during persistence", async () => {
    let finish!: () => void;
    updateItems.and.returnValue(new Promise<void>(resolve => { finish = resolve; }));
    component.open.set(true);
    fixture.detectChanges();
    const saving = component.save();
    await component.save();
    component.close();
    expect(component.open()).toBeTrue();
    expect(component.saving()).toBeTrue();
    expect(component.savingCount()).toBe(1);
    expect(updateItems).toHaveBeenCalledTimes(1);
    finish();
    await saving;
    expect(component.saving()).toBeFalse();
  });

  it("keeps selection and modal for a retry after a failed save", async () => {
    updateItems.and.rejectWith(new Error("network"));
    component.open.set(true);
    component.scope.set("selected");
    component.selected.set(["one"]);
    await component.save();
    expect(component.error()).toContain("No se pudo confirmar");
    expect(component.open()).toBeTrue();
    expect(component.selected()).toEqual(["one"]);
    expect(component.result()).toBeNull();
    expect(component.undoChanges()).toEqual([]);
    expect(logEvent).not.toHaveBeenCalled();
  });

  it("reports successful persistence separately from audit failure", async () => {
    logEvent.and.rejectWith(new Error("audit"));
    await component.save();
    expect(component.error()).toBeNull();
    expect(component.result()).toContain("No se pudo registrar en la bitácora");
    expect(component.undoChanges().length).toBe(1);
  });

  it("does not overwrite products changed since the preview", async () => {
    current = { ...current, items: [item({ price_clienta: 100 })] };
    await component.save();
    expect(component.error()).toContain("El pedido cambió");
    expect(updateItems).not.toHaveBeenCalled();
  });

  it("refuses undo when a later price edit would be lost", async () => {
    await component.save();
    current = { ...current, items: [{ ...current.items[0], price_clienta: 125 }] };
    fixture.componentRef.setInput("order", current);
    await component.save(true);
    expect(component.error()).toContain("modificados después");
    expect(updateItems).toHaveBeenCalledTimes(1);
  });

  it("rechecks edit permission and delivery before applying", async () => {
    fixture.componentRef.setInput("editable", false);
    await component.save();
    expect(updateItems).not.toHaveBeenCalled();
    fixture.componentRef.setInput("editable", true);
    current = { ...current, delivery_status: "delivered" };
    await component.save();
    expect(updateItems).not.toHaveBeenCalled();
  });

  it("keeps a completed request from showing an undo action on another order", async () => {
    let finish!: () => void;
    updateItems.and.returnValue(new Promise<void>(resolve => { finish = resolve; }));
    const saving = component.save();
    fixture.componentRef.setInput("order", { ...current, order_id: "another-order" });
    fixture.detectChanges();
    finish();
    await saving;
    expect(component.result()).toBeNull();
    expect(component.undoChanges()).toEqual([]);
    expect(logEvent).toHaveBeenCalled();
  });

  it("renders an accessible native dialog and preserves all product names", () => {
    component.open.set(true);
    component.scope.set("selected");
    fixture.detectChanges();
    const dialog: HTMLDialogElement = fixture.nativeElement.querySelector("dialog");
    expect(dialog.open).toBeTrue();
    expect(dialog.getAttribute("aria-labelledby")).toBe("promotion-title");
    expect(dialog.textContent).toContain("Pantalón");
    component.close();
    fixture.detectChanges();
    expect(dialog.open).toBeFalse();
  });

  it("wraps keyboard focus at both ends of the dialog", () => {
    component.open.set(true);
    fixture.detectChanges();
    const dialog: HTMLDialogElement = fixture.nativeElement.querySelector("dialog");
    const first = dialog.querySelector<HTMLButtonElement>("button")!;
    const last = dialog.querySelector<HTMLButtonElement>(".primary")!;
    last.focus();
    const forward = new KeyboardEvent("keydown", { key: "Tab", cancelable: true });
    component.onDialogKeydown(forward);
    expect(forward.defaultPrevented).toBeTrue();
    expect(document.activeElement).toBe(first);
    const backward = new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, cancelable: true });
    component.onDialogKeydown(backward);
    expect(document.activeElement).toBe(last);
  });
});
