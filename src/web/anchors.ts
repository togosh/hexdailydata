/** Run once per navigation, including a lazy route's first committed DOM. */
export function revealAnchor(hash: string, root: HTMLElement): boolean {
  let id: string;
  try {
    id = decodeURIComponent(hash.slice(1));
  } catch {
    return false;
  }
  const target = document.getElementById(id);
  if (!target || !root.contains(target)) return false;
  for (
    let node: HTMLElement | null = target;
    node && root.contains(node);
    node = node.parentElement
  ) {
    if (node instanceof HTMLDetailsElement) node.open = true;
  }
  const focusTarget =
    target instanceof HTMLDetailsElement ? target.querySelector('summary')! : target;
  if (!focusTarget.matches('a[href], button, input, select, textarea, summary, [tabindex]'))
    focusTarget.tabIndex = -1;
  focusTarget.focus({ preventScroll: true });
  target.scrollIntoView({ block: 'start', behavior: 'instant' });
  return true;
}
