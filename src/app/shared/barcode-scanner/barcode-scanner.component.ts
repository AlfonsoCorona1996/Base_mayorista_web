import {
  AfterViewInit,
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  OnDestroy,
  ViewChild,
  input,
  output,
  signal,
} from "@angular/core";
import { FormsModule } from "@angular/forms";
import { BrowserMultiFormatReader, IScannerControls } from "@zxing/browser";
import { BarcodeFormat, DecodeHintType } from "@zxing/library";

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  standalone: true,
  selector: "app-barcode-scanner",
  imports: [FormsModule],
  templateUrl: "./barcode-scanner.component.html",
  styleUrl: "./barcode-scanner.component.css",
})
export class BarcodeScannerComponent implements AfterViewInit, OnDestroy {
  @ViewChild("video", { static: true }) videoRef?: ElementRef<HTMLVideoElement>;

  codeScanned = output<string>();
  printedCodeScanned = output<string>();
  closed = output<void>();
  ocrFallbackAvailable = input(false);

  status = signal("Preparando camara...");
  error = signal<string | null>(null);
  manualMode = signal(false);
  manualCode = signal("");
  running = signal(false);
  ocrReading = signal(false);

  private reader: BrowserMultiFormatReader | null = null;
  private controls: IScannerControls | null = null;
  private lastCode = "";
  private lastCodeAt = 0;

  ngAfterViewInit(): void {
    void this.start();
  }

  ngOnDestroy(): void {
    this.stop();
  }

  async start(): Promise<void> {
    if (this.running()) return;
    this.error.set(null);
    this.status.set("Solicitando permiso de camara...");

    if (!this.isCameraSupported()) {
      this.error.set("Este navegador no permite usar la camara desde la web.");
      return;
    }

    const video = this.videoRef?.nativeElement;
    if (!video) {
      this.error.set("No se pudo iniciar la vista previa de camara.");
      return;
    }

    const hints = new Map<DecodeHintType, unknown>();
    hints.set(DecodeHintType.POSSIBLE_FORMATS, [
      BarcodeFormat.EAN_13,
      BarcodeFormat.EAN_8,
      BarcodeFormat.UPC_A,
      BarcodeFormat.UPC_E,
      BarcodeFormat.CODE_128,
      BarcodeFormat.QR_CODE,
    ]);

    this.reader = new BrowserMultiFormatReader(hints, {
      delayBetweenScanAttempts: 120,
      delayBetweenScanSuccess: 250,
      tryPlayVideoTimeout: 8000,
    });

    try {
      this.controls = await this.reader.decodeFromConstraints(
        {
          audio: false,
          video: {
            facingMode: { ideal: "environment" },
            width: { ideal: 1280 },
            height: { ideal: 720 },
          },
        },
        video,
        (result, scanError) => {
          if (result) {
            this.handleCode(result.getText());
            return;
          }
          if (scanError && !this.isExpectedScanMiss(scanError)) {
            this.status.set("Apunta al codigo y manten el telefono estable.");
          }
        },
      );
      this.running.set(true);
      this.status.set("Apunta la camara al codigo.");
    } catch (err) {
      this.error.set(this.cameraErrorMessage(err));
      this.running.set(false);
      this.stop();
    }
  }

  stop(): void {
    this.controls?.stop();
    this.controls = null;
    this.reader = null;
    this.running.set(false);
    const video = this.videoRef?.nativeElement;
    if (video) {
      video.pause();
      video.srcObject = null;
    }
  }

  close(): void {
    this.stop();
    this.closed.emit();
  }

  showManualEntry(): void {
    this.manualMode.set(true);
    this.status.set("Ingresa el codigo del producto.");
  }

  submitManual(): void {
    const code = this.manualCode().trim();
    if (!code) return;
    this.handleCode(code, true);
  }

