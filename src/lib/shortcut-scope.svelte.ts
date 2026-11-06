// Keyflow registers shortcuts globally. Native dialog inertness alone does not
// suspend those registrations, so Notework scopes its controls to the open modal.
export const shortcutScope = $state<{ dialog: HTMLDialogElement | null }>({ dialog: null });

export function dialogShortcuts(dialog: HTMLDialogElement) {
  const update = () => {
    if (dialog.open) shortcutScope.dialog = dialog;
    else if (shortcutScope.dialog === dialog) shortcutScope.dialog = null;
  };
  const observer = new MutationObserver(update);
  observer.observe(dialog, { attributes: true, attributeFilter: ['open'] });
  update();
  return { destroy() {
    observer.disconnect();
    if (shortcutScope.dialog === dialog) shortcutScope.dialog = null;
  } };
}
