/**
 * Tiny arc dial: a sage sweep = cache hit rate (0..1). Shared by the Cost
 * view hero and the overview cache KPI so the same rate reads identically
 * everywhere. Sage is the cache-savings channel (03-design.md §2).
 */
export function CacheDial({
  rate,
  size = 18,
}: {
  rate: number;
  size?: number;
}) {
  // Proportional to the original 18px dial (r=7, stroke=2.5) so the extracted
  // component renders identically to the CostView-local one it replaced.
  const stroke = size * (2.5 / 18);
  const r = size * (7 / 18);
  const c = 2 * Math.PI * r;
  const mid = size / 2;
  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      role="img"
      aria-label={`Cache hit rate ${(rate * 100).toFixed(1)}%`}
      className="-rotate-90"
    >
      <circle
        cx={mid}
        cy={mid}
        r={r}
        fill="none"
        stroke="var(--color-border)"
        strokeWidth={stroke}
      />
      <circle
        cx={mid}
        cy={mid}
        r={r}
        fill="none"
        stroke="var(--color-cache-savings)"
        strokeWidth={stroke}
        strokeDasharray={`${rate * c} ${c}`}
        strokeLinecap="butt"
      />
    </svg>
  );
}
