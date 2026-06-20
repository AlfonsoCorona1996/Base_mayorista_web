import { DOCUMENT } from "@angular/common";
import { Injectable, NgZone, inject, signal } from "@angular/core";
import { Subject } from "rxjs";

export type PhysicalBarcodeMode = "add" | "packing";

const SCANNER_CONFIG = {
  minLength: 4,
  maxInterKeyDelayMs: 80,
  flushDelayMs: 120,
  duplicateWindowMs: 2000,
  suffixKeys: new Set(["Enter", "Tab"]),
};

@Injectable({ providedIn: "root" })
export class PhysicalBarcodeScannerService {
  private document = inject(DOCUMENT);
  private zone = inject(NgZone);
  private codeSubject = new Subject<string>();
  private activeModeState = signal<PhysicalBarcodeMode | null>(null);
  private lastCodeState = signal<string | null>(null);

  readonly codeScanned$ = this.codeSubject.asObservable();
  readonly activeMode = this.activeModeState.asReadonly();
  readonly lastCode = this.lastCodeState.asReadonly();

  private buffer = "";
  private lastKeyAt = 0;
  private fastKeyCount = 0;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private listening = false;
  private lastEmittedCode = "";
  private lastEmittedAt = 0;
  private editableSnapshot: {
    element: HTMLInputElement | HTMLTextAreaElement;
    value: string;
    selectionStart: number | null;
    selectionEnd: number | null;
  } | null = null;

  private readonly keydownListener = (event: KeyboardEvent) => this.onKeydown(event);

  start(mode: PhysicalBarcodeMode): void {
    this.clearBuffer();
    this.blurActiveEditableElement();
    this.activeModeState.set(mode);

    if (this.listening) return;
    this.listening = true;
    this.zone.runOutsideAngular(() => {
      this.document.addEventListener("keydown", this.keydownListener, true);
    });
  }

  stop(): void {
    if (this.listening) {
      this.document.removeEventListener("keydown", this.keydownListener, true);
    }
    this.listening = false;
    this.activeModeState.set(null);
    this.clearBuffer();
  }

  private onKeydown(event: KeyboardEvent): void {
    if (!this.activeModeState()) return;

    if (event.key === "Escape") {
      event.preventDefault();
      this.zone.run(() => this.stop());
      return;
    }

    if (event.ctrlKey || event.altKey || event.metaKey) {
      this.clearBuffer();
      return;
    }

    if (SCANNER_CONFIG.suffixKeys.has(event.key)) {
      if (this.isScannerLikeBuffer()) {
        event.preventDefault();
        this.restoreEditableSnapshot();
        this.emitBufferedCode();
        return;
      }
      this.clearBuffer();
      return;
    }

    if (event.key.length !== 1) return;

    const now = Date.now();
    const gap = this.lastKeyAt > 0 ? now - this.lastKeyAt : Number.POSITIVE_INFINITY;
    if (!this.buffer || gap > SCANNER_CONFIG.maxInterKeyDelayMs) {
      this.buffer = event.key;
      this.fastKeyCount = 1;
      this.editableSnapshot = this.snapshotEditableTarget(event.target);
    } else {
      this.buffer += event.key;
      this.fastKeyCount += 1;
      if (this.isScannerLikeBuffer()) {
        event.preventDefault();
        this.restoreEditableSnapshot();
      }
    }
    this.lastKeyAt = now;
    this.scheduleFlush();
  }

  private scheduleFlush(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = setTimeout(() => {
      if (this.isScannerLikeBuffer()) {
        this.restoreEditableSnapshot();
        this.emitBufferedCode();
        return;
      }
      this.clearBuffer();
    }, SCANNER_CONFIG.flushDelayMs);
  }

  private emitBufferedCode(): void {
    const code = this.buffer.trim();
    this.clearBuffer();
    if (!code || code.length < SCANNER_CONFIG.minLength) return;

    const now = Date.now();
    if (code === this.lastEmittedCode && now - this.lastEmittedAt < SCANNER_CONFIG.duplicateWindowMs) return;
    this.lastEmittedCode = code;
    this.lastEmittedAt = now;

    this.zone.run(() => {
      this.lastCodeState.set(code);
      this.codeSubject.next(code);
    });
  }

  private isScannerLikeBuffer(): boolean {
    return this.buffer.trim().length >= SCANNER_CONFIG.minLength
      && this.fastKeyCount >= SCANNER_CONFIG.minLength;
  }

  private clearBuffer(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    this.buffer = "";
    this.lastKeyAt = 0;
    this.fastKeyCount = 0;
    this.editableSnapshot = null;
  }

  private snapshotEditableTarget(target: EventTarget | null): PhysicalBarcodeScannerService["editableSnapshot"] {
    const element = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement ? target : null;
    if (!element || element.disabled || element.readOnly) return null;
    return {
      element,
      value: element.value,
      selectionStart: element.selectionStart,
      selectionEnd: element.selectionEnd,
    };
  }

  private restoreEditableSnapshot(): void {
    const snapshot = this.editableSnapshot;
    if (!snapshot) return;
    const { element, value, selectionStart, selectionEnd } = snapshot;
    if (element.value !== value) {
      element.value = value;
      if (selectionStart !== null && selectionEnd !== null) {
        try {
          element.setSelectionRange(selectionStart, selectionEnd);
        } catch {
          // Some input types do not support selection ranges.
        }
      }
      element.dispatchEvent(new Event("input", { bubbles: true }));
    }
    this.editableSnapshot = null;
  }

  private blurActiveEditableElement(): void {
    const active = this.document.activeElement;
    if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement || active instanceof HTMLSelectElement) {
      active.blur();
    }
  }
}
