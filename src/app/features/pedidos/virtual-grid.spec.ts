import { VirtualGridController } from "./virtual-grid";

/**
 * Pruebas con DOM real: un contenedor con scroll propio y un "render" mínimo que
 * hace lo mismo que la plantilla (monta el rango y aplica los espaciadores).
 */
describe("VirtualGridController (R4)", () => {
  let scroller: HTMLDivElement;
  let content: HTMLDivElement;
  let heights: Map<string, number>;
  let ids: string[];
  let controller: VirtualGridController;

  // Recorren cientos de elementos con frames reales: el límite por defecto (5 s) no alcanza.
  let defaultTimeout = 0;
  beforeAll(() => {
    defaultTimeout = jasmine.DEFAULT_TIMEOUT_INTERVAL;
    jasmine.DEFAULT_TIMEOUT_INTERVAL = 60_000;
  });
  afterAll(() => {
    jasmine.DEFAULT_TIMEOUT_INTERVAL = defaultTimeout;
  });

  const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

  function renderRange(): void {
    const range = controller.range();
    content.style.paddingTop = `${range.padTop}px`;
    content.style.paddingBottom = `${range.padBottom}px`;
    content.replaceChildren(
      ...ids.slice(range.start, range.end).map((id) => {
        const item = document.createElement("div");
        item.setAttribute("data-vid", id);
        item.style.height = `${heights.get(id)}px`;
        item.textContent = id;
        return item;
      }),
    );
    controller.afterRender();
  }

  /** Render + frames hasta que el rango deja de cambiar (como hace Angular tras cada señal). */
  async function settle(): Promise<void> {
    for (let i = 0; i < 20; i++) {
      const before = JSON.stringify(controller.range());
      renderRange();
      await frame();
      if (JSON.stringify(controller.range()) === before) {
        renderRange();
        return;
      }
    }
  }

  const mounted = () => Array.from(content.querySelectorAll("[data-vid]")).map((node) => node.getAttribute("data-vid")!);
  const firstVisible = () => {
    const top = scroller.getBoundingClientRect().top;
    const node = Array.from(content.querySelectorAll<HTMLElement>("[data-vid]")).find((item) => item.getBoundingClientRect().bottom > top + 1);
    return node ? { id: node.getAttribute("data-vid")!, top: Math.round(node.getBoundingClientRect().top - top) } : null;
  };

  function setup(count: number, options: { grid?: boolean } = {}): void {
    scroller = document.createElement("div");
    scroller.style.cssText = "height: 300px; width: 600px; overflow-y: auto; position: relative;";
    content = document.createElement("div");
    if (options.grid) content.style.cssText = "display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px;";
    scroller.appendChild(content);
    document.body.appendChild(scroller);
    ids = Array.from({ length: count }, (_, index) => `P-${String(index).padStart(4, "0")}`);
    // Alturas variables y deterministas: 40–118 px.
    heights = new Map(ids.map((id, index) => [id, 40 + ((index * 37) % 79)]));
    controller = new VirtualGridController({ estimate: 60, overscanPx: 200, initialCount: 10 });
  }

  afterEach(() => {
    controller?.unbind();
    scroller?.remove();
  });

  it("monta solo una ventana y llega al primer y al último elemento", async () => {
    setup(400);
    controller.setItems(ids, "keep");
    expect(controller.range().end).withContext("antes de conocer el viewport").toBe(10);
    controller.bind(content, scroller);
    await settle();
    expect(mounted().length).toBeLessThan(40);
    expect(mounted()[0]).toBe("P-0000");

    const seen = new Set<string>();
    for (let guard = 0; guard < 500; guard++) {
      mounted().forEach((id) => seen.add(id));
      if (scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 1) break;
      scroller.scrollTop += 280;
      await settle();
    }
    mounted().forEach((id) => seen.add(id));
    expect(seen.size).withContext("todos los elementos pasan por el viewport").toBe(400);
    expect(mounted()).toContain("P-0399");
    expect(mounted().length).toBeLessThan(40);
  });

  it("con alturas variables, el alto total converge al real al medirlas", async () => {
    setup(300);
    controller.setItems(ids, "keep");
    controller.bind(content, scroller);
    await settle();
    for (let guard = 0; guard < 400 && scroller.scrollTop + scroller.clientHeight < scroller.scrollHeight - 1; guard++) {
      scroller.scrollTop += 280;
      await settle();
    }
    const real = ids.reduce((sum, id) => sum + heights.get(id)!, 0);
    expect(Math.abs(content.getBoundingClientRect().height - real)).toBeLessThan(2);
  });

  it("un cambio de filtro u orden (reset) vuelve al inicio", async () => {
    setup(500);
    controller.setItems(ids, "keep");
    controller.bind(content, scroller);
    await settle();
    scroller.scrollTop = 6000;
    await settle();
    expect(scroller.scrollTop).toBeGreaterThan(0);

    ids = [...ids].reverse();
    controller.setItems(ids, "reset");
    await settle();
    expect(scroller.scrollTop).toBe(0);
    expect(mounted()[0]).toBe("P-0499");
  });

  it("un snapshot a media lista (keep) conserva el elemento visible y su posición", async () => {
    setup(500);
    controller.setItems(ids, "keep");
    controller.bind(content, scroller);
    await settle();
    scroller.scrollTop = 8000;
    await settle();
    const before = firstVisible()!;

    // Un pedido del final pasa al principio y otro desaparece: todo lo visible cambia de índice.
    ids = ["P-0480", ...ids.filter((id) => id !== "P-0480" && id !== "P-0003")];
    controller.setItems(ids, "keep");
    await settle();
    const after = firstVisible()!;
    expect(after.id).toBe(before.id);
    expect(Math.abs(after.top - before.top)).toBeLessThanOrEqual(1);
  });

  it("al inicio de la lista, un pedido nuevo aparece arriba (no se ancla)", async () => {
    setup(200);
    controller.setItems(ids, "keep");
    controller.bind(content, scroller);
    await settle();
    ids = ["P-NUEVO", ...ids];
    heights.set("P-NUEVO", 50);
    controller.setItems(ids, "keep");
    await settle();
    expect(firstVisible()!.id).toBe("P-NUEVO");
    expect(scroller.scrollTop).toBe(0);
  });

  it("grilla de 3 columnas: monta filas completas y conserva el alto total con separación", async () => {
    setup(300, { grid: true });
    controller.setItems(ids, "keep");
    controller.bind(content, scroller);
    await settle();
    // Recorrido desde el inicio: todas las filas pasan por el viewport y quedan medidas.
    let checkedMiddle = false;
    for (let guard = 0; guard < 400 && scroller.scrollTop + scroller.clientHeight < scroller.scrollHeight - 1; guard++) {
      scroller.scrollTop += 280;
      await settle();
      if (!checkedMiddle && scroller.scrollTop > 3000) {
        checkedMiddle = true;
        expect(controller.range().start % 3).withContext("se montan filas completas").toBe(0);
        expect(mounted().length).toBeLessThan(90);
      }
    }
    expect(checkedMiddle).toBeTrue();
    let real = 0;
    for (let row = 0; row < 100; row++) real += Math.max(...ids.slice(row * 3, row * 3 + 3).map((id) => heights.get(id)!)) + (row < 99 ? 10 : 0);
    expect(Math.abs(content.getBoundingClientRect().height - real)).toBeLessThan(2);
    expect(mounted()).toContain("P-0299");
  });

  it("desconectado, el scroll ya no cambia el rango", async () => {
    setup(500);
    controller.setItems(ids, "keep");
    controller.bind(content, scroller);
    await settle();
    const range = controller.range();
    controller.unbind();
    scroller.scrollTop = 5000;
    await frame();
    await frame();
    expect(controller.range()).toEqual(range);
  });
});
