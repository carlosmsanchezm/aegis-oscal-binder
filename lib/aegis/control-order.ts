/** Catalog family order, then any family id that is not in the catalog, A to Z. */
export function orderFamiliesPresent(present: readonly string[], catalogOrder: readonly string[]): string[] {
  const known = catalogOrder.filter((id) => present.includes(id));
  const rest = present.filter((id) => !catalogOrder.includes(id)).sort((a, b) => a.localeCompare(b));
  return [...known, ...rest];
}

export function compareControlId(a: string, b: string): number {
  const parts = (id: string) => id.split(".").map((part, index) => (index === 0 ? part : Number(part)));
  const left = parts(a);
  const right = parts(b);
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const aPart = left[index];
    const bPart = right[index];
    if (aPart === undefined) return -1;
    if (bPart === undefined) return 1;
    if (aPart === bPart) continue;
    if (typeof aPart === "number" && typeof bPart === "number") return aPart - bPart;
    return String(aPart).localeCompare(String(bPart));
  }
  return 0;
}
