export function shareAvailable(file: File) {
  const installed = matchMedia('(display-mode: standalone)').matches || matchMedia('(display-mode: minimal-ui)').matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true;
  try { return installed && typeof navigator.share === 'function' && typeof navigator.canShare === 'function' && navigator.canShare({ files: [file] }); }
  catch { return false; }
}

export function downloadExport(file: File) {
  const url = URL.createObjectURL(file);
  const link = document.createElement('a');
  link.href = url; link.download = file.name;
  document.body.append(link); link.click(); link.remove();
  // Safari may consume the blob after the initiating event has finished.
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}
