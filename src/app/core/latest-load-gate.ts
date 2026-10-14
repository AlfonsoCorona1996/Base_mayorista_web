export interface LoadTicket {
  /** Esta carga es la más reciente iniciada. */
  isCurrent(): boolean;
  /**
   * Autoriza publicar el resultado si ninguna carga posterior publicó ya y si se
   * pidió con la misma clave (mismos negocios autorizados) que la carga más reciente.
   * Así una respuesta vieja nunca pisa una nueva, pero un resultado válido tampoco se
   * descarta solo porque haya otra lectura en curso que todavía puede fallar.
   */
  claimPublish(): boolean;
}

/**
 * Coordina cargas repetidas de un mismo recurso:
 *
 * - Una llamada con la misma clave mientras otra sigue en curso recibe la misma
 *   promesa: los reintentos y las pantallas que entran a la vez no duplican lecturas.
 * - `force` (o una clave distinta) inicia una carga nueva aunque haya otra en curso.
 * - `latest()` permite que una carga cuyo resultado no se publicó espere a la vigente,
 *   de modo que su promesa no se resuelva antes de que existan datos actuales.
 */
export class LatestLoadGate {
  private generation = 0;
  private publishedGeneration = 0;
  private latestKey: string | null = null;
  private inFlight: { generation: number; key: string; promise: Promise<void> } | null = null;

  run(key: string, force: boolean, task: (ticket: LoadTicket) => Promise<void>): Promise<void> {
    if (!force && this.inFlight && this.inFlight.key === key) return this.inFlight.promise;

    const generation = ++this.generation;
    this.latestKey = key;
    const ticket: LoadTicket = {
      isCurrent: () => generation === this.generation,
      claimPublish: () => {
        if (generation <= this.publishedGeneration || key !== this.latestKey) return false;
        this.publishedGeneration = generation;
        return true;
      },
    };
    const promise = task(ticket).finally(() => {
      if (this.inFlight?.generation === generation) this.inFlight = null;
    });
    this.inFlight = { generation, key, promise };
    return promise;
  }

  /** Promesa de la carga vigente, si hay una en curso. */
  latest(): Promise<void> | null {
    return this.inFlight?.promise ?? null;
  }
}
