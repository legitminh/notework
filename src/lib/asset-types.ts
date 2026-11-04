import { serializeDrawing } from './drawing';

export interface AssetType {
  id: string;
  label: string;
  kind: 'file' | 'directory';
  extension?: string;
  initialContent?: () => string | Uint8Array;
}

// Creation UI and resource initialization both use this registry.
export const assetTypes: readonly AssetType[] = [
  { id: 'folder', label: 'folder', kind: 'directory' },
  { id: 'text', label: 'text file', kind: 'file', initialContent: () => '' },
  { id: 'svg', label: 'svg file', kind: 'file', extension: '.svg', initialContent: () => serializeDrawing([]) }
];

export function assetName(input: string, type: AssetType) {
  const name = input.trim();
  return name && type.extension && !name.toLowerCase().endsWith(type.extension) ? name + type.extension : name;
}

export function validAssetName(name: string) {
  return !!name && name.length <= 255 && !/[/\\\x00-\x1f]/.test(name) &&
    name !== '.' && name !== '..' && name.toLowerCase() !== '.git';
}
