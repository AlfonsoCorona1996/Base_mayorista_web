import { ComponentFixture, TestBed } from "@angular/core/testing";
import { ClientaDiscountPanelComponent } from "./clienta-discount-panel.component";

describe("ClientaDiscountPanelComponent", () => {
  let fixture: ComponentFixture<ClientaDiscountPanelComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [ClientaDiscountPanelComponent],
    }).compileComponents();

    fixture = TestBed.createComponent(ClientaDiscountPanelComponent);
    fixture.detectChanges();
  });

  it("renders the percentage state accessibly", () => {
    const element = fixture.nativeElement as HTMLElement;
    const segments = element.querySelectorAll<HTMLButtonElement>(".discount-panel__segments button");

    expect(element.querySelector(".discount-panel")?.getAttribute("role")).toBe("group");
    expect(segments[0].getAttribute("aria-pressed")).toBe("true");
    expect(element.querySelector<HTMLInputElement>('input[type="number"]')?.value).toBe("25");
  });

  it("emits fixed amount changes with a typed numeric value", () => {
    const emitted: number[] = [];
    fixture.componentRef.setInput("mode", "fixed");
    fixture.componentInstance.fixedAmountChange.subscribe((value) => emitted.push(value));
    fixture.detectChanges();

    const element = fixture.nativeElement as HTMLElement;
    const input = element.querySelector<HTMLInputElement>('input[type="number"]');
    expect(input).not.toBeNull();
    if (!input) return;

    input.value = "35";
    input.dispatchEvent(new Event("input"));

    expect(emitted).toEqual([35]);
  });

  it("disables applying and announces progress while saving", () => {
    fixture.componentRef.setInput("saving", true);
    fixture.detectChanges();

    const element = fixture.nativeElement as HTMLElement;
    const applyButton = element.querySelector<HTMLButtonElement>(".discount-panel__button--primary");

    expect(element.querySelector(".discount-panel")?.getAttribute("aria-busy")).toBe("true");
    expect(applyButton?.disabled).toBeTrue();
    expect(applyButton?.textContent).toContain("Aplicando");
  });

  it("describes an invalid state with an accessible message", () => {
    fixture.componentRef.setInput("applyDisabled", true);
    fixture.componentRef.setInput("errorText", "Captura primero el precio final.");
    fixture.detectChanges();

    const element = fixture.nativeElement as HTMLElement;
    const panel = element.querySelector<HTMLElement>(".discount-panel");
    const error = element.querySelector<HTMLElement>(".discount-panel__error");
    const applyButton = element.querySelector<HTMLButtonElement>(".discount-panel__button--primary");

    expect(error?.textContent).toContain("Captura primero el precio final.");
    expect(panel?.getAttribute("aria-describedby")).toContain(error?.id || "missing-id");
    expect(applyButton?.disabled).toBeTrue();
  });
});
