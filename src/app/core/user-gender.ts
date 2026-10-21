export type UserGender = "male" | "female";

export function normalizeUserGender(value: unknown): UserGender | null {
  return value === "male" || value === "female" ? value : null;
}
