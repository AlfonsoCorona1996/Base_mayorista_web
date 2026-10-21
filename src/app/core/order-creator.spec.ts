import { normalizeOrderCreator } from "./order-creator";

describe("Order creator", () => {
  it("conserva datos explícitos y limpia nombres sin inventar autores históricos", () => {
    expect(normalizeOrderCreator({ uid: "u1", name: " Andrea ", gender: "female" }))
      .toEqual({ uid: "u1", name: "Andrea", gender: "female" });
    expect(normalizeOrderCreator(null)).toBeNull();
    expect(normalizeOrderCreator("admin")).toBeNull();
    expect(normalizeOrderCreator({ name: "Andrea" })).toBeNull();
  });
  it("usa género neutro cuando falta o es inválido, independientemente del nombre", () => {
    expect(normalizeOrderCreator({ uid: "u1", name: "Andrea", gender: "invalid" })?.gender).toBeNull();
    expect(normalizeOrderCreator({ uid: "u2", name: "Jose Alfonso Corona" })?.gender).toBeNull();
  });
});
