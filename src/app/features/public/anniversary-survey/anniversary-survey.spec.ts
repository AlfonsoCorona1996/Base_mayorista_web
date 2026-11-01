import { provideZonelessChangeDetection } from "@angular/core";
import { ComponentFixture, TestBed } from "@angular/core/testing";
import { provideHttpClient } from "@angular/common/http";
import { HttpTestingController, provideHttpClientTesting } from "@angular/common/http/testing";
import { environment } from "../../../../environments/environment";
import AnniversarySurveyPage from "./anniversary-survey";
import { DRAFT_STORAGE_KEY } from "./survey-draft-storage";
import { GIFT_STEP, createDraft } from "./survey-state";

const BASE = `${environment.adminApiBaseUrl.replace(/\/+$/, "")}/api/surveys/aniversario-2026`;

function stored(): Record<string, unknown> {
  return JSON.parse(localStorage.getItem(DRAFT_STORAGE_KEY) ?? "null") as Record<string, unknown>;
}

function completeDraft(step: number) {
  const draft = createDraft();
  return {
    ...draft,
    step,
    name: "",
    answers: {
      satisfaction: 4,
      strengths: { selected: ["prices"], other: "" },
      improvements: { selected: ["digital_catalog"], other: "" },
      new_products: { selected: ["footwear"], other: "" },
      facebook_interest: { selected: ["needs_information"], other: "" },
      comment: "",
    },
  };
}

