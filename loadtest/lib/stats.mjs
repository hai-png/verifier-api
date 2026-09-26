/**
 * Minimal latency statistics — no dependencies.
 */

export function percentile(sortedValues, p) {
  if (sortedValues.length === 0) return null;
  if (sortedValues.length === 1) return sortedValues[0];
  const rank = (p / 100) * (sortedValues.length - 1);
  const low = Math.floor(rank);
  const high = Math.ceil(rank);
  if (low === high) return sortedValues[low];
  const weight = rank - low;
  return sortedValues[low] * (1 - weight) + sortedValues[high] * weight;
}

export function summarize(values) {
  const clean = values.filter((v) => typeof v === 'number' && Number.isFinite(v)).sort((a, b) => a - b);
  if (clean.length === 0) {
    return { count: 0, mean: null, min: null, max: null, p50: null, p75: null, p90: null, p95: null, p99: null };
  }
  const sum = clean.reduce((acc, v) => acc + v, 0);
  return {
    count: clean.length,
    mean: sum / clean.length,
    min: clean[0],
    max: clean[clean.length - 1],
    p50: percentile(clean, 50),
    p75: percentile(clean, 75),
    p90: percentile(clean, 90),
    p95: percentile(clean, 95),
    p99: percentile(clean, 99),
  };
}

export function fixed(value, digits = 1) {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return Number(value).toFixed(digits);
}

/**
 * Coarse histogram in `bucketSize` ms buckets. Useful for spotting fat tails
 * (e.g. requests that fell into an upstream 18s timeout).
 */
export function histogram(values, { bucketSize = 50, maxBuckets = 40 } = {}) {
  const clean = values.filter((v) => typeof v === 'number' && Number.isFinite(v));
  if (clean.length === 0) return [];
  const buckets = new Map();
  for (const value of clean) {
    const index = Math.min(Math.floor(value / bucketSize), maxBuckets - 1);
    buckets.set(index, (buckets.get(index) || 0) + 1);
  }
  return [...buckets.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([index, count]) => ({
      fromMs: index * bucketSize,
      toMs: index === maxBuckets - 1 ? null : (index + 1) * bucketSize,
      count,
      share: count / clean.length,
    }));
}
