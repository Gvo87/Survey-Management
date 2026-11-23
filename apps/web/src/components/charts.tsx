/**
 * Small, dependency-free charts for survey results, built to the data-viz spec:
 * - single-hue marks for one series; validated diverging colours for ordered scales
 * - bars ≤ 24px with 4px rounded data-ends, square at the baseline; 2px surface gaps
 * - values at the bar tip (selective), text in text tokens, never in the data colour
 * - every mark is focusable with a hover/focus tooltip; every chart has a table view
 */
import { useState, type ReactNode } from 'react';
import { formatNumber } from '../lib/format';
import { cx } from './ui';

interface TooltipState {
  x: number;
  y: number;
  value: string;
  label: string;
}

/** Mark props that drive the shared tooltip on hover and keyboard focus. */
function useTooltip() {
  const [tip, setTip] = useState<TooltipState | null>(null);
  const bind = (value: string, label: string) => ({
    tabIndex: 0,
    'aria-label': `${label}: ${value}`,
    onPointerEnter: (e: React.PointerEvent<HTMLElement>) => show(e.currentTarget, value, label),
    onPointerLeave: () => setTip(null),
    onFocus: (e: React.FocusEvent<HTMLElement>) => show(e.currentTarget, value, label),
    onBlur: () => setTip(null),
  });
  const show = (el: HTMLElement, value: string, label: string) => {
    const box = el.getBoundingClientRect();
    const parent = el.closest('[data-chart]')?.getBoundingClientRect();
    if (!parent) return;
    setTip({ x: box.left - parent.left + box.width / 2, y: box.top - parent.top, value, label });
  };
  const node = tip ? (
    <div
      role="presentation"
      className="pointer-events-none absolute z-10 -translate-x-1/2 -translate-y-full rounded-md border border-line bg-white px-2.5 py-1.5 text-xs shadow-md"
      style={{ left: tip.x, top: tip.y - 6 }}
    >
      <div className="font-semibold" style={{ color: 'var(--chart-text)' }}>
        {tip.value}
      </div>
      <div style={{ color: 'var(--chart-text-2)' }}>{tip.label}</div>
    </div>
  ) : null;
  return { bind, node };
}

const pctText = (pct: number) => `${pct % 1 === 0 ? pct : pct.toFixed(1)}%`;

export interface BarRow {
  key: string;
  label: string;
  count: number;
  pct: number;
}

/** Horizontal bars, one hue, in the order given (options keep their survey order). */
export function BarList({ rows, ariaLabel }: { rows: BarRow[]; ariaLabel: string }) {
  const { bind, node } = useTooltip();
  const max = Math.max(1, ...rows.map((r) => r.count));
  return (
    <div data-chart className="relative" role="group" aria-label={ariaLabel}>
      <div className="grid grid-cols-[minmax(0,40%)_1fr] items-center gap-x-3 gap-y-2">
        {rows.map((r) => (
          <div key={r.key} className="contents">
            <span className="truncate text-sm" style={{ color: 'var(--chart-text-2)' }} title={r.label}>
              {r.label}
            </span>
            <div className="flex items-center gap-2 border-l" style={{ borderColor: 'var(--chart-axis)' }}>
              <div
                {...bind(`${formatNumber(r.count)} (${pctText(r.pct)})`, r.label)}
                className="h-5 rounded-r-[4px] outline-offset-1 transition-opacity hover:opacity-85"
                style={{
                  width: `${(r.count / max) * 85}%`,
                  minWidth: r.count ? 2 : 0,
                  background: 'var(--chart-series-1)',
                }}
              />
              <span className="tabular shrink-0 text-xs" style={{ color: 'var(--chart-text)' }}>
                {formatNumber(r.count)}{' '}
                <span style={{ color: 'var(--chart-muted)' }}>· {pctText(r.pct)}</span>
              </span>
            </div>
          </div>
        ))}
      </div>
      {node}
    </div>
  );
}

/** Vertical columns for distributions (rating, NPS 0-10, dates). Labels only the tallest column. */
export function Columns({
  data,
  ariaLabel,
  colorFor,
}: {
  data: { label: string; count: number }[];
  ariaLabel: string;
  colorFor?: (label: string) => string;
}) {
  const { bind, node } = useTooltip();
  const max = Math.max(1, ...data.map((d) => d.count));
  const peak = data.findIndex((d) => d.count === max && max > 0);
  const ticks = [0, Math.round(max / 2), max];
  return (
    <div data-chart className="relative" role="group" aria-label={ariaLabel}>
      <div className="relative ml-8 h-36">
        {ticks.map((t) => (
          <div
            key={t}
            className="absolute inset-x-0 border-t"
            style={{
              bottom: `${(t / max) * 100}%`,
              borderColor: t === 0 ? 'var(--chart-axis)' : 'var(--chart-grid)',
            }}
          >
            <span
              className="tabular absolute -left-8 -translate-y-1/2 text-[11px]"
              style={{ color: 'var(--chart-muted)' }}
            >
              {formatNumber(t)}
            </span>
          </div>
        ))}
        <div className="absolute inset-0 flex items-end justify-around gap-[2px]">
          {data.map((d, i) => (
            <div key={d.label} className="relative flex h-full flex-1 items-end justify-center">
              {i === peak ? (
                <span
                  className="tabular absolute text-[11px] font-semibold"
                  style={{ bottom: `calc(${(d.count / max) * 100}% + 2px)`, color: 'var(--chart-text)' }}
                >
                  {formatNumber(d.count)}
                </span>
              ) : null}
              <div
                {...bind(formatNumber(d.count), d.label)}
                className="w-full max-w-6 rounded-t-[4px] transition-opacity hover:opacity-85"
                style={{
                  height: `${(d.count / max) * 100}%`,
                  minHeight: d.count ? 2 : 0,
                  background: colorFor?.(d.label) ?? 'var(--chart-series-1)',
                }}
              />
            </div>
          ))}
        </div>
      </div>
      <div className="ml-8 mt-1 flex justify-around gap-[2px]">
        {data.map((d) => (
          <span
            key={d.label}
            className="flex-1 truncate text-center text-[11px]"
            style={{ color: 'var(--chart-muted)' }}
          >
            {d.label}
          </span>
        ))}
      </div>
      {node}
    </div>
  );
}

