// Small-sample statistics for the eval report.

/** P(X <= k) for X ~ Binomial(n, p). */
function binomCdf(k: number, n: number, p: number): number {
  if (k < 0) return 0
  if (k >= n) return 1
  let term = Math.pow(1 - p, n)
  let sum = term
  for (let i = 1; i <= k; i++) {
    term *= ((n - i + 1) / i) * (p / (1 - p))
    sum += term
  }
  return Math.min(1, sum)
}

/**
 * One-sided Clopper-Pearson upper bound on a failure rate after seeing `k`
 * failures in `n` trials: the largest rate still consistent with the data at
 * the given confidence. With k = 0 this is 1 - (1 - confidence)^(1/n), which
 * the "rule of three" approximates as 3/n at 95%.
 */
export function upperBound(k: number, n: number, confidence = 0.95): number {
  if (n === 0) return 1
  if (k >= n) return 1
  const alpha = 1 - confidence
  let lo = k / n
  let hi = 1
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2
    if (binomCdf(k, n, mid) > alpha) lo = mid
    else hi = mid
  }
  return hi
}

export function quantile(xs: readonly number[], q: number): number {
  return [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(q * xs.length))] ?? 0
}

export const pct = (n: number, d: number, digits = 0) => (d ? `${((100 * n) / d).toFixed(digits)}%` : '-')
