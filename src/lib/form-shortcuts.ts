/** Keep Enter-to-submit for forms whose action is a Keyflow button. */
export function submitOnEnter(form: HTMLFormElement) {
  const keydown = (event: KeyboardEvent) => {
    if (event.key !== 'Enter' || event.isComposing || event.defaultPrevented ||
        event.ctrlKey || event.metaKey || event.altKey || event.shiftKey ||
        !(event.target instanceof HTMLInputElement) || event.target.disabled) return;
    event.preventDefault();
    event.stopPropagation();
    if (!event.repeat) form.requestSubmit();
  };
  form.addEventListener('keydown', keydown);
  return { destroy: () => form.removeEventListener('keydown', keydown) };
}
