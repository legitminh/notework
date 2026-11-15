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

/** Center a point through its native scroll containers, remeasuring after each scroll. */
export function scrollPointIntoView(element: Element, point: () => { x: number; y: number }) {
  for (let parent = element.parentElement; parent; parent = parent.parentElement) {
    const style = getComputedStyle(parent);
    const horizontal = /(auto|scroll)/.test(style.overflowX) && parent.scrollWidth > parent.clientWidth;
    const vertical = /(auto|scroll)/.test(style.overflowY) && parent.scrollHeight > parent.clientHeight;
    if (!horizontal && !vertical) continue;
    const rect = parent.getBoundingClientRect();
    const { x, y } = point();
    parent.scrollBy({
      left: horizontal ? x - rect.left - parent.clientLeft - parent.clientWidth / 2 : 0,
      top: vertical ? y - rect.top - parent.clientTop - parent.clientHeight / 2 : 0,
      behavior: 'instant'
    });
  }
}
