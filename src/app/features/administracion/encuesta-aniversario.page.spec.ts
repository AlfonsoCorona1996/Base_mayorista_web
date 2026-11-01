import { ApplicationRef, provideZonelessChangeDetection } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { provideRouter } from "@angular/router";
import { Observable, of, throwError } from "rxjs";
import { UserAdminApiService } from "../../services/user-admin-api.service";
import EncuestaAniversarioPage from "./encuesta-aniversario.page";

function summaryResponse(total: number) {
  return {
    ok: true,
    generated_at: "2026-10-28T18:00:00.000Z",
    config: { status: "active", reward: { status: "pending_definition", title: null, description: null } },
    summary: {
      questions_version: 2,
      total_responses: total,
      satisfaction: {
        counts: { 1: 0, 2: 0, 3: 1, 4: 0, 5: total ? total - 1 : 0 },
        labels: { 1: "Muy mala", 2: "Mala", 3: "Regular", 4: "Buena", 5: "Excelente" },
        average: total ? 4.5 : null,
        answered: total,
      },
      options: {
        facebook_interest: {
          counts: { very_interested: 1, needs_information: 1, not_interested: 0, other: 0 },
          labels: { very_interested: "Muy interesadas", needs_information: "Interesadas que necesitan información", not_interested: "No interesadas", other: "Otras respuestas" },
          other_texts: [],
          max: 1,
          kind: "single",
        },
        strengths: {
          counts: { prices: 2, quality: 1, other: 1 },
          labels: { prices: "Nuestros precios", quality: "Calidad de los productos", other: "Otro" },
          other_texts: [{ text: "Envíos rápidos", response_id: "r1" }],
          max: 2,
        },
      },
      comments: total ? [{ response_id: "r1", text: "Muy bien", satisfaction: 5, registered_name: "Ana", received_at: null }] : [],
      claims: { total, by_status: { pending_validation: total }, repeated_names: total > 1 ? 1 : 0 },
      participations: total
        ? [
            { response_id: "r1", registered_name: "Ana", satisfaction: 5, received_at: null, claim_status: "pending_validation", reward_status: "pending_definition" },
            { response_id: "r2", registered_name: "ANA", satisfaction: 3, received_at: null, claim_status: "validated", reward_status: "pending_definition" },
          ]
        : [],
    },
  };
}

async function render(response: () => Observable<unknown>) {
  TestBed.configureTestingModule({
    imports: [EncuestaAniversarioPage],
    providers: [
      provideZonelessChangeDetection(),
      provideRouter([]),
      { provide: UserAdminApiService, useValue: { get: response } },
    ],
  });
  const fixture = TestBed.createComponent(EncuestaAniversarioPage);
  await fixture.whenStable();
  await fixture.whenStable();
  return fixture.nativeElement as HTMLElement;
}

describe("EncuestaAniversarioPage", () => {
  it("muestra indicadores, distribuciones, comentarios y regalos", async () => {
    const root = await render(() => of(summaryResponse(2)));
    const text = root.textContent ?? "";
    expect(text).toContain("Participaciones");
    expect(text).toContain("4.50");
    expect(text).toContain("Nuestros precios");
    expect(text).toContain("Respuestas en «Otro» (1)");
    expect(text).toContain("Muy bien");
    expect(text).toContain("Por validar");
    expect(text).toContain("Validado");
    expect(text).toContain("Iniciativa Facebook");
    expect(text).toContain("Interesadas que necesitan información");
    expect(root.querySelectorAll(".sv-chip--warn").length).toBe(2);
  });

  it("explica el estado vacío", async () => {
    const root = await render(() => of(summaryResponse(0)));
    expect(root.textContent).toContain("Todavía no hay respuestas");
  });

  it("muestra el error con opción de reintentar", async () => {
    const root = await render(() => throwError(() => new Error("Sin permiso")));
    expect(root.querySelector("[role=alert]")?.textContent).toContain("Sin permiso");
    expect(root.textContent).toContain("Reintentar");
  });

  it("al cambiar de versión muestra únicamente indicadores y textos históricos", async () => {
    const current = summaryResponse(2);
    const previous = summaryResponse(1).summary;
    previous.questions_version = 1;
    previous.satisfaction.average = 2;
    previous.options = {} as typeof previous.options;
    previous.comments = [{ response_id: "old", text: "Comentario anterior", satisfaction: 2, registered_name: "Bea", received_at: null }];
    const root = await render(() => of({ ...current, summaries_by_version: { 1: previous, 2: current.summary } }));
    const select = root.querySelector<HTMLSelectElement>("#sv-version");
    expect(root.textContent).toContain("Iniciativa Facebook");
    if (!select) throw new Error("Falta selector de versión");
    select.value = "1";
    select.dispatchEvent(new Event("change"));
    TestBed.inject(ApplicationRef).tick();
    expect(root.textContent).toContain("2.00");
    expect(root.textContent).toContain("Comentario anterior");
    expect(root.textContent).not.toContain("Iniciativa Facebook");
    expect(root.textContent).not.toContain("Muy bien");
  });
});
