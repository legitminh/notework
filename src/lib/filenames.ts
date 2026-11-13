/** A literal Backspace in pasted text is an editing artifact, not part of the visible name. */
export function stripFilenameEditingArtifacts(value: string) {
  return value.replace(/\u0008/g, '');
}

export function cleanFilename(value: string) {
  return stripFilenameEditingArtifacts(value).trim();
}

export function invalidFilenameMessage(name: string) {
  if (!name) return 'Enter a file or folder name.';
  const control = /[\u0000-\u001f]/.exec(name)?.[0];
  if (control) {
    const code = control.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0');
    return `The name contains an invisible control character (U+${code}). Remove it and try again.`;
  }
  if (/[/\\]/.test(name)) return 'Enter a name without a folder path (/ or \\).';
  if (/[\[\]]/.test(name)) return 'Square brackets ([ and ]) cannot be used in a linked filename.';
  if (name.length > 255) return 'The name is too long. Use 255 characters or fewer.';
  if (name === '.' || name === '..' || name.toLowerCase() === '.git') return '“.”, “..”, and “.git” are reserved names.';
  return 'Enter a valid file or folder name.';
}