  async readPrintedCode(): Promise<void> {
    if (this.ocrReading()) return;
    const video = this.videoRef?.nativeElement;
    if (!video || !video.videoWidth || !video.videoHeight) {
      this.error.set("No se pudo capturar la imagen de camara.");
      return;
    }

    this.ocrReading.set(true);
    this.error.set(null);
    this.status.set("Leyendo numero inferior...");

    let worker: Awaited<ReturnType<typeof import("tesseract.js")["createWorker"]>> | null = null;
    try {
      const tesseract = await import("tesseract.js");
      worker = await tesseract.createWorker("eng", undefined, {
        logger: (message) => {
          if (message.status === "recognizing text") {
            const progress = Math.round((message.progress || 0) * 100);
            this.status.set(`Leyendo numero inferior... ${progress}%`);
          }
        },
      });
      await worker.setParameters({
        tessedit_char_whitelist: "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz-",
        tessedit_pageseg_mode: tesseract.PSM.SPARSE_TEXT,
        preserve_interword_spaces: "1",
      });

      const candidates = await this.ocrCandidatesFromVideo(worker, video);
      const code = this.pickBestOcrCode(candidates.join("\n"));
      if (!code) {
        this.status.set("No se pudo leer el numero inferior. Intenta con mas luz o ingresalo manualmente.");
        return;
      }

      this.status.set(`Numero detectado: ${code}`);
      this.printedCodeScanned.emit(code);
    } catch (err) {
      this.error.set("No se pudo leer el numero inferior. Intenta de nuevo o ingresalo manualmente.");
    } finally {
      await worker?.terminate().catch(() => null);
      this.ocrReading.set(false);
    }
  }

  private handleCode(rawCode: string, manual = false): void {
    const code = rawCode.trim();
    if (!code) return;

    const now = Date.now();
    if (!manual && code === this.lastCode && now - this.lastCodeAt < 2000) return;
    this.lastCode = code;
    this.lastCodeAt = now;
    this.status.set(`Codigo detectado: ${code}`);
    this.codeScanned.emit(code);
  }

  private async ocrCandidatesFromVideo(worker: Awaited<ReturnType<typeof import("tesseract.js")["createWorker"]>>, video: HTMLVideoElement): Promise<string[]> {
    const crops = [
      this.captureVideoCrop(video, 0.06, 0.48, 0.88, 0.34),
      this.captureVideoCrop(video, 0.04, 0.34, 0.92, 0.52),
    ];
    const out: string[] = [];
    for (const canvas of crops) {
      const result = await worker.recognize(canvas);
      const text = String(result.data?.text || "").trim();
      if (text) out.push(text);
      if (this.pickBestOcrCode(text)) break;
    }
    return out;
  }

  private captureVideoCrop(video: HTMLVideoElement, xRatio: number, yRatio: number, widthRatio: number, heightRatio: number): HTMLCanvasElement {
    const sourceW = video.videoWidth;
    const sourceH = video.videoHeight;
    const sx = Math.max(0, Math.round(sourceW * xRatio));
    const sy = Math.max(0, Math.round(sourceH * yRatio));
    const sw = Math.min(sourceW - sx, Math.round(sourceW * widthRatio));
    const sh = Math.min(sourceH - sy, Math.round(sourceH * heightRatio));
    const scale = Math.min(2, Math.max(1, 1400 / Math.max(sw, 1)));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(sw * scale));
    canvas.height = Math.max(1, Math.round(sh * scale));
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return canvas;
    ctx.filter = "grayscale(1) contrast(1.85) brightness(1.08)";
    ctx.drawImage(video, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
    return canvas;
  }

  private pickBestOcrCode(text: string): string {
    const normalizedText = text
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toUpperCase();
    const candidates: string[] = normalizedText.match(/[A-Z0-9][A-Z0-9-]{3,}/g) || [];
    const digitsOnly = normalizedText.replace(/\D/g, "");
    if (digitsOnly.length >= 4) candidates.push(digitsOnly);
    return candidates
      .map((candidate) => candidate.replace(/^-+|-+$/g, ""))
      .filter((candidate) => candidate.length >= 4)
      .sort((a, b) => b.length - a.length)[0] || "";
  }

  private isCameraSupported(): boolean {
    return typeof navigator !== "undefined" && !!navigator.mediaDevices?.getUserMedia;
  }

  private isExpectedScanMiss(error: unknown): boolean {
    const name = String((error as { name?: string })?.name || "");
    return name === "NotFoundException" || name === "ChecksumException" || name === "FormatException";
  }

  private cameraErrorMessage(error: unknown): string {
    const name = String((error as { name?: string })?.name || "");
    if (name === "NotAllowedError" || name === "PermissionDeniedError") {
      return "No hay permiso de camara. Activalo en los permisos del navegador e intenta de nuevo.";
    }
    if (name === "NotFoundError" || name === "DevicesNotFoundError") {
      return "No encontramos una camara disponible en este dispositivo.";
    }
    if (typeof window !== "undefined" && window.location.protocol !== "https:" && window.location.hostname !== "localhost") {
      return "La camara requiere HTTPS. Abre la app instalada o usa una URL segura.";
    }
    return "No se pudo iniciar la camara. Revisa permisos y vuelve a intentar.";
  }
}
