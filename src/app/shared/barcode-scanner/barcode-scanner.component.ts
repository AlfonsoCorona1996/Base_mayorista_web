import {
  AfterViewInit,
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  OnDestroy,
  ViewChild,
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
  closed = output<void>();

  status = signal("Preparando camara...");
  error = signal<string | null>(null);
  manualMode = signal(false);
  manualCode = signal("");
  running = signal(false);

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
