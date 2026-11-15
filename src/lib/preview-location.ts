import type { Point } from './drawing';

/** Document positions and drawing units survive changes in editor layout. */
export type PreviewLocation =
  | { kind: 'text'; position: number }
  | { kind: 'drawing'; point: Point }
  | { kind: 'inline-drawing'; from: number; point: Point };
