/** Statistics for cross-tabs: Pearson's chi-square test of independence. */

/** ln Γ(z), Lanczos approximation (g = 7, n = 9). */
function lnGamma(z: number): number {
  const c = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059, 12.507343278686905,
    -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
  ];
  if (z < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * z)) - lnGamma(1 - z);
  z -= 1;
  let x = c[0]!;
  for (let i = 1; i < 9; i++) x += c[i]! / (z + i);
  const t = z + 7.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(x);
}

/** Regularized upper incomplete gamma Q(a, x) (Numerical Recipes: series or continued fraction). */
export function gammaQ(a: number, x: number): number {
  if (x <= 0) return 1;
  const gln = lnGamma(a);
  if (x < a + 1) {
    let sum = 1 / a;
    let term = sum;
    for (let n = 1; n < 500; n++) {
      term *= x / (a + n);
      sum += term;
      if (Math.abs(term) < Math.abs(sum) * 1e-14) break;
    }
    return 1 - sum * Math.exp(-x + a * Math.log(x) - gln);
  }
  let b = x + 1 - a;
  let c = 1 / 1e-300;
  let d = 1 / b;
  let h = d;
  for (let i = 1; i < 500; i++) {
    const an = -i * (i - a);
    b += 2;
    d = an * d + b;
    if (Math.abs(d) < 1e-300) d = 1e-300;
    c = b + an / c;
    if (Math.abs(c) < 1e-300) c = 1e-300;
    d = 1 / d;
    const delta = d * c;
    h *= delta;
    if (Math.abs(delta - 1) < 1e-14) break;
  }
  return Math.exp(-x + a * Math.log(x) - gln) * h;
}

/**
 * Chi-square test of independence on a contingency table. Empty rows and columns are ignored.
 * Returns null when fewer than 2 non-empty rows or columns remain. `lowExpected` is the share of
 * cells with an expected count below 5 (the test is unreliable above 20%).
 */
export function chiSquare(counts: number[][]): { value: number; df: number; p: number; lowExpected: number } | null {
  const rowTotals = counts.map((r) => r.reduce((a, b) => a + b, 0));
  const colCount = counts[0]?.length ?? 0;
  const colTotals = Array.from({ length: colCount }, (_, j) => counts.reduce((a, r) => a + (r[j] ?? 0), 0));
  const rows = rowTotals.map((t, i) => (t > 0 ? i : -1)).filter((i) => i >= 0);
  const cols = colTotals.map((t, j) => (t > 0 ? j : -1)).filter((j) => j >= 0);
  if (rows.length < 2 || cols.length < 2) return null;
  const total = rows.reduce((a, i) => a + rowTotals[i]!, 0);
  let value = 0;
  let low = 0;
  for (const i of rows)
    for (const j of cols) {
      const expected = (rowTotals[i]! * colTotals[j]!) / total;
      if (expected < 5) low++;
      value += (counts[i]![j]! - expected) ** 2 / expected;
    }
  const df = (rows.length - 1) * (cols.length - 1);
  return { value: Math.round(value * 1000) / 1000, df, p: Math.max(0, Math.min(1, gammaQ(df / 2, value / 2))), lowExpected: low / (rows.length * cols.length) };
}
