import { defaultPdfMargins, normalizePdfMargins, type PdfMargins } from './export-preferences';

export interface ExportStyle {
  width: number;
  font: string;
  fontSize: number;
  lineHeight: number;
  foreground: string;
  background: string;
  link: string;
  wrap: boolean;
  margins: PdfMargins;
  minBox: number;
}

export function exportStyle(element: HTMLElement, width: number, wrap = true, margins: PdfMargins = defaultPdfMargins()): ExportStyle {
  const style = getComputedStyle(element);
  const fontSize = parseFloat(style.fontSize);
  const probe = document.createElement('span');
  probe.style.color = 'color-mix(in srgb, #4c8ce4 85%, var(--primary))';
  document.body.append(probe);
  const link = getComputedStyle(probe).color;
  probe.remove();
  return {
    width: Math.max(1, width), font: `${style.fontStyle} ${style.fontWeight} ${fontSize}px ${style.fontFamily}`,
    fontSize, lineHeight: parseFloat(style.lineHeight) || fontSize * 1.6,
    foreground: style.color, background: getComputedStyle(document.documentElement).getPropertyValue('--background').trim() || 'white',
    link, wrap, margins: normalizePdfMargins(margins),
    minBox: parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--min-box')) || 40
  };
}

