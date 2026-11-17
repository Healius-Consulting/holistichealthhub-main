import { useEffect, useMemo, useRef, useState } from 'react';

/**
 * Referral fees over time: one stacked column per period bucket, first collected
 * dispenses (£50) at the base and annual fees (£40) on top. One y-axis, a legend,
 * a hover tooltip per column, and a table view so nothing depends on colour alone.
 */

export type FeeChartEvent = { kind: 'new-referral' | 'annual-patient'; amount: number; occurredAt: Date };

type Bucket = { key: string; label: string; long: string; first: number; firstCount: number; annual: number; annualCount: number };

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function monthKey(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

function buildBuckets(events: FeeChartEvent[], period: 'all' | 'month' | 'year', month: string, year: string, now: Date): Bucket[] {
  const empty = (key: string, label: string, long: string): Bucket => ({ key, label, long, first: 0, firstCount: 0, annual: 0, annualCount: 0 });
  let buckets: Bucket[];
  let keyOf: (date: Date) => string;

  if (period === 'month') {
    const [y, m] = month.split('-').map(Number) as [number, number];
    const days = new Date(y, m, 0).getDate();
    buckets = Array.from({ length: days }, (_, index) => empty(String(index + 1), String(index + 1), `${index + 1} ${MONTHS[m - 1]} ${y}`));
    keyOf = date => String(date.getDate());
  } else if (period === 'year') {
    buckets = MONTHS.map((name, index) => empty(`${year}-${String(index + 1).padStart(2, '0')}`, name, `${name} ${year}`));
    keyOf = monthKey;
  } else {
    // All time: every month from the first fee to now, folding into quarters past three years.
    const first = events.reduce<Date | null>((earliest, event) => (!earliest || event.occurredAt < earliest ? event.occurredAt : earliest), null) ?? now;
    const start = new Date(first.getFullYear(), first.getMonth(), 1);
    const months = (now.getFullYear() - start.getFullYear()) * 12 + now.getMonth() - start.getMonth() + 1;
    if (months > 36) {
      const quarterOf = (date: Date) => `${date.getFullYear()}-Q${Math.floor(date.getMonth() / 3) + 1}`;
      const seen = new Set<string>();
      buckets = [];
      for (let cursor = new Date(start); cursor <= now; cursor.setMonth(cursor.getMonth() + 3)) {
        const key = quarterOf(cursor);
        if (seen.has(key)) continue;
        seen.add(key);
        const [y, q] = key.split('-');
        buckets.push(empty(key, `${q} ${y!.slice(2)}`, `${q} ${y}`));
      }
      keyOf = quarterOf;
    } else {
      buckets = Array.from({ length: months }, (_, index) => {
        const date = new Date(start.getFullYear(), start.getMonth() + index, 1);
        const name = MONTHS[date.getMonth()]!;
        return empty(monthKey(date), date.getMonth() === 0 || index === 0 ? `${name} ${String(date.getFullYear()).slice(2)}` : name, `${name} ${date.getFullYear()}`);
      });
      keyOf = monthKey;
    }
  }

  const byKey = new Map(buckets.map(bucket => [bucket.key, bucket]));
  for (const event of events) {
    const bucket = byKey.get(keyOf(event.occurredAt));
    if (!bucket) continue;
    if (event.kind === 'new-referral') { bucket.first += event.amount; bucket.firstCount += 1; }
    else { bucket.annual += event.amount; bucket.annualCount += 1; }
  }
  return buckets;
}

/** A clean axis top (50, 100, 200, 250, 500…) and its four steps. */
function niceScale(max: number) {
  if (max <= 0) return { top: 100, ticks: [0, 25, 50, 75, 100] };
  const raw = max / 4;
  const power = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map(multiple => multiple * power).find(candidate => candidate >= raw) ?? raw;
  return { top: step * 4, ticks: [0, step, step * 2, step * 3, step * 4] };
}

export function FeeChart({ events, period, month, year, formatMoney, now }: {
  events: FeeChartEvent[];
  period: 'all' | 'month' | 'year';
  month: string;
  year: string;
  formatMoney: (amount: number) => string;
  now?: Date;
}) {
  const [today] = useState(() => now ?? new Date());
  const plotRef = useRef<HTMLDivElement>(null);
  const [measured, setMeasured] = useState(960);
  useEffect(() => {
    const el = plotRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(([entry]) => { if (entry) setMeasured(Math.max(280, Math.round(entry.contentRect.width))); });
    observer.observe(el);
    return () => observer.disconnect();
  });
  const [hover, setHover] = useState<number | null>(null);
  const [asTable, setAsTable] = useState(false);
  const buckets = useMemo(() => buildBuckets(events, period, month, year, today), [events, period, month, year, today]);
  const firstTotal = buckets.reduce((sum, bucket) => sum + bucket.first, 0);
  const annualTotal = buckets.reduce((sum, bucket) => sum + bucket.annual, 0);
  const { top, ticks } = niceScale(Math.max(...buckets.map(bucket => bucket.first + bucket.annual), 0));
  const compactMoney = (amount: number) => (amount >= 1000 ? `£${(amount / 1000).toLocaleString('en-GB', { maximumFractionDigits: 1 })}k` : `£${amount}`);

  // Geometry in viewBox units; the SVG scales to the card's width.
  const width = measured;
  const height = 220;
  const pad = { top: 12, right: 8, bottom: 26, left: 44 };
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;
  const slot = plotW / Math.max(buckets.length, 1);
  const barW = Math.min(24, slot * 0.62);
  const y = (amount: number) => pad.top + plotH - (amount / top) * plotH;
  // Label every bucket when they fit, otherwise every nth.
  const labelEvery = Math.max(1, Math.ceil(buckets.length / Math.max(4, Math.floor(plotW / 56))));
  const hovered = hover == null ? null : buckets[hover] ?? null;
  const subtitle = period === 'month' ? 'By day' : period === 'year' ? `By month, ${year}` : buckets[0]?.key.includes('Q') ? 'By quarter' : 'By month';

  return (
    <section className="fee-chart" aria-labelledby="fee-chart-title">
      <header className="fee-chart__head">
        <div>
          <h3 id="fee-chart-title">Fees over time</h3>
          <small>{subtitle}</small>
        </div>
        <ul className="fee-chart__legend" aria-label="Legend">
          <li><i className="fee-chart__swatch is-first" aria-hidden="true" />First dispenses <b>{formatMoney(firstTotal)}</b></li>
          <li><i className="fee-chart__swatch is-annual" aria-hidden="true" />Annual fees <b>{formatMoney(annualTotal)}</b></li>
        </ul>
        <button type="button" className="btn btn-sm" aria-pressed={asTable} onClick={() => setAsTable(value => !value)}>{asTable ? 'Show chart' : 'Show table'}</button>
      </header>

      {asTable ? (
        <div className="fee-chart__table">
          <table>
            <thead><tr><th scope="col">Period</th><th scope="col">First dispenses</th><th scope="col">Annual fees</th><th scope="col">Total</th></tr></thead>
            <tbody>
              {buckets.filter(bucket => bucket.first || bucket.annual).map(bucket => (
                <tr key={bucket.key}>
                  <th scope="row">{bucket.long}</th>
                  <td>{bucket.firstCount} · {formatMoney(bucket.first)}</td>
                  <td>{bucket.annualCount} · {formatMoney(bucket.annual)}</td>
                  <td>{formatMoney(bucket.first + bucket.annual)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {!firstTotal && !annualTotal ? <p className="admin-intake-note">No fees in this period.</p> : null}
        </div>
      ) : (
        <div className="fee-chart__plot" ref={plotRef} onMouseLeave={() => setHover(null)}>
          <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`Fees over time: first dispenses ${formatMoney(firstTotal)}, annual fees ${formatMoney(annualTotal)}. Use Show table for each period.`} width={width} height={height}>
            {ticks.map(tick => (
              <g key={tick}>
                <line className="fee-chart__grid" x1={pad.left} x2={width - pad.right} y1={y(tick)} y2={y(tick)} />
                <text className="fee-chart__tick" x={pad.left - 8} y={y(tick)} dy="0.32em" textAnchor="end">{compactMoney(tick)}</text>
              </g>
            ))}
            {buckets.map((bucket, index) => {
              const cx = pad.left + slot * index + slot / 2;
              const x = cx - barW / 2;
              const firstTop = y(bucket.first);
              const annualBase = bucket.first ? firstTop - 2 : y(0);
              const annualTop = annualBase - (bucket.annual / top) * plotH;
              const roundFirst = bucket.annual === 0;
              return (
                <g key={bucket.key} className={hover === index ? 'is-hover' : undefined}>
                  {bucket.first ? <path className="fee-chart__bar is-first" d={columnPath(x, firstTop, barW, y(0) - firstTop, roundFirst)} /> : null}
                  {bucket.annual ? <path className="fee-chart__bar is-annual" d={columnPath(x, annualTop, barW, annualBase - annualTop, true)} /> : null}
                  {index % labelEvery === 0 ? <text className="fee-chart__tick" x={cx} y={height - 8} textAnchor="middle">{bucket.label}</text> : null}
                  {/* Hit target: the whole slot, taller than the mark. */}
                  <rect className="fee-chart__hit" x={pad.left + slot * index} y={pad.top} width={slot} height={plotH} onMouseEnter={() => setHover(index)} onFocus={() => setHover(index)} onBlur={() => setHover(null)} tabIndex={bucket.first || bucket.annual ? 0 : -1} aria-label={`${bucket.long}: ${formatMoney(bucket.first + bucket.annual)}`} />
                </g>
              );
            })}
          </svg>
          {hovered ? (
            <div className="fee-chart__tip" style={{ left: `${Math.min(Math.max(pad.left + slot * (hover! + 0.5), 100), width - 100)}px` }} role="status">
              <strong>{hovered.long}</strong>
              <span><i className="fee-chart__swatch is-first" aria-hidden="true" />First dispenses <b>{hovered.firstCount} · {formatMoney(hovered.first)}</b></span>
              <span><i className="fee-chart__swatch is-annual" aria-hidden="true" />Annual fees <b>{hovered.annualCount} · {formatMoney(hovered.annual)}</b></span>
              <span className="fee-chart__tip-total">Total <b>{formatMoney(hovered.first + hovered.annual)}</b></span>
            </div>
          ) : null}
        </div>
      )}
    </section>
  );
}

/** A column with a 4px rounded top (when it is the top of the stack) and a square base. */
function columnPath(x: number, top: number, w: number, h: number, roundTop: boolean) {
  if (h <= 0) return '';
  const r = roundTop ? Math.min(4, w / 2, h) : 0;
  return `M${x},${top + h}V${top + r}${r ? `Q${x},${top} ${x + r},${top}` : ''}H${x + w - r}${r ? `Q${x + w},${top} ${x + w},${top + r}` : ''}V${top + h}Z`;
}
