import { Component, signal } from "@angular/core";
import { ComponentFixture, TestBed } from "@angular/core/testing";
import {
  CUSTOMER_PICKER_SHEET_MEDIA,
  CustomerPickerComponent,
  CustomerPickerOption,
  CustomerPickerState,
} from "./customer-picker.component";

@Component({
  standalone: true,
  imports: [CustomerPickerComponent],
  template: `
    <app-customer-picker
      [(query)]="query"
      [options]="options()"
      [state]="state()"
      [selectedName]="selected()"
      (picked)="picked.push($event)"
      (selectionCleared)="cleared = cleared + 1"
      (retry)="retries = retries + 1"
    />
    <button type="button" id="outside">Otro control</button>
  `,
})
class HostComponent {
  query = signal("");
  options = signal<CustomerPickerOption[]>([]);
  state = signal<CustomerPickerState>("idle");
  selected = signal<string | null>(null);
  picked: string[] = [];
  cleared = 0;
  retries = 0;
}

const OPTIONS: CustomerPickerOption[] = [
  { id: "c-ana", name: "Ana Lopez", detail: "5551" },
  { id: "c-anabel", name: "Anabel María de los Ángeles Hernández Villaseñor de la Garza", detail: "5552" },
  { id: "c-anahi", name: "Anahí Ruiz", detail: "" },
];

/** MediaQueryList controlable para simular rotación o cambio de tamaño. */
class FakeMediaQueryList extends EventTarget {
  constructor(public matches: boolean) {
    super();
  }
  readonly media = "test";
  onchange = null;
  addListener(): void {}
  removeListener(): void {}
  change(matches: boolean): void {
    this.matches = matches;
    this.dispatchEvent(Object.assign(new Event("change"), { matches }));
  }
}

