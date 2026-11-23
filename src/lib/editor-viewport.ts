/**
 * While an editor is open its toolbar must never scroll or zoom out of view: only
 * the editor's own area below the toolbar scrolls (natively). This pins the editing
 * view to the *visible* viewport (which differs from the layout viewport when the
 * page is zoomed or a system keyboard pans it) and blocks page zoom gestures.
 * Returns a cleanup that restores the page.
 */
export function lockEditorViewport(): () => void {
  const root = document.documentElement;
  const visible = window.visualViewport;
  const meta = document.querySelector<HTMLMetaElement>('meta[name="viewport"]');
  const originalMeta = meta?.content;

  root.classList.add('editor-locked');
  // Android resets an existing zoom when the maximum scale drops to 1.
  if (meta && originalMeta && !/maximum-scale/.test(originalMeta)) meta.content = `${originalMeta}, maximum-scale=1`;

  const sync = () => {
    if (!visible) return;
    root.style.setProperty('--visible-top', `${visible.offsetTop}px`);
    root.style.setProperty('--visible-left', `${visible.offsetLeft}px`);
    root.style.setProperty('--visible-width', `${visible.width}px`);
    root.style.setProperty('--visible-height', `${visible.height}px`);
  };
  // The page behind the editor never needs to scroll; undo any accidental offset.
  const resetPage = () => { if (window.scrollX || window.scrollY) window.scrollTo(0, 0); sync(); };
  // Safari (iOS and macOS trackpads) reports pinch zoom as proprietary gesture events.
  const blockGesture = (event: Event) => event.preventDefault();

  sync();
  visible?.addEventListener('resize', sync);
  visible?.addEventListener('scroll', sync);
  window.addEventListener('scroll', resetPage, { passive: true });
  for (const type of ['gesturestart', 'gesturechange']) document.addEventListener(type, blockGesture, { passive: false });

  return () => {
    root.classList.remove('editor-locked');
    for (const name of ['--visible-top', '--visible-left', '--visible-width', '--visible-height']) root.style.removeProperty(name);
    if (meta && originalMeta !== undefined) meta.content = originalMeta;
    visible?.removeEventListener('resize', sync);
    visible?.removeEventListener('scroll', sync);
    window.removeEventListener('scroll', resetPage);
    for (const type of ['gesturestart', 'gesturechange']) document.removeEventListener(type, blockGesture);
  };
}
