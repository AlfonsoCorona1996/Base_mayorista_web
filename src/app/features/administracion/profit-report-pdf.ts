import { PDFDocument, PDFFont, PDFPage, StandardFonts, rgb } from 'pdf-lib';
import { AuditMovement, AuditOrderRow, ProfitAudit, auditPartners } from '../../core/profit-audit';
import { ProfitReportSelection } from '../../core/profit-report';

export interface ProfitPdfInput {
  selection: ProfitReportSelection;
  history: ProfitAudit;
  business: string;
  context: string;
  customers: Record<string, string>;
  accounts: Record<string, string>;
  includeProducts: boolean;
  generatedAt: Date;
}

/** Local PDF generation: no customer or financial data leaves the browser. */
export async function createProfitReportPdf(input: ProfitPdfInput): Promise<Uint8Array> {
  if (input.selection.error) throw new Error(input.selection.error);
  const doc = await PDFDocument.create();
  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const ink = rgb(.09, .13, .2), muted = rgb(.32, .38, .46), blue = rgb(.14, .34, .65);
  const line = rgb(.86, .89, .93), tint = rgb(.94, .96, .99);
  const width = 792, height = 612, margin = 32, contentWidth = width - margin * 2;
  const currency = (n: number) => new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN' }).format(n);
  const customer = (r: AuditOrderRow) => input.customers[r.customerId] || r.customerId || 'Clienta sin identificar';
  const movement = (r: AuditMovement) => r.partner === 'socio_blanca' ? 'Retiro: Blanca Trejo'
    : r.partner === 'socio_andrea_pepe' ? 'Retiro: Andrea y Pepe'
      : ({ expense: 'Gasto operativo', capital: 'Compra de mercancía', withdrawal: 'Retiro', unclassified: 'Por clasificar' })[r.kind];
  // Helvetica supports Spanish/WinAnsi. Preserve other characters as explicit Unicode codes.
  const clean = (text: string) => [...text.replace(/\s+/g, ' ').trim()].map(c => {
    try { regular.encodeText(c); return c; } catch { return `[U+${c.codePointAt(0)!.toString(16).toUpperCase()}]`; }
  }).join('');
  const wrap = (value: string, max: number, size: number, font: PDFFont = regular): string[] => {
    const lines: string[] = []; let current = '';
    for (const word of clean(value).split(' ')) {
      if (current && font.widthOfTextAtSize(`${current} ${word}`, size) > max) { lines.push(current); current = ''; }
      for (const char of (current ? ' ' : '') + word) {
        if (font.widthOfTextAtSize(current + char, size) > max && current) { lines.push(current); current = ''; }
        current += char;
      }
    }
    if (current || !lines.length) lines.push(current);
    return lines;
  };
  let page: PDFPage;
  let y = 0;
  let section = '';
  const draw = (text: string, x: number, baseline: number, size = 9, font = regular, color = ink) =>
    page.drawText(clean(text), { x, y: baseline, size, font, color });
  const newPage = () => {
    page = doc.addPage([width, height]);
    draw('INFORME PARA SOCIOS', margin, height - 30, 9, bold, blue);
    let headerY = height - 46;
    for (const text of wrap(`${input.business} · ${input.context} · ${input.selection.label}`, contentWidth, 9, bold)) {
      draw(text, margin, headerY, 9, bold); headerY -= 12;
    }
    page.drawLine({ start: { x: margin, y: headerY + 3 }, end: { x: width - margin, y: headerY + 3 }, color: line });
    y = headerY - 17;
    if (section) {
      for (const title of wrap(section, contentWidth, 12, bold)) { draw(title, margin, y, 12, bold, blue); y -= 17; }
      y -= 5;
    }
  };
  const ensure = (space: number) => { if (y - space < 40) newPage(); };
  const paragraph = (text: string, options: { bold?: boolean; size?: number } = {}) => {
    const size = options.size || 9, font = options.bold ? bold : regular;
    for (const textLine of wrap(text, contentWidth, size, font)) {
      ensure(size + 5); draw(textLine, margin, y, size, font, options.bold ? ink : muted); y -= size + 5;
    }
    y -= 5;
  };
  const startSection = (title: string) => { section = title; newPage(); };
  const table = (headers: string[], widths: number[], rows: string[][], fontSize = 8.5) => {
    const lineHeight = fontSize + 3;
    const headerLines = headers.map((h, i) => wrap(h, widths[i] - 12, fontSize, bold));
    const headerHeight = Math.max(...headerLines.map(h => h.length)) * lineHeight + 12;
    const header = () => {
      page.drawRectangle({ x: margin, y: y - headerHeight, width: contentWidth, height: headerHeight, color: tint });
      let x = margin;
      headerLines.forEach((lines, i) => { lines.forEach((l, n) => draw(l, x + 6, y - 11 - n * lineHeight, fontSize, bold)); x += widths[i]; });
      y -= headerHeight;
    };
    ensure(headerHeight + 35); header();
    rows.forEach((row) => {
      const cells = row.map((cell, i) => wrap(cell, widths[i] - 12, fontSize));
      const count = Math.max(...cells.map(c => c.length));
      const totalHeight = count * lineHeight + 12;
      // Keep ordinary rows intact; exceptionally long notes continue with repeated headers.
      if (y - totalHeight < 40 && totalHeight < 380) { newPage(); header(); }
      let offset = 0;
      while (offset < count) {
        if (y - lineHeight - 12 < 40) { newPage(); header(); }
        const capacity = Math.max(1, Math.floor((y - 40 - 12) / lineHeight));
        const length = Math.min(count - offset, capacity);
        let x = margin;
        cells.forEach((lines, i) => {
          lines.slice(offset, offset + length).forEach((l, n) => draw(l, x + 6, y - 11 - n * lineHeight, fontSize)); x += widths[i];
        });
        y -= length * lineHeight + 12;
        page.drawLine({ start: { x: margin, y }, end: { x: width - margin, y }, color: line, thickness: .5 });
        offset += length;
      }
    });
    y -= 14;
  };
  const s = input.selection, t = s.totals;
  const provisional = s.orders.some(o => o.issues.length && !o.excluded) || s.movements.some(m => m.issues.length);
  doc.setTitle(`Informe de utilidades · ${input.business} · ${s.label}`);
  doc.setSubject('Ventas por creación del pedido y cobranza acumulada a la emisión');
  doc.setCreator('Base Mayorista'); doc.setCreationDate(input.generatedAt); doc.setModificationDate(input.generatedAt);
  startSection('01 / Resultados del periodo');
  paragraph(`Emitido: ${input.generatedAt.toLocaleString('es-MX', { timeZone: 'America/Mexico_City' })} · Ciudad de México · Importes en MXN.`);
  paragraph(`${s.orders.length} pedidos y ${s.movements.length} movimientos incluidos. ${provisional ? 'RESULTADOS PROVISIONALES: hay datos incompletos o estimados; consulta el anexo.' : 'Resultados calculados con los registros disponibles.'}`, { bold: true });
  table(['Concepto', 'Generado / total', 'Cobrado a la emisión', 'Pendiente de cobro'], [268, 150, 155, 155], [
    ['Venta a precio clienta', currency(t.sale), currency(t.collected), currency(t.pending)],
    ['Costo de mercancía (parcial si faltan datos)', currency(t.cost), 'No aplica', 'No aplica'],
    ['Utilidad de ventas, antes de gastos', currency(t.profit), currency(t.collectedProfit), currency(t.pendingProfit)],
    ['Gastos operativos', currency(t.expenses), 'No aplica', 'No aplica'],
    ['UTILIDAD NETA GENERADA', currency(t.netProfit), 'No equivale a efectivo disponible', 'La cobranza se informa arriba'],
  ], 10);
  paragraph('Los pedidos se seleccionan por fecha de creación; gastos y retiros, por fecha del movimiento. El cobro es el acumulado actual de esos pedidos, incluso si ocurrió después del periodo. Este informe no es un cierre histórico de caja.');
  paragraph(`Devoluciones ya descontadas: ${currency(s.orders.reduce((n, r) => n + r.returnedSale, 0))}. Cobros excedentes por revisar: ${currency(s.orders.reduce((n, r) => n + r.overpayment, 0))}. Compras de mercancía: ${currency(t.capital)} (no se descuentan dos veces). Movimientos por clasificar: ${currency(t.unclassified)}.`);
  if (s.undatedOrders.length || s.undatedMovements.length) paragraph(`SIN FECHA: ${s.undatedOrders.length} pedidos y ${s.undatedMovements.length} movimientos no pueden asignarse al periodo. Se incluyen en un anexo separado, fuera de estos totales.`, { bold: true });

  startSection('02 / Participación y retiros');
  paragraph('Actividad del periodo seleccionado', { bold: true, size: 11 });
  table(['Socio', '50% de utilidad neta del periodo', 'Retiros ocurridos en el periodo', 'Parte de utilidad de ventas por cobrar'], [188, 180, 180, 180], auditPartners(t).map(p => [p.name, currency(p.share), currency(p.withdrawn), currency(p.pendingCollection)]), 10);
  paragraph('Los retiros del periodo pueden corresponder a ganancias de meses anteriores. No se presentan como saldo pendiente de este periodo.');
  paragraph('Saldos históricos actuales · mismo negocio y ruta · todos los meses', { bold: true, size: 11 });
  table(['Socio', 'Ha ganado', 'Ha retirado', 'Falta por retirar / saldo', 'Ganancia por cobrar'], [168, 140, 140, 140, 140], auditPartners(input.history.totals).map(p => [p.name, currency(p.share), currency(p.withdrawn), p.remaining < 0 ? `${currency(-p.remaining)} a compensar` : currency(p.remaining), currency(p.pendingCollection)]), 9);
  paragraph('Falta por retirar = participación en la utilidad neta histórica menos retiros registrados. La ganancia por cobrar es informativa: NO se vuelve a restar del saldo por retirar. Estos saldos no representan efectivo disponible ni saldos al final del periodo seleccionado.');
  if (input.history.issueCount) paragraph(`El historial contiene ${input.history.issueCount} registros por revisar; sus saldos también son provisionales.`, { bold: true });

  const orderLedger = (orders: AuditOrderRow[]) => {
    if (!orders.length) { paragraph('No hay pedidos en esta selección.'); return; }
    table(['Pedido / clienta / estado', 'Creación', 'Venta', 'Costo', 'Cobrado', 'Venta por cobrar', 'Utilidad', 'Utilidad cobrada', 'Utilidad por cobrar'],
      [180, 66, 68, 68, 68, 68, 70, 70, 70], orders.map(r => [
        `${r.id} · ${customer(r)} · ${r.status}${r.incomplete ? ' · INCOMPLETO' : ''}${r.estimatedItems ? ' · Costo estimado' : ''}`,
        r.date || 'Sin fecha', currency(r.sale), `${currency(r.cost)}${r.incomplete ? ' parcial' : ''}`, currency(r.collected), currency(r.pending),
        r.incomplete ? 'Sin determinar' : currency(r.profit), r.incomplete ? 'Sin determinar' : currency(r.collectedProfit), r.incomplete ? 'Sin determinar' : currency(r.pendingProfit),
      ]), 8);
  };
  startSection('03 / Pedidos del periodo'); orderLedger(s.orders);
  const movementLedger = (movements: AuditMovement[]) => {
    if (!movements.length) { paragraph('No hay movimientos en esta selección.'); return; }
    table(['Fecha / referencia / origen', 'Tipo / categoría', 'Concepto / cuenta / observaciones', 'Importe'], [172, 154, 300, 102], movements.map(r => [
      `${r.date || 'Sin fecha'} · ${r.id} · ${r.source === 'expense' ? 'Registro de gasto' : 'Registro de retiro'}`,
      `${movement(r)} · ${r.category}`, `${r.notes || 'Sin concepto'} · ${r.accountId ? input.accounts[r.accountId] || r.accountId : 'Cuenta sin identificar'}${r.issues.length ? ' · ' + r.issues.join(' · ') : ''}`, currency(r.amount),
    ]));
  };
  startSection('04 / Gastos, retiros y otros movimientos'); movementLedger(s.movements);
  startSection('05 / Trazabilidad de pedidos y pagos');
  paragraph('El pago mostrado es el importe acumulado del pedido, no un desglose de abonos individuales. La fecha de pago corresponde al dato guardado; las fechas históricas normalizadas se identifican como estimadas. Los pedidos incompletos conservan su venta conocida y su utilidad queda sin determinar.');
  for (const r of s.orders) {
    section = `05 / Trazabilidad del pedido ${r.id}`;
    ensure(90);
    paragraph(`${r.id} · ${customer(r)} · Creado: ${r.date || 'Sin fecha'} · ${r.status}`, { bold: true, size: 10 });
    paragraph(`Venta ${currency(r.sale)} · Costo ${currency(r.cost)}${r.incomplete ? ' (parcial)' : ''} · Utilidad ${r.incomplete ? 'sin determinar' : currency(r.profit)}. Cobrado ${currency(r.collected)} · Venta pendiente ${currency(r.pending)}.`);
    paragraph(`Fecha de pago: ${r.paymentDate || 'Sin fecha registrada'}${r.paymentDateEstimated ? ' (ESTIMADA a partir de la creación; normalización histórica)' : ''}. Descuento ${currency(r.discount)} · Envío ${currency(r.shipping)} · Devoluciones ${currency(r.returnedSale)} · Cobro excedente ${currency(r.overpayment)}.`);
    if (r.recordedSale !== null && r.recordedSale !== r.sale) paragraph(`Total original guardado: ${currency(r.recordedSale)}. El reporte utiliza el cálculo vigente por productos.`);
    for (const issue of r.issues) paragraph(`Observación: ${issue}`);
    if (input.includeProducts) {
      if (!r.items.length) paragraph('Sin productos registrados.');
      else table(['Producto', 'Unidades / devueltas', 'Precio clienta', 'Costo unitario / origen', 'Venta vigente', 'Costo total'], [248, 80, 90, 130, 90, 90], r.items.map(i => [i.title, `${i.quantity} / ${i.returned}`, i.client === null ? 'Sin dato' : currency(i.client), `${i.cost === null ? 'Sin dato' : currency(i.cost)} · ${i.costSource === 'estimated' ? 'Estimado: público / 2' : i.costSource === 'missing' ? 'Por completar' : 'Registrado'}`, currency(i.sale), currency(i.totalCost)]));
    }
  }
  if (s.undatedOrders.length || s.undatedMovements.length) {
    startSection('06 / Sin fecha: fuera de los totales del periodo');
    paragraph('Se conservan estos registros para revisión. No se les asigna una fecha supuesta ni se suman a los resultados del periodo seleccionado.');
    orderLedger(s.undatedOrders); movementLedger(s.undatedMovements);
    for (const r of s.undatedOrders) paragraph(`${r.id}: ${r.issues.join(' · ') || 'Fecha de creación pendiente de verificar'}`);
  }
  startSection('Criterios de lectura');
  [
    'Venta: precio clienta por unidades vigentes, menos descuentos y más envío. Incluye pedidos en proceso. Las cancelaciones y devoluciones actualizan el pedido original; los registros permanecen en el detalle.',
    'Costo: costo registrado por unidad. Si falta, se estima como precio público / 2. Un costo cero explícito se respeta. Los faltantes sin estimación posible no se consideran ceros confirmados. Se conservan los costos de devoluciones dañadas.',
    'Utilidad de venta: venta menos costo. Utilidad neta: utilidad de venta menos gastos operativos. Los retiros de socios y las compras de mercancía se muestran separados de los gastos para evitar dobles descuentos.',
    'Utilidad cobrada: asignación proporcional del margen según cobrado / venta. El cobro se limita a la venta vigente; los excedentes se informan por separado. No mide dinero en bancos ni liquidez disponible.',
    'Participación: 50% por socio sobre la utilidad neta. Diferencias de un centavo pueden corresponder al redondeo. Los movimientos sin destino explícito requieren clasificación antes de descontarse de un socio o del resultado.',
    'Fechas: calendario de Ciudad de México, límites incluidos. El PDF contiene todos los registros del periodo, sin aplicar búsqueda, paginación ni filtro de socio de la pantalla. Los registros sin fecha se conservan en un anexo cuando no pueden asignarse al periodo.',
    'Trazabilidad: usa la referencia del pedido o movimiento para localizarlo en Administración. El informe refleja los datos disponibles al emitirlo; pagos, devoluciones y correcciones posteriores pueden cambiar los resultados. No sustituye un cierre contable congelado.',
  ].forEach(text => paragraph(text));
  const pages = doc.getPages();
  pages.forEach((p, i) => {
    page = p;
    draw('MXN · Ventas por creación · Cobranza acumulada a la emisión', margin, 20, 8, regular, muted);
    draw(`${i + 1} / ${pages.length}`, width - margin - 55, 20, 8, regular, muted);
  });
  return doc.save();
}
