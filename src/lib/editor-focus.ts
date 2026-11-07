export function preserveContentFocus(toolbar: HTMLElement, contentHasFocus: () => boolean) {
  function keepFocus(event: MouseEvent) {
    // Cancel the button's focus transfer while leaving click activation intact,
    // including the mouse events browsers synthesize for a touch tap.
    if (event.button === 0 && event.target instanceof Element &&
        event.target.closest('button') && contentHasFocus()) event.preventDefault();
  }
  toolbar.addEventListener('mousedown', keepFocus);
  return { destroy: () => toolbar.removeEventListener('mousedown', keepFocus) };
}
