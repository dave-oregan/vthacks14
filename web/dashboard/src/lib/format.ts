export type AppMode = "live" | "recall" | "guardian";

export function relativeTime(ms: number, now = Date.now()): string {
  const sec = Math.max(0, Math.round((now - ms) / 1000));
  if (sec < 45) return "just now";
  if (sec < 90) return "1 minute ago";
  const min = Math.round(sec / 60);
  if (min < 60) return `${min} minutes ago`;
  const hr = Math.round(min / 60);
  if (hr < 36) return `${hr} hour${hr === 1 ? "" : "s"} ago`;
  const day = Math.round(hr / 24);
  return `${day} day${day === 1 ? "" : "s"} ago`;
}

export function formatConfidence(n: number | undefined | null): string {
  if (n == null || !Number.isFinite(n)) return "—";
  const pct = n <= 1 ? Math.round(n * 100) : Math.round(n);
  return `${pct}% match`;
}
