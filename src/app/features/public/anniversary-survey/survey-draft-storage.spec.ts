import { DRAFT_STORAGE_KEY, SurveyDraftStorage } from "./survey-draft-storage";
import { createDraft } from "./survey-state";

class MemoryStorage implements Storage {
  private readonly data = new Map<string, string>();
  get length(): number {
    return this.data.size;
  }
  clear(): void {
    this.data.clear();
  }
  getItem(key: string): string | null {
    return this.data.get(key) ?? null;
  }
  key(index: number): string | null {
    return [...this.data.keys()][index] ?? null;
  }
  removeItem(key: string): void {
    this.data.delete(key);
  }
  setItem(key: string, value: string): void {
    this.data.set(key, value);
  }
}

class FullStorage extends MemoryStorage {
  override setItem(): void {
    throw new DOMException("Cuota llena", "QuotaExceededError");
  }
}

describe("SurveyDraftStorage", () => {
  it("guarda y recupera el borrador", () => {
    const storage = new SurveyDraftStorage(new MemoryStorage());
    const draft = { ...createDraft(), step: 3 };
    draft.answers.satisfaction = 5;
    expect(storage.save(draft)).toBeTrue();
    const loaded = storage.load();
    expect(loaded.status).toBe("restored");
    expect(loaded.draft?.answers.satisfaction).toBe(5);
    expect(loaded.draft?.participationId).toBe(draft.participationId);
  });

  it("sin datos no restaura nada", () => {
    expect(new SurveyDraftStorage(new MemoryStorage()).load()).toEqual({ draft: null, status: "none" });
  });

  it("descarta y borra un borrador corrupto", () => {
    const memory = new MemoryStorage();
    memory.setItem(DRAFT_STORAGE_KEY, "{no es json");
    const result = new SurveyDraftStorage(memory).load();
    expect(result).toEqual({ draft: null, status: "discarded" });
    expect(memory.getItem(DRAFT_STORAGE_KEY)).toBeNull();
  });

  it("descarta un borrador de otra versión", () => {
    const memory = new MemoryStorage();
    memory.setItem(DRAFT_STORAGE_KEY, JSON.stringify({ ...createDraft(), questionsVersion: 999 }));
    expect(new SurveyDraftStorage(memory).load().status).toBe("discarded");
  });

  it("respalda un borrador anterior sin reinterpretar sus respuestas", () => {
    const memory = new MemoryStorage();
    const old = JSON.stringify({ ...createDraft(), questionsVersion: 1, step: 4 });
    memory.setItem(DRAFT_STORAGE_KEY, old);
    const storage = new SurveyDraftStorage(memory);
    expect(storage.load().status).toBe("discarded");
    storage.save(createDraft());
    expect(memory.getItem(`${DRAFT_STORAGE_KEY}.previous`)).toBe(old);
    expect(storage.load().draft?.questionsVersion).toBe(2);
  });

  it("sin almacenamiento disponible funciona en memoria sin fallar", () => {
    const storage = new SurveyDraftStorage(null);
    expect(storage.available).toBeFalse();
    expect(storage.save(createDraft())).toBeFalse();
    expect(storage.load()).toEqual({ draft: null, status: "none" });
    expect(() => storage.clear()).not.toThrow();
  });

  it("un error de cuota no rompe la encuesta", () => {
    const storage = new SurveyDraftStorage(new FullStorage());
    expect(storage.save(createDraft())).toBeFalse();
  });
});
