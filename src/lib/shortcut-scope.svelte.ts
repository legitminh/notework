// Keyflow registers shortcuts globally. Native dialog inertness alone does not
// suspend those registrations, so Notework scopes its controls to the open modal.
export const shortcutScope = $state<{ dialog: HTMLDialogElement | null }>({ dialog: null });
const openDialogs: HTMLDialogElement[] = [];

export function dialogShortcuts(dialog: HTMLDialogElement) {
  function remove() {
    const index = openDialogs.indexOf(dialog);
    if (index !== -1) openDialogs.splice(index, 1);
  }
  const update = () => {
    if (dialog.open) {
      if (!openDialogs.includes(dialog)) openDialogs.push(dialog);
    } else remove();
    shortcutScope.dialog = openDialogs.at(-1) ?? null;
  };
  const observer = new MutationObserver(update);
  observer.observe(dialog, { attributes: true, attributeFilter: ['open'] });
  update();
  return { destroy() {
    observer.disconnect();
    remove();
    shortcutScope.dialog = openDialogs.at(-1) ?? null;
  } };
}
