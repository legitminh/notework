export const pdfMarginSides = ['left', 'right', 'top', 'bottom'] as const;
export type PdfMarginSide = typeof pdfMarginSides[number];
export type PdfMargins = Record<PdfMarginSide, number>;
export const PDF_MARGINS_KEY = 'notework:pdf-margins';
export const defaultPdfMargins = (): PdfMargins => ({ left: 1, right: 1, top: 1, bottom: 1 });

export function normalizePdfMargins(value: unknown): PdfMargins {
  const margins = defaultPdfMargins();
  if (!value || typeof value !== 'object') return margins;
  for (const side of pdfMarginSides) {
    const candidate = (value as Partial<PdfMargins>)[side];
    if (typeof candidate === 'number' && Number.isFinite(candidate) && candidate >= 0) margins[side] = candidate;
  }
  return margins;
}

export function readPdfMargins(): PdfMargins {
  try { return normalizePdfMargins(JSON.parse(localStorage.getItem(PDF_MARGINS_KEY) ?? 'null')); }
  catch { return defaultPdfMargins(); }
}
