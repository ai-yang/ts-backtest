/** Statistical floats only: ignore differences within eight relative machine epsilons.
 * No absolute currency threshold is applied; exact ledger amounts are never rounded here.
 */
export function statisticalDifference(a: number, b: number): number {
  const difference = a - b;
  const tolerance = 8 * Number.EPSILON * Math.max(Math.abs(a), Math.abs(b));
  return Math.abs(difference) <= tolerance ? 0 : difference;
}
export function statisticalReturn(current: number, previous: number): number {
  return statisticalDifference(current, previous) / previous;
}
