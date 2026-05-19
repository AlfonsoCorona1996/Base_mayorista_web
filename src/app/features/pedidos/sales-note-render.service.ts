import { Injectable } from "@angular/core";

export type SalesNoteRenderRow = {
  rowId: string;
  title: string;
  variant?: string | null;
  color?: string | null;
  qty: number;
  unitPrice: number;
  lineTotal: number;
  imageUrl?: string | null;
};

export type BuildSalesNoteImageInput = {
  orderId: string;
  customerName: string;
  rows: SalesNoteRenderRow[];
  discountAmount: number;
  balanceDue: number;
  date?: Date;
  logoUrl?: string;
  resolveRowImage?: (row: SalesNoteRenderRow) => Promise<HTMLImageElement | null>;
};

@Injectable({ providedIn: "root" })
export class SalesNoteRenderService {
  async buildSalesNoteImage(input: BuildSalesNoteImageInput): Promise<Blob> {
    const rows = input.rows || [];
    const subtotal = rows.reduce((sum, row) => sum + Number(row.lineTotal || 0), 0);
    const discount = Math.min(subtotal, Math.max(0, Number(input.discountAmount || 0)));
    const totalAmount = Math.max(0, subtotal - discount);
    const balanceRaw = Number(input.balanceDue);
    const balanceDue = Number.isFinite(balanceRaw) && balanceRaw >= 0 ? balanceRaw : totalAmount;

    const W = 1080;
    const CARD_X = 32;
    const CARD_Y = 34;
    const CARD_W = W - CARD_X * 2;
    const PAD_H = 52;
    const PAD_TOP = 48;
    const PAD_BOT = 52;
    const IX = CARD_X + PAD_H;
    const IW = CARD_W - PAD_H * 2;
    const IR = IX + IW;

    const HDR_H = 230;
    const HDR_GAP = 8;
    const DATE_H = 72;
    const DIV1_PRE = 28;
    const LBL_H = 26;
    const LBL_GAP = 8;
    const CNAME_H = 88;
    const DIV2_PRE = 28;
    const ITEMS_PRE = 24;
    const ITEM_H = 114;
    const ITEM_GAP = 14;
    const TOTL_PRE = 30;
    const TOTL_H = 150;

    const itemsH = rows.length > 0
      ? rows.length * ITEM_H + (rows.length - 1) * ITEM_GAP
      : 0;

    const CARD_H = PAD_TOP
      + HDR_H + HDR_GAP + DATE_H
      + DIV1_PRE + 1 + 22
      + LBL_H + LBL_GAP + CNAME_H
      + DIV2_PRE + 1 + ITEMS_PRE
      + itemsH
      + TOTL_PRE + 1 + 26
      + TOTL_H
      + PAD_BOT;
    const H = CARD_Y * 2 + CARD_H;

    const canvas = document.createElement("canvas");
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("No se pudo crear el lienzo para la nota.");

    const rowImages = await this.resolveRowImages(rows, input.resolveRowImage);
    const logoImage = await this.loadImageElement(input.logoUrl || "/BaseMayoristaLogo.png", false, 4000).catch(() => null);

    ctx.fillStyle = "#eef2f7";
    ctx.fillRect(0, 0, W, H);
    this.drawRoundedRect(ctx, CARD_X, CARD_Y, CARD_W, CARD_H, 32, "#ffffff");
    ctx.fill();

    let y = CARD_Y + PAD_TOP;

    const LOGO_SIZE = 216;
    const logoY = y + (HDR_H - LOGO_SIZE) / 2;
    if (logoImage) {
      ctx.save();
      this.drawRoundedRect(ctx, IX, logoY, LOGO_SIZE, LOGO_SIZE, 20, "#f5f8fc");
      ctx.clip();
      this.drawImageCover(ctx, logoImage, IX, logoY, LOGO_SIZE, LOGO_SIZE);
      ctx.restore();
    }

    ctx.globalAlpha = 0.55;
    ctx.fillStyle = "#7a94ae";
    ctx.font = "500 21px -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
    ctx.textAlign = "right";
    ctx.fillText(`#${input.orderId}`, IR, y + Math.round(HDR_H / 2) + 8);
    ctx.globalAlpha = 1;

    y += HDR_H + HDR_GAP;

    const dateValue = input.date instanceof Date ? input.date : new Date();
    const dateText = dateValue.toLocaleDateString("es-MX", {
      year: "numeric",
      month: "long",
      day: "numeric",
    });
    const row2Baseline = y + 62;

    ctx.fillStyle = "#6b87a4";
    ctx.font = "600 60px -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
    ctx.textAlign = "left";
    ctx.fillText("Nota de venta", IX, row2Baseline);

    ctx.fillStyle = "#9badc5";
    ctx.font = "400 26px -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
    ctx.textAlign = "right";
    ctx.fillText(dateText, IR, row2Baseline);

    y += DATE_H;

    y += DIV1_PRE;
    ctx.fillStyle = "#e8eef6";
    ctx.fillRect(IX, y, IW, 1);
    y += 1 + 22;

    ctx.fillStyle = "#b0c4d8";
    ctx.font = "600 21px -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
    ctx.textAlign = "left";
    ctx.fillText("CLIENTE", IX, y + LBL_H);
    y += LBL_H + LBL_GAP;

    const CNAME_FONT = "700 72px -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
    ctx.fillStyle = "#0f172a";
    ctx.font = CNAME_FONT;
    ctx.fillText(this.truncateForNote(ctx, input.customerName || "Cliente sin nombre", IW, CNAME_FONT), IX, y + 72);
    y += CNAME_H;

    y += DIV2_PRE;
    ctx.fillStyle = "#e8eef6";
    ctx.fillRect(IX, y, IW, 1);
    y += 1 + ITEMS_PRE;

    const IMG_SIZE = 80;
    const TEXT_X = IX + IMG_SIZE + 20;
    const TEXT_W = IW - IMG_SIZE - 20 - 220;

    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      const image = rowImages[index];
      const imgY = y + (ITEM_H - IMG_SIZE) / 2;

      if (image) {
        ctx.save();
        this.drawRoundedRect(ctx, IX, imgY, IMG_SIZE, IMG_SIZE, 14, "#f5f8fc");
        ctx.clip();
        this.drawImageCover(ctx, image, IX, imgY, IMG_SIZE, IMG_SIZE);
        ctx.restore();
      } else {
        this.drawRoundedRect(ctx, IX, imgY, IMG_SIZE, IMG_SIZE, 14, "#f0f4fa");
        ctx.fillStyle = "#f0f4fa";
        ctx.fill();
        ctx.fillStyle = "#a8bed4";
        ctx.font = "600 22px -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
        ctx.textAlign = "center";
        ctx.fillText((row.title || "?").slice(0, 2).toUpperCase(), IX + (IMG_SIZE / 2), imgY + (IMG_SIZE / 2) + 8);
        ctx.textAlign = "left";
      }

      const TITLE_FONT = "600 29px -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
      ctx.fillStyle = "#0f172a";
      ctx.font = TITLE_FONT;
      ctx.textAlign = "left";
      ctx.fillText(this.truncateForNote(ctx, row.title || "Producto", TEXT_W, TITLE_FONT), TEXT_X, y + 42);

      const variantText = [row.variant, row.color]
        .map((part) => String(part || "").trim())
        .filter(Boolean)
        .join(" · ");
      if (variantText) {
        const VAR_FONT = "400 23px -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
        ctx.fillStyle = "#7a94ae";
        ctx.font = VAR_FONT;
        ctx.fillText(this.truncateForNote(ctx, variantText, TEXT_W, VAR_FONT), TEXT_X, y + 74);
      }

      ctx.fillStyle = "#8fabbe";
      ctx.font = "400 24px -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
      ctx.textAlign = "right";
      ctx.fillText(`${row.qty} × ${this.formatCurrency(row.unitPrice)}`, IR, y + 50);

      ctx.fillStyle = "#1a2e44";
      ctx.font = "700 32px -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
      ctx.fillText(this.formatCurrency(row.lineTotal), IR, y + 86);

      y += ITEM_H + ITEM_GAP;
    }
    y -= ITEM_GAP;

