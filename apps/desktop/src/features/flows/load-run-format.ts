/** Built-in time series have known units; custom trends retain their own units. */
const TIME_METRICS = new Set([
  'http_req_duration', 'http_req_dns', 'http_req_connecting', 'http_req_tls_handshaking',
  'http_req_sending', 'http_req_waiting', 'http_req_receiving', 'group_duration',
])

export function metricUnit(name: string, statistic: string): string {
  if (statistic === 'rate') return '%'
  return TIME_METRICS.has(name) && statistic !== 'count' ? 'ms' : ''
}

export function statisticLabel(statistic: string): string {
  return ({ average: 'avg', minimum: 'min', maximum: 'max', p90: 'p(90)', p95: 'p(95)', p99: 'p(99)' } as Record<string, string>)[statistic] ?? statistic
}

export function comparisonSymbol(comparison: string): string {
  return ({ lessThan: '<', lessOrEqual: '≤', greaterThan: '>', greaterOrEqual: '≥', equal: '=', notEqual: '≠', lt: '<', lte: '≤', gt: '>', gte: '≥', eq: '=', ne: '≠' } as Record<string, string>)[comparison] ?? comparison
}

export function perSecond(value: number, elapsedMs: number): number | null {
  return elapsedMs > 0 ? value / (elapsedMs / 1000) : null
}

export function percentage(passed: number, total: number): number | null {
  return total > 0 ? passed / total : null
}