describe("CustomerPickerComponent", () => {
  let fixture: ComponentFixture<HostComponent>;
  let host: HostComponent;

  function setup(sheet: boolean): void {
    TestBed.configureTestingModule({
      imports: [HostComponent],
      providers: [{ provide: CUSTOMER_PICKER_SHEET_MEDIA, useValue: sheet ? "all" : "not all" }],
    });
    fixture = TestBed.createComponent(HostComponent);
    host = fixture.componentInstance;
    fixture.detectChanges();
  }

  const root = () => fixture.nativeElement as HTMLElement;
  const $ = <T extends Element>(selector: string) => root().querySelector<T>(selector);
  const picker = () => fixture.debugElement.children[0].componentInstance as CustomerPickerComponent;

  function type(input: HTMLInputElement, value: string): void {
    input.value = value;
    input.dispatchEvent(new Event("input"));
    fixture.detectChanges();
  }

  function key(target: Element, keyName: string, init: KeyboardEventInit = {}): KeyboardEvent {
    const event = new KeyboardEvent("keydown", { key: keyName, bubbles: true, cancelable: true, ...init });
    target.dispatchEvent(event);
    fixture.detectChanges();
    return event;
  }

  afterEach(() => {
    fixture?.destroy();
    document.body.removeAttribute("style");
  });

  describe("campo anclado (escritorio y tablet)", () => {
    beforeEach(() => setup(false));

    function showResults(): HTMLInputElement {
      const input = $<HTMLInputElement>("input[role='combobox']")!;
      input.focus();
      host.options.set(OPTIONS);
      host.state.set("results");
      type(input, "ana");
      return input;
    }

    it("expone un combobox con listbox y opciones accesibles", () => {
      const input = $<HTMLInputElement>("input[role='combobox']")!;
      expect(input.getAttribute("aria-expanded")).toBe("false");
      expect(input.getAttribute("aria-label")).toBe("Buscar clienta");

      showResults();
      const listbox = $<HTMLElement>("[role='listbox']")!;
      expect(input.getAttribute("aria-expanded")).toBe("true");
      expect(input.getAttribute("aria-controls")).toBe(listbox.id);
      expect(root().querySelectorAll("[role='option']").length).toBe(3);
      expect(host.query()).toBe("ana");
      expect(host.cleared).withContext("escribir invalida la selección anterior").toBe(1);
    });

    it("flechas, Home/End y Enter seleccionan sin ratón; Escape cierra", () => {
      const input = showResults();
      key(input, "ArrowDown");
      const options = root().querySelectorAll<HTMLElement>("[role='option']");
      expect(input.getAttribute("aria-activedescendant")).toBe(options[0].id);
      expect(options[0].getAttribute("aria-selected")).toBe("true");
      key(input, "ArrowDown");
      key(input, "ArrowUp");
      key(input, "ArrowUp");
      expect(input.getAttribute("aria-activedescendant")).withContext("vuelve al final").toBe(options[2].id);
      key(input, "Home");
      expect(input.getAttribute("aria-activedescendant")).toBe(options[0].id);
      key(input, "End");
      key(input, "Enter");
      expect(host.picked).toEqual(["c-anahi"]);
      expect($("[role='listbox']")).toBeNull();

      type(input, "an");
      expect($("[role='listbox']")).not.toBeNull();
      const escape = key(input, "Escape");
      expect(escape.defaultPrevented).toBeTrue();
      expect($("[role='listbox']")).toBeNull();
    });

    it("ocultar el teclado (blur sin destino) no cierra la lista y tocar una clienta la selecciona", () => {
      const input = showResults();
      input.dispatchEvent(new FocusEvent("focusout", { bubbles: true, relatedTarget: null }));
      input.blur();
      fixture.detectChanges();
      expect($("[role='listbox']")).withContext("sin temporizador de cierre").not.toBeNull();

      const option = root().querySelectorAll<HTMLElement>("[role='option']")[1];
      const pointer = new PointerEvent("pointerdown", { bubbles: true, cancelable: true });
      option.dispatchEvent(pointer);
      expect(pointer.defaultPrevented).withContext("tocar la lista no quita el foco del campo").toBeTrue();
      option.click();
      fixture.detectChanges();
      expect(host.picked).toEqual(["c-anabel"]);
    });

    it("se cierra al pasar el foco a otro control o al tocar fuera", () => {
      const input = showResults();
      const outside = $<HTMLButtonElement>("#outside")!;
      input.dispatchEvent(new FocusEvent("focusout", { bubbles: true, relatedTarget: outside }));
      fixture.detectChanges();
      expect($("[role='listbox']")).toBeNull();

      type(input, "ana");
      expect($("[role='listbox']")).not.toBeNull();
      outside.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
      fixture.detectChanges();
      expect($("[role='listbox']")).toBeNull();
    });

    it("muestra carga, error con reintento y sin resultados con los textos de FIX 01", () => {
      const input = $<HTMLInputElement>("input[role='combobox']")!;
      host.state.set("loading");
      type(input, "zu");
      expect(root().textContent).toContain("Cargando clientas…");
      expect(root().textContent).not.toContain("No existe una clienta");

      host.state.set("error");
      fixture.detectChanges();
      expect($("[role='alert']")?.textContent).toContain("No se pudieron cargar las clientas.");
      $<HTMLButtonElement>(".picker-retry")!.click();
      expect(host.retries).toBe(1);

      host.state.set("no-results");
      fixture.detectChanges();
      expect(root().textContent).toContain("No existe una clienta con ese nombre.");

      host.state.set("idle");
      fixture.detectChanges();
      expect($(".picker-popover")).withContext("con menos de 2 letras no se abre nada").toBeNull();
    });
  });

  describe("hoja de búsqueda (teléfono)", () => {
    beforeEach(() => setup(true));

    const trigger = () => $<HTMLButtonElement>("button.picker-trigger")!;
    const sheetInput = () => $<HTMLInputElement>(".picker-sheet input[role='combobox']");

    it("el disparador abre un diálogo y enfoca el buscador en el mismo toque", () => {
      expect(trigger().getAttribute("aria-haspopup")).toBe("dialog");
      expect(trigger().textContent).toContain("Busca por nombre o WhatsApp");
      trigger().click();

      const dialog = $<HTMLElement>("[role='dialog']")!;
      expect(dialog.getAttribute("aria-modal")).toBe("true");
      expect(dialog.getAttribute("aria-labelledby")).toBe(dialog.querySelector("h2")!.id);
      expect(trigger().getAttribute("aria-expanded")).toBe("true");
      // Sin esperar a otro ciclo: iOS solo abre el teclado si el foco llega dentro del gesto.
      expect(document.activeElement).toBe(sheetInput());
    });

    it("fija el documento mientras está abierta y lo restaura al cerrar", () => {
      document.body.style.overflow = "auto";
      trigger().click();
      expect(document.body.style.position).toBe("fixed");
      expect(document.body.style.overflow).toBe("hidden");

      $<HTMLButtonElement>(".picker-close")!.click();
      fixture.detectChanges();
      expect(document.body.style.position).toBe("");
      expect(document.body.style.overflow).toBe("auto");
      expect($("[role='dialog']")).toBeNull();
      expect(document.activeElement).withContext("el foco vuelve al disparador").toBe(trigger());
    });

    it("escribir no borra la selección; cerrar y reabrir conserva texto y clienta", () => {
      host.selected.set("Ana Lopez");
      fixture.detectChanges();
      expect(trigger().textContent).toContain("Ana Lopez");

      trigger().click();
      host.options.set(OPTIONS);
      host.state.set("results");
      type(sheetInput()!, "anab");
      expect(host.cleared).toBe(0);
      expect(host.query()).toBe("anab");

      key($("[role='dialog']")!, "Escape");
      expect($("[role='dialog']")).toBeNull();
      expect(trigger().textContent).toContain("Ana Lopez");

      trigger().click();
      expect(sheetInput()!.value).toBe("anab");
      expect(root().textContent).toContain("Seleccionada: Ana Lopez");
    });

    it("tocar una clienta la elige, cierra la hoja y devuelve el foco", () => {
      trigger().click();
      host.options.set(OPTIONS);
      host.state.set("results");
      type(sheetInput()!, "ana");
      // El teclado se oculta: el campo pierde el foco, la hoja sigue abierta.
      sheetInput()!.blur();
      fixture.detectChanges();
      expect($("[role='dialog']")).not.toBeNull();

      root().querySelectorAll<HTMLElement>("[role='option']")[1].click();
      fixture.detectChanges();
      expect(host.picked).toEqual(["c-anabel"]);
      expect($("[role='dialog']")).toBeNull();
      expect(document.activeElement).toBe(trigger());
    });

    it("teclado físico: flechas y Enter eligen; Tab no sale del diálogo", () => {
      trigger().click();
      host.options.set(OPTIONS);
      host.state.set("results");
      type(sheetInput()!, "ana");
      key(sheetInput()!, "ArrowDown");
      key(sheetInput()!, "ArrowDown");
      expect(sheetInput()!.getAttribute("aria-activedescendant")).toBe(root().querySelectorAll("[role='option']")[1].id);

      const close = $<HTMLButtonElement>(".picker-close")!;
      const clear = $<HTMLButtonElement>(".picker-clear")!;
      clear.focus();
      const tab = key(clear, "Tab");
      expect(tab.defaultPrevented).toBeTrue();
      expect(document.activeElement).toBe(close);
      const backTab = key(close, "Tab", { shiftKey: true });
      expect(backTab.defaultPrevented).toBeTrue();
      expect(document.activeElement).toBe(clear);

      sheetInput()!.focus();
      key(sheetInput()!, "Enter");
      expect(host.picked).toEqual(["c-anabel"]);
    });

    it("el estado de error ofrece reintento dentro de la hoja; sin texto orienta a escribir", () => {
      trigger().click();
      expect(root().textContent).toContain("Escribe al menos 2 letras");
      host.state.set("error");
      fixture.detectChanges();
      $<HTMLButtonElement>(".picker-retry")!.click();
      expect(host.retries).toBe(1);
      $<HTMLButtonElement>(".picker-clear")?.click();
    });

    it("la hoja sigue el área visible (visualViewport) cuando aparece y se oculta el teclado", () => {
      const fake = Object.assign(new EventTarget(), { height: 800, offsetTop: 0, width: 390 });
      const original = Object.getOwnPropertyDescriptor(window, "visualViewport");
      Object.defineProperty(window, "visualViewport", { configurable: true, get: () => fake });
      try {
        trigger().click();
        const backdrop = () => $<HTMLElement>(".picker-backdrop")!;
        expect(backdrop().style.height).toBe("800px");

        fake.height = 420;
        fake.offsetTop = 12;
        fake.dispatchEvent(new Event("resize"));
        fixture.detectChanges();
        expect(backdrop().style.height).toBe("420px");
        expect(backdrop().style.top).toBe("12px");

        fake.height = 800;
        fake.offsetTop = 0;
        fake.dispatchEvent(new Event("resize"));
        fixture.detectChanges();
        expect(backdrop().style.height).toBe("800px");
        expect($("[role='dialog']")).withContext("ocultar el teclado no cierra la hoja").not.toBeNull();
      } finally {
        if (original) Object.defineProperty(window, "visualViewport", original);
        else delete (window as unknown as { visualViewport?: unknown }).visualViewport;
      }
    });

    it("salir de la pantalla con la hoja abierta libera el documento", () => {
      trigger().click();
      expect(document.body.style.position).toBe("fixed");
      fixture.destroy();
      expect(document.body.style.position).toBe("");
    });
  });

  it("al rotar a un ancho de escritorio con la hoja abierta, se cierra sin perder texto", () => {
    const media = new FakeMediaQueryList(true);
    spyOn(window, "matchMedia").and.returnValue(media as unknown as MediaQueryList);
    setup(true);
    $<HTMLButtonElement>("button.picker-trigger")!.click();
    type($<HTMLInputElement>(".picker-sheet input")!, "ana");

    media.change(false);
    fixture.detectChanges();
    expect($("[role='dialog']")).toBeNull();
    expect(document.body.style.position).toBe("");
    const inline = $<HTMLInputElement>("input[role='combobox']")!;
    expect(inline.value).toBe("ana");

    media.change(true);
    fixture.detectChanges();
    expect($("button.picker-trigger")).not.toBeNull();
    expect(picker().sheetOpen()).toBeFalse();
  });
});