    y += TOTL_PRE;
    ctx.fillStyle = "#e8eef6";
    ctx.fillRect(IX, y, IW, 1);
    y += 1 + 26;

    const subtotalRowY = y + 30;
    ctx.fillStyle = "#7a94ae";
    ctx.font = "600 24px -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
    ctx.textAlign = "left";
    ctx.fillText("Subtotal", IX, subtotalRowY);
    ctx.textAlign = "right";
    ctx.fillText(this.formatCurrency(subtotal), IR, subtotalRowY);

    const discountRowY = subtotalRowY + 30;
    ctx.fillStyle = "#dc2626";
    ctx.font = "700 24px -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
    ctx.textAlign = "left";
    ctx.fillText("Desc", IX, discountRowY);
    ctx.textAlign = "right";
    ctx.fillText(`-${this.formatCurrency(discount)}`, IR, discountRowY);

    const balanceLabelY = discountRowY + 34;
    ctx.fillStyle = "#7a94ae";
    ctx.font = "600 30px -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
    ctx.textAlign = "left";
    ctx.fillText("Por pagar", IX, balanceLabelY);

    ctx.fillStyle = "#0f172a";
    ctx.font = "700 66px -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
    ctx.textAlign = "right";
    ctx.fillText(this.formatCurrency(balanceDue), IR, balanceLabelY + 34);

