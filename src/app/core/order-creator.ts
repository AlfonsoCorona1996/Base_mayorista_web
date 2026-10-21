import { normalizeUserGender, UserGender } from "./user-gender";

export interface OrderCreator {
  uid: string;
  name: string;
  gender: UserGender | null;
}

export function normalizeOrderCreator(value: unknown): OrderCreator | null {
  if (!value || typeof value !== "object") return null;
  const actor = value as Record<string, unknown>;
  const uid = typeof actor["uid"] === "string" ? actor["uid"].trim() : "";
  const name = typeof actor["name"] === "string" ? actor["name"].trim() : "";
  if (!uid || !name) return null;
  return { uid, name, gender: normalizeUserGender(actor["gender"]) };
}
