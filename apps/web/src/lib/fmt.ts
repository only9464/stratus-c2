export function ts(unix: number | null | undefined): string {
  if (!unix) return '—';
  return new Date(unix * 1000).toLocaleString();
}

export function ago(unix: number | null | undefined): string {
  if (!unix) return '—';
  const d = Math.floor(Date.now() / 1000) - unix;
  if (d < 60) return `${d}s`;
  if (d < 3600) return `${Math.floor(d / 60)}m`;
  if (d < 86400) return `${Math.floor(d / 3600)}h`;
  return `${Math.floor(d / 86400)}d`;
}

export function bytes(n: number | null | undefined): string {
  if (!n) return '—';
  const u = ['B', 'KB', 'MB', 'GB'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${u[i]}`;
}

export function statusTone(status: string | null | undefined): 'ok' | 'warn' | 'danger' | undefined {
  switch (status) {
    case 'online':
    case 'done':
    case 'active':
      return 'ok';
    case 'offline':
    case 'queued':
    case 'dispatched':
    case 'running':
      return 'warn';
    case 'dead':
    case 'failed':
    case 'canceled':
      return 'danger';
    default:
      return undefined;
  }
}

export function pct(ratio: number): string {
  return `${(ratio * 100).toFixed(ratio < 0.1 ? 1 : 0)}%`;
}

export function short(s: string | null | undefined, n = 10): string {
  if (!s) return '—';
  return s.length > n ? `${s.slice(0, n)}…` : s;
}
