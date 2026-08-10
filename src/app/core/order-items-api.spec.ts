import {
  buildOrderItemMutationRequest,
  buildOrderItemPatchRequest,
  buildOrderItemsUpdateRequest,
  mergeAuthoritativeOrderItems,
} from "./order-items-api";

describe("order items authoritative API adapter", () => {
  it("sends explicit confirmation when a below-cost line was confirmed in the UI", () => {
    const items = [
      { item_id: "normal", price_override_below_cost: false },
      { item_id: "below", price_override_below_cost: true },
    ];
    expect(buildOrderItemsUpdateRequest(items)).toEqual({
      items,
      below_cost_confirmation: true,
    });
  });

  it("replaces local items and totals only with the authoritative response", () => {
    const previous = [{ order_id: "o-1", items: [{ item_id: "old" }], totals: { total_amount: 1 }, updated_at: "old" }];
    const next = mergeAuthoritativeOrderItems(previous, "o-1", {
      items: [{ item_id: "server" }],
      totals: { total_amount: 120 },
      updated_at: "2026-08-02T12:00:00.000Z",
    });
    expect(next[0]).toEqual({
      order_id: "o-1",
      items: [{ item_id: "server" }],
      totals: { total_amount: 120 },
      updated_at: "2026-08-02T12:00:00.000Z",
    });
    expect(previous[0].items[0].item_id).toBe("old");
  });

  it("sends only the item being added or the fields being changed", () => {
    expect(buildOrderItemMutationRequest({ item_id: "new", price_override_below_cost: true })).toEqual({
      item: { item_id: "new", price_override_below_cost: true },
      below_cost_confirmation: true,
    });
    expect(buildOrderItemPatchRequest({ confirmation_state: "confirmed" })).toEqual({
      patch: { confirmation_state: "confirmed" },
      below_cost_confirmation: false,
    });
  });
});