    return new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((blob) => {
        if (!blob) {
          reject(new Error("No se pudo exportar la nota."));
          return;
        }
        resolve(blob);
      }, "image/png");
    });
  }

  private async resolveRowImages(
    rows: SalesNoteRenderRow[],
    resolver?: (row: SalesNoteRenderRow) => Promise<HTMLImageElement | null>,
  ): Promise<Array<HTMLImageElement | null>> {
    if (!resolver) {
      return Promise.all(rows.map((row) => this.loadImageElement(String(row.imageUrl || ""), true, 7000).catch(() => null)));
    }
    return Promise.all(rows.map((row) => resolver(row)));
  }

  private loadImageElement(url: string, withCrossOrigin: boolean, timeoutMs = 6000): Promise<HTMLImageElement | null> {
    const normalized = String(url || "").trim();
    if (!normalized) return Promise.resolve(null);

    return new Promise((resolve, reject) => {
      const image = new Image();
      let done = false;
      const timer = setTimeout(() => {
        if (done) return;
        done = true;
        reject(new Error("image_timeout"));
      }, Math.max(1000, Math.trunc(timeoutMs || 0)));

      if (withCrossOrigin) {
        image.crossOrigin = "anonymous";
        image.referrerPolicy = "no-referrer";
      }

      image.onload = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(image);
      };
      image.onerror = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        reject(new Error("image_load_failed"));
      };
      image.src = normalized;
    });
  }

  private drawRoundedRect(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    width: number,
    height: number,
    radius: number,
    fillStyle: string,
  ): void {
    const r = Math.max(0, Math.min(radius, width / 2, height / 2));
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + width, y, x + width, y + height, r);
    ctx.arcTo(x + width, y + height, x, y + height, r);
    ctx.arcTo(x, y + height, x, y, r);
    ctx.arcTo(x, y, x + width, y, r);
    ctx.closePath();
    ctx.fillStyle = fillStyle;
  }

  private truncateForNote(ctx: CanvasRenderingContext2D, value: string, maxWidth: number, font: string): string {
    ctx.font = font;
    if (ctx.measureText(value).width <= maxWidth) return value;
    let text = value;
    while (text.length > 0 && ctx.measureText(`${text}...`).width > maxWidth) {
      text = text.slice(0, -1);
    }
    return text ? `${text}...` : "...";
  }

  private drawImageCover(
    ctx: CanvasRenderingContext2D,
    image: CanvasImageSource & { naturalWidth?: number; naturalHeight?: number; width?: number; height?: number },
    dx: number,
    dy: number,
    dw: number,
    dh: number,
  ): void {
    const sourceWidth = Number(image.naturalWidth || image.width || 0);
    const sourceHeight = Number(image.naturalHeight || image.height || 0);
    if (sourceWidth <= 0 || sourceHeight <= 0) {
      ctx.drawImage(image as CanvasImageSource, dx, dy, dw, dh);
      return;
    }

    const scale = Math.max(dw / sourceWidth, dh / sourceHeight);
    const cropWidth = dw / scale;
    const cropHeight = dh / scale;
    const sx = Math.max(0, (sourceWidth - cropWidth) / 2);
    const sy = Math.max(0, (sourceHeight - cropHeight) / 2);

    ctx.drawImage(image as CanvasImageSource, sx, sy, cropWidth, cropHeight, dx, dy, dw, dh);
  }

  private formatCurrency(value: number): string {
    return new Intl.NumberFormat("es-MX", {
      style: "currency",
      currency: "MXN",
      maximumFractionDigits: 2,
    }).format(Number(value || 0));
  }
}