describe("AnniversarySurveyPage", () => {
  let fixture: ComponentFixture<AnniversarySurveyPage>;
  let http: HttpTestingController;
  let root: HTMLElement;

  async function render(reward: { status: string; title?: string; description?: string } = { status: "pending_definition" }): Promise<void> {
    fixture = TestBed.createComponent(AnniversarySurveyPage);
    root = fixture.nativeElement as HTMLElement;
    http = TestBed.inject(HttpTestingController);
    await fixture.whenStable();
    http.expectOne(BASE).flush({ ok: true, status: "active", reward });
    await fixture.whenStable();
    await fixture.whenStable();
  }

  async function settle(): Promise<void> {
    await fixture.whenStable();
  }

  function q<T extends HTMLElement = HTMLElement>(selector: string): T {
    const element = root.querySelector<T>(selector);
    if (!element) throw new Error(`No existe ${selector}`);
    return element;
  }

  function buttonByText(text: string): HTMLButtonElement {
    const button = [...root.querySelectorAll<HTMLButtonElement>("button")].find((item) =>
      item.textContent?.includes(text),
    );
    if (!button) throw new Error(`No existe el botón ${text}`);
    return button;
  }

  function checkboxes(): HTMLInputElement[] {
    return [...root.querySelectorAll<HTMLInputElement>(".option input[type=checkbox]")];
  }

  async function next(): Promise<void> {
    q<HTMLButtonElement>("button[type=submit]").click();
    await settle();
  }

  beforeEach(() => {
    localStorage.removeItem(DRAFT_STORAGE_KEY);
    TestBed.configureTestingModule({
      imports: [AnniversarySurveyPage],
      providers: [provideZonelessChangeDetection(), provideHttpClient(), provideHttpClientTesting()],
    });
  });

  afterEach(() => {
    http.verify();
    fixture.destroy();
    localStorage.removeItem(DRAFT_STORAGE_KEY);
  });

  it("muestra la bienvenida y avanza a la primera pregunta", async () => {
    await render({ status: "active", title: "10% extra", description: "De descuento en tu próximo pedido." });
    expect(q("h1").textContent).toContain("¡Nuestro primer año se celebra contigo!");
    expect(root.textContent).toContain("10% extra");
    buttonByText("Comenzar encuesta").click();
    await settle();
    expect(q(".kicker").textContent).toContain("Pregunta 1 de 6");
    expect(stored()["step"]).toBe(1);
  });

  it("no avanza sin respuesta y guarda la selección al instante", async () => {
    localStorage.setItem(DRAFT_STORAGE_KEY, JSON.stringify({ ...createDraft(), step: 1 }));
    await render();
    await next();
    expect(q("#step-error").textContent).toContain("Elige una calificación");
    expect(q(".kicker").textContent).toContain("Pregunta 1 de 6");

    const radios = root.querySelectorAll<HTMLInputElement>("input[type=radio]");
    expect(radios.length).toBe(5);
    radios[3].click();
    await settle();
    expect((stored()["answers"] as Record<string, unknown>)["satisfaction"]).toBe(4);
    await next();
    expect(q(".kicker").textContent).toContain("Pregunta 2 de 6");
  });

  it("respeta el máximo, maneja Otro y conserva las selecciones", async () => {
    localStorage.setItem(DRAFT_STORAGE_KEY, JSON.stringify({ ...completeDraft(2), answers: { ...completeDraft(2).answers, strengths: { selected: [], other: "" } } }));
    await render();

    let boxes = checkboxes();
    boxes[0].click();
    await settle();
    boxes = checkboxes();
    boxes[6].click(); // Otro
    await settle();

    boxes = checkboxes();
    expect(boxes.filter((box) => box.disabled).length).toBe(5);
    expect(q(".hint").textContent).toContain("Ya elegiste 2");
    expect(root.querySelector("#other-input")).not.toBeNull();

    await next();
    expect(q("#step-error").textContent).toContain("Otro");
    expect(q(".kicker").textContent).toContain("Pregunta 2 de 6");

    const other = q<HTMLInputElement>("#other-input");
    other.value = "Envíos a mi pueblo";
    other.dispatchEvent(new Event("input"));
    await settle();

    // Desmarcar Otro oculta y limpia el texto, sin tocar la otra selección.
    checkboxes()[6].click();
    await settle();
    expect(root.querySelector("#other-input")).toBeNull();
    const strengths = (stored()["answers"] as Record<string, { selected: string[]; other: string }>)["strengths"];
    expect(strengths).toEqual({ selected: ["prices"], other: "" });
    expect(checkboxes().some((box) => box.disabled)).toBeFalse();
  });

  it("retoma donde se quedó y permite comenzar de nuevo con confirmación", async () => {
    localStorage.setItem(DRAFT_STORAGE_KEY, JSON.stringify(completeDraft(4)));
    await render();
    expect(q(".kicker").textContent).toContain("Pregunta 4 de 6");
    expect(q(".resume").textContent).toContain("Retomamos tu encuesta donde la dejaste.");
    expect(root.querySelectorAll<HTMLInputElement>(".option input[type=radio]")[1].checked).toBeTrue();

    buttonByText("Comenzar de nuevo").click();
    await settle();
    expect(stored()["step"]).toBe(4);
    buttonByText("Sí, empezar de nuevo").click();
    await settle();
    expect(q("h1").textContent).toContain("¡Nuestro primer año se celebra contigo!");
    expect(stored()["step"]).toBe(0);
    expect((stored()["answers"] as Record<string, unknown>)["satisfaction"]).toBeNull();
  });

  it("registra el regalo solo con confirmación del servidor", async () => {
    localStorage.setItem(DRAFT_STORAGE_KEY, JSON.stringify(completeDraft(GIFT_STEP)));
    await render();
    expect(q("h1").textContent).toContain("¡Este regalo es para ti!");

    await next();
    expect(q("#step-error").textContent).toContain("Escribe el nombre");

    const name = q<HTMLInputElement>("#gift-name");
    name.value = " Ana  López ";
    name.dispatchEvent(new Event("input"));
    await settle();
    await next();

    const request = http.expectOne(`${BASE}/responses`);
    expect(request.request.method).toBe("POST");
    expect(request.request.body.registered_name).toBe("Ana López");
    expect(stored()["submission"]).toBe("pending");
    const participationId = request.request.body.participation_id as string;
    request.flush({
      ok: true,
      participation_id: participationId,
      received_at: "2026-10-28T18:00:00.000Z",
      registered_name: "Ana López",
      reward: { status: "pending_definition" },
    });
    await settle();
    await settle();

    expect(q("h1").textContent).toContain("¡Gracias por participar!");
    expect(root.textContent).toContain("Ana López");
    expect(root.textContent).toContain("Detalles por anunciar");
    const saved = stored();
    expect(saved["submission"]).toBe("confirmed");
    expect((saved["answers"] as Record<string, unknown>)["satisfaction"]).toBeNull();
  });

  it("presenta el 10% aprobado y solo lo confirma después de registrar el regalo", async () => {
    const reward = { status: "active", title: "10% extra", description: "De descuento en tu próximo pedido." };
    const draft = { ...completeDraft(GIFT_STEP), name: "Ana" };
    localStorage.setItem(DRAFT_STORAGE_KEY, JSON.stringify(draft));
    await render(reward);
    expect(q(".anniversary-reward").textContent).toContain("10% extra");
    expect(q(".anniversary-reward").textContent).toContain("De descuento en tu próximo pedido.");
    expect(root.querySelector(".receipt")).toBeNull();
    await next();
    http.expectOne(`${BASE}/responses`).flush({ ok: true, participation_id: draft.participationId, registered_name: "Ana", reward });
    await settle();
    await settle();
    expect(q("h1").textContent).toContain("¡Tu regalo ya está registrado!");
    expect(q(".anniversary-reward--earned").textContent).toContain("10% extra");
    expect(q(".anniversary-reward--earned").textContent).toContain("De descuento en tu próximo pedido.");
    expect(q(".receipt").textContent).toContain("Ana");
  });

  it("Facebook usa radios, exige Otro, conserva su texto y lo limpia al cambiar de opción", async () => {
    const draft = completeDraft(4);
    draft.answers.facebook_interest = { selected: [], other: "" };
    localStorage.setItem(DRAFT_STORAGE_KEY, JSON.stringify(draft));
    await render();
    expect(root.textContent).toContain("Queremos llevar nuevas clientas hacia ti");
    expect(root.textContent).toContain("no te inscribe ni autoriza compartir tus datos");
    let radios = [...root.querySelectorAll<HTMLInputElement>(".option input[type=radio]")];
    expect(radios.length).toBe(4);
    expect(checkboxes().length).toBe(0);
    radios[3].click();
    await settle();
    await next();
    expect(q("#step-error").textContent).toContain("Otro");
    const input = q<HTMLInputElement>("#other-input");
    input.value = "Quisiera saber qué zonas cubre";
    input.dispatchEvent(new Event("input"));
    window.dispatchEvent(new Event("pagehide"));
    await settle();
    expect((stored()["answers"] as Record<string, { other: string }>)["facebook_interest"].other).toBe(input.value);
    radios = [...root.querySelectorAll<HTMLInputElement>(".option input[type=radio]")];
    radios[1].click();
    await settle();
    expect(root.querySelector("#other-input")).toBeNull();
    expect(radios.filter((radio) => radio.checked).length).toBe(1);
    expect(radios.some((radio) => radio.disabled)).toBeFalse();
    expect((stored()["answers"] as Record<string, { other: string }>)["facebook_interest"].other).toBe("");
    await next();
    expect(q(".kicker").textContent).toContain("Pregunta 5 de 6");
  });

  it("la propuesta abierta permite avanzar sin texto", async () => {
    localStorage.setItem(DRAFT_STORAGE_KEY, JSON.stringify(completeDraft(6)));
    await render();
    expect(root.textContent).toContain("Opcional. Puedes continuar sin escribir nada.");
    await next();
    expect(root.querySelector("#gift-name")).not.toBeNull();
  });

  it("recibe un borrador de pruebas anterior sin mostrar avisos de actualización ni reutilizar respuestas", async () => {
    localStorage.setItem(DRAFT_STORAGE_KEY, JSON.stringify({ ...completeDraft(4), questionsVersion: 1 }));
    await render();
    expect(root.textContent).not.toContain("Actualizamos las preguntas");
    expect(stored()["questionsVersion"]).toBe(2);
    expect((stored()["answers"] as Record<string, unknown>)["satisfaction"]).toBeNull();
  });

  it("reintenta un envío v1 pendiente con el mismo id y las respuestas originales", async () => {
    const old = { ...completeDraft(GIFT_STEP), questionsVersion: 1, submission: "pending", name: "Ana",
      answers: { ...completeDraft(GIFT_STEP).answers, improvements: { selected: ["delivery_times"], other: "" },
        sell_more: { selected: ["frequent_news"], other: "" } } };
    localStorage.setItem(DRAFT_STORAGE_KEY, JSON.stringify(old));
    await render();
    expect(root.textContent).toContain("Tu envío de la encuesta anterior quedó sin confirmar");
    expect(q<HTMLInputElement>("#gift-name").readOnly).toBeTrue();
    expect(buttonByText("Anterior").disabled).toBeTrue();
    await next();
    const request = http.expectOne(`${BASE}/responses`);
    expect(request.request.body.questions_version).toBe(1);
    expect(request.request.body.participation_id).toBe(old.participationId);
    expect(request.request.body.answers.sell_more.selected).toEqual(["frequent_news"]);
    expect(request.request.body.answers.facebook_interest).toBeUndefined();
    request.flush({ ok: true, participation_id: old.participationId, registered_name: "Ana", reward: { status: "pending_definition" } });
    await settle();
    await settle();
    expect(q("h1").textContent).toContain("¡Gracias por participar!");
  });

  it("sin conexión conserva el borrador y reintenta con el mismo id", async () => {
    localStorage.setItem(DRAFT_STORAGE_KEY, JSON.stringify({ ...completeDraft(GIFT_STEP), name: "Ana" }));
    await render();
    await next();
    const first = http.expectOne(`${BASE}/responses`);
    const participationId = first.request.body.participation_id as string;
    first.error(new ProgressEvent("error"), { status: 0 });
    await settle();
    await settle();

    expect(root.textContent).toContain("Tus respuestas siguen guardadas en este celular");
    expect(stored()["submission"]).toBe("pending");
    expect(buttonByText("Reintentar envío")).toBeTruthy();

    await next();
    const retry = http.expectOne(`${BASE}/responses`);
    expect(retry.request.body.participation_id).toBe(participationId);
    retry.flush({ error: "SERVER_ERROR" }, { status: 500, statusText: "Server Error" });
    await settle();
    await settle();
    expect(root.textContent).toContain("No pudimos registrar tus respuestas");
    expect(stored()["submission"]).toBe("pending");
  });

  it("informa si la campaña cerró", async () => {
    localStorage.setItem(DRAFT_STORAGE_KEY, JSON.stringify({ ...completeDraft(GIFT_STEP), name: "Ana" }));
    await render();
    await next();
    http
      .expectOne(`${BASE}/responses`)
      .flush({ error: "CAMPAIGN_CLOSED", message: "La encuesta de aniversario ya cerró." }, { status: 409, statusText: "Conflict" });
    await settle();
    await settle();
    expect(q("h1").textContent).toContain("Gracias por tu interés");
  });

  it("vuelve a mostrar la confirmación al reabrir el enlace", async () => {
    localStorage.setItem(
      DRAFT_STORAGE_KEY,
      JSON.stringify({
        ...createDraft(),
        submission: "confirmed",
        receipt: {
          participationId: "8f14e45f-ceea-4e7b-9a3c-1d2b3c4d5e6f",
          receivedAt: "2026-10-28T18:00:00.000Z",
          registeredName: "Ana",
          reward: { status: "active", title: "Regalo especial", description: "Detalle", redeemInstructions: "Presenta tu folio al hacer tu pedido." },
        },
      }),
    );
    await render();
    expect(q("h1").textContent).toContain("¡Tu regalo ya está registrado!");
    expect(q(".anniversary-reward--earned").textContent).toContain("Regalo especial");
    expect(q(".anniversary-reward--earned").textContent).toContain("Presenta tu folio al hacer tu pedido.");
    expect(q(".anniversary-reward--earned").textContent).not.toContain("10% extra");
    expect(root.textContent).toContain("8F14E45F");
  });
});
