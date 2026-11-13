import { blankImage, imageFormats } from './images';
import { serializeDrawing } from './drawing';

export interface AssetType {
  id: string;
  label: string;
  kind: 'file' | 'directory';
  extension?: string;
  initialFileName?: (folderName: string) => string;
  initialContent?: () => string | Uint8Array | Promise<string | Uint8Array>;
}

// Creation UI and resource initialization both use this registry.
export const assetTypes: readonly AssetType[] = [
  { id: 'page-folder', label: 'page folder', kind: 'directory', initialFileName: (name) => `${name}.main` },
  { id: 'folder', label: 'folder', kind: 'directory' },
  { id: 'text', label: 'text file', kind: 'file', initialContent: () => '' },
  { id: 'svg', label: 'svg file', kind: 'file', extension: '.svg', initialContent: () => serializeDrawing([]) },
  ...imageFormats.map((format): AssetType => ({ id: format, label: `${format} image`, kind: 'file', extension: `.${format}`,
    initialContent: async () => new Uint8Array(await (await blankImage(format)).arrayBuffer()) }))
];

export function assetName(input: string, type: AssetType) {
  const name = input.trim();
  return name && type.extension && !name.toLowerCase().endsWith(type.extension) ? name + type.extension : name;
}

export function validAssetName(name: string) {
  return !!name && name.length <= 255 && !/[/\\\x00-\x1f]/.test(name) &&
    name !== '.' && name !== '..' && name.toLowerCase() !== '.git';
}

export function validAssetInput(input: string, type: AssetType) {
  const name = assetName(input, type);
  const initialFile = type.initialFileName?.(name);
  return validAssetName(input.trim()) && validAssetName(name) &&
    (initialFile === undefined || validAssetName(initialFile));
}
