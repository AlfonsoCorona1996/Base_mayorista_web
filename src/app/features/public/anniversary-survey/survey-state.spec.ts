import { SURVEY_CAMPAIGN_ID, SURVEY_QUESTIONS_VERSION } from "./survey-definition";
import {
  DONE_STEP,
  GIFT_STEP,
  SurveyAnswers,
  buildSubmissionPayload,
  createDraft,
  createParticipationId,
  emptyAnswers,
  firstIncompleteStep,
  parseStoredDraft,
  validateName,
  validateQuestion,
} from "./survey-state";

function completeAnswers(): SurveyAnswers {
  return {
    satisfaction: 4,
    strengths: { selected: ["prices"], other: "" },
    improvements: { selected: ["delivery_times", "other"], other: "Más tallas" },
    new_products: { selected: ["footwear", "beauty", "home"], other: "" },
    sell_more: { selected: ["frequent_news"], other: "" },
    comment: "",
  };
}

function storedDraft(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...createDraft(), answers: completeAnswers(), ...overrides };
}

describe("survey-state", () => {
  it("crea un borrador nuevo en la bienvenida con un id aleatorio", () => {
    const draft = createDraft();
    expect(draft.step).toBe(0);
    expect(draft.campaignId).toBe(SURVEY_CAMPAIGN_ID);
    expect(draft.questionsVersion).toBe(SURVEY_QUESTIONS_VERSION);
    expect(draft.participationId).toMatch(/^[A-Za-z0-9-]{16,64}$/);
    expect(createParticipationId()).not.toBe(createParticipationId());
  });

  it("exige calificación en la pregunta 1", () => {
    const answers = emptyAnswers();
    expect(validateQuestion(answers, 0)?.code).toBe("required");
    expect(validateQuestion({ ...answers, satisfaction: 5 }, 0)).toBeNull();
  });

  it("exige al menos una opción y texto cuando se marca Otro", () => {
    const answers = emptyAnswers();
    expect(validateQuestion(answers, 1)?.code).toBe("required");
    const withOther = { ...answers, strengths: { selected: ["other"], other: "   " } };
    expect(validateQuestion(withOther, 1)?.code).toBe("other_required");
    expect(validateQuestion({ ...answers, strengths: { selected: ["other"], other: " Envíos " } }, 1)).toBeNull();
  });

  it("la pregunta 6 es opcional pero acotada", () => {
    expect(validateQuestion(emptyAnswers(), 5)).toBeNull();
    expect(validateQuestion({ ...emptyAnswers(), comment: "x".repeat(1001) }, 5)?.code).toBe("too_long");
  });

  it("valida el nombre del regalo", () => {
    expect(validateName("")?.code).toBe("name_required");
    expect(validateName(" 1 ")?.code).toBe("name_required");
    expect(validateName("A".repeat(81))?.code).toBe("name_too_long");
    expect(validateName("  Ana  ")).toBeNull();
  });

  it("detecta la primera pregunta incompleta", () => {
    expect(firstIncompleteStep(emptyAnswers(), GIFT_STEP)).toBe(1);
    expect(firstIncompleteStep(completeAnswers(), GIFT_STEP)).toBeNull();
    const missingThird = { ...completeAnswers(), improvements: { selected: [], other: "" } };
    expect(firstIncompleteStep(missingThird, GIFT_STEP)).toBe(3);
    expect(firstIncompleteStep(missingThird, 3)).toBeNull();
  });

  describe("parseStoredDraft", () => {
    it("recupera un borrador compatible tal como estaba", () => {
      const draft = parseStoredDraft(JSON.parse(JSON.stringify(storedDraft({ step: 4, name: "Ana" }))));
      expect(draft?.step).toBe(4);
      expect(draft?.answers.improvements).toEqual({ selected: ["delivery_times", "other"], other: "Más tallas" });
      expect(draft?.name).toBe("Ana");
    });

    it("descarta datos corruptos o de otra versión", () => {
      expect(parseStoredDraft(null)).toBeNull();
      expect(parseStoredDraft("texto")).toBeNull();
      expect(parseStoredDraft(storedDraft({ schema: 99 }))).toBeNull();
      expect(parseStoredDraft(storedDraft({ questionsVersion: SURVEY_QUESTIONS_VERSION + 1 }))).toBeNull();
      expect(parseStoredDraft(storedDraft({ campaignId: "otra" }))).toBeNull();
      expect(parseStoredDraft(storedDraft({ participationId: "x" }))).toBeNull();
    });

    it("limpia opciones desconocidas y respeta el máximo", () => {
      const draft = parseStoredDraft(
        storedDraft({
          answers: {
            ...completeAnswers(),
            strengths: { selected: ["hack", "prices", "prices", "quality", "service"], other: "x" },
          },
        }),
      );
      expect(draft?.answers.strengths).toEqual({ selected: ["prices", "quality"], other: "" });
    });

    it("no retoma más allá de una pregunta obligatoria vacía", () => {
      const draft = parseStoredDraft(
        storedDraft({ step: GIFT_STEP, answers: { ...completeAnswers(), new_products: { selected: [] } } }),
      );
      expect(draft?.step).toBe(4);
    });

    it("un envío confirmado vuelve a la confirmación", () => {
      const receipt = {
        participationId: "8f14e45f-ceea-4e7b-9a3c-1d2b3c4d5e6f",
        receivedAt: "2026-10-28T12:00:00.000Z",
        registeredName: "Ana",
        reward: { status: "pending_definition" },
      };
      const draft = parseStoredDraft(storedDraft({ step: 2, submission: "confirmed", receipt }));
      expect(draft?.step).toBe(DONE_STEP);
      expect(draft?.receipt?.registeredName).toBe("Ana");
      expect(draft?.receipt?.reward.status).toBe("pending_definition");
    });

    it("conserva un envío pendiente sin comprobante", () => {
      const draft = parseStoredDraft(storedDraft({ step: GIFT_STEP, submission: "pending" }));
      expect(draft?.submission).toBe("pending");
      expect(draft?.step).toBe(GIFT_STEP);
    });
  });

  it("arma el envío con textos limpios y sin Otro desmarcado", () => {
    const draft = {
      ...createDraft(),
      name: "  Ana   López ",
      answers: {
        ...completeAnswers(),
        strengths: { selected: ["prices"], other: "residuo" },
        comment: "  Gracias  ",
      },
    };
    const payload = buildSubmissionPayload(draft);
    expect(payload.registered_name).toBe("Ana López");
    expect(payload.answers.strengths).toEqual({ selected: ["prices"], other: "" });
    expect(payload.answers.improvements).toEqual({ selected: ["delivery_times", "other"], other: "Más tallas" });
    expect(payload.answers.comment).toBe("Gracias");
    expect(payload.participation_id).toBe(draft.participationId);
  });
});