export interface Segment {
  key: string;
  label: string;
  count: number;
  color: string;
  /** Ink for text printed inside the block: white on dark fills, near-black on light ones. */
  ink: 'light' | 'dark';
}

/** Tall segmented bar: one whole split into parts, share printed inside where it fits, legend below. */
export function SegmentedBar({ segments, ariaLabel }: { segments: Segment[]; ariaLabel: string }) {
  const { bind, node } = useTooltip();
  const total = segments.reduce((s, x) => s + x.count, 0);
  if (total === 0) return <p className="text-sm text-muted">No answers yet.</p>;
  return (
    <div data-chart className="relative" role="group" aria-label={ariaLabel}>
      <div className="flex h-7 gap-[2px]">
        {segments
          .filter((s) => s.count > 0)
          .map((s) => {
            const share = (s.count / total) * 100;
            return (
              <div
                key={s.key}
                {...bind(`${formatNumber(s.count)} (${pctText(Math.round(share * 10) / 10)})`, s.label)}
                className="flex items-center overflow-visible rounded-[4px] px-1.5 transition-opacity hover:opacity-85"
                style={{ width: `${share}%`, background: s.color }}
              >
                {share >= 9 ? (
                  <span
                    className="tabular text-xs font-semibold"
                    style={{ color: s.ink === 'light' ? '#ffffff' : '#0b0b0b' }}
                  >
                    {Math.round(share)}%
                  </span>
                ) : null}
              </div>
            );
          })}
      </div>
      <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
        {segments.map((s) => (
          <li
            key={s.key}
            className="flex items-center gap-1.5 text-xs"
            style={{ color: 'var(--chart-text-2)' }}
          >
            <span className="h-2.5 w-2.5 rounded-[2px]" style={{ background: s.color }} aria-hidden="true" />
            {s.label}
          </li>
        ))}
      </ul>
      {node}
    </div>
  );
}

/** Diverging colours for an ordered scale (validated: CVD ΔE ≥ 17, normal-vision ΔE ≥ 18). */
export function divergingColors(points: number): { color: string; ink: 'light' | 'dark' }[] | null {
  const neg2 = { color: 'var(--chart-neg-2)', ink: 'light' as const };
  const neg1 = { color: 'var(--chart-neg-1)', ink: 'dark' as const };
  const mid = { color: 'var(--chart-neutral)', ink: 'dark' as const };
  const pos1 = { color: 'var(--chart-pos-1)', ink: 'dark' as const };
  const pos2 = { color: 'var(--chart-pos-2)', ink: 'light' as const };
  if (points === 3) return [neg2, mid, pos2];
  if (points === 5) return [neg2, neg1, mid, pos1, pos2];
  return null;
}

export function StatTile({ label, value, sub }: { label: string; value: ReactNode; sub?: ReactNode }) {
  return (
    <div className="rounded-xl border border-line bg-white p-4 shadow-sm">
      <div className="text-sm text-muted">{label}</div>
      <div className="mt-1 text-2xl font-semibold text-ink">{value}</div>
      {sub ? <div className="mt-0.5 text-xs text-muted">{sub}</div> : null}
    </div>
  );
}

/** Accessible table fallback for any chart. */
export function DataTable({
  columns,
  rows,
  caption,
}: {
  columns: string[];
  rows: (string | number)[][];
  caption: string;
}) {
  return (
    <table className="w-full text-left text-sm">
      <caption className="sr-only">{caption}</caption>
      <thead>
        <tr className="border-b border-line text-xs text-muted">
          {columns.map((c, i) => (
            <th key={c} scope="col" className={cx('py-1.5 font-medium', i > 0 && 'text-right')}>
              {c}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row, r) => (
          <tr key={r} className="border-b border-line last:border-0">
            {row.map((cell, i) => (
              <td key={i} className={cx('py-1.5', i > 0 && 'tabular text-right')}>
                {typeof cell === 'number' ? formatNumber(cell) : cell}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
