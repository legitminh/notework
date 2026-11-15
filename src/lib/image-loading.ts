/** Shared by Svelte image surfaces and CodeMirror's DOM widgets. */
export function imageLoadingIndicator(label = 'Loading image') {
  const status = document.createElement('span');
  status.className = 'image-loading';
  status.setAttribute('role', 'status');
  status.setAttribute('aria-label', label);
  const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  icon.classList.add('image-loading-icon');
  icon.setAttribute('viewBox', '0 0 24 24');
  icon.setAttribute('aria-hidden', 'true');
  const arc = document.createElementNS(icon.namespaceURI, 'circle');
  for (const [name, value] of Object.entries({ cx: '12', cy: '12', r: '9', fill: 'none', stroke: 'currentColor', 'stroke-width': '2', 'stroke-linecap': 'round', 'stroke-dasharray': '42 15' })) arc.setAttribute(name, value);
  icon.append(arc); status.append(icon);
  return status;
}
