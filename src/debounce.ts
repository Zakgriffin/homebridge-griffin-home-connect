export function debounce(
  fn: () => void,
  delayMs: number,
  { leading = false, trailing = true }: { leading?: boolean; trailing?: boolean } = {},
): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return () => {
    const isNewDebounce = timer === undefined;
    clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      if (trailing) fn();
    }, delayMs);
    if (leading && isNewDebounce) fn();
  };
}
