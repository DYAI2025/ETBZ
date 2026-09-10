/**
 * ETBZ-25 test support — resolve a `ChartFact.path` against the HoroscopeModel.
 *
 * The point of this helper is that "the fact is the source value verbatim" is
 * MEASURED rather than asserted: the test walks the declared path into the real
 * model and compares. A fact whose path does not resolve is a defect, so an
 * unresolvable path throws instead of returning undefined.
 */
export function resolveFactPath(root: unknown, path: string): unknown {
  const segments = path
    .replace(/\[(\d+)\]/g, '.$1')
    .split('.')
    .filter((segment) => segment.length > 0);
  let current: unknown = root;
  for (const segment of segments) {
    if (current === null || typeof current !== 'object') {
      throw new TypeError(`fact path "${path}" leaves the object graph at "${segment}"`);
    }
    if (!(segment in (current as Record<string, unknown>))) {
      throw new TypeError(`fact path "${path}" has no member "${segment}"`);
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

/** The same rendering the feature set uses, so comparison is value-for-value. */
export function factText(value: unknown): string {
  return typeof value === 'number' ? JSON.stringify(value) : String(value);
}
