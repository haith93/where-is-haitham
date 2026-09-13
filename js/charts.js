/**
 * Tiny SVG chart helpers.
 *
 * No charting library: the report screens only need honest bars, and an
 * inline SVG stays readable, themeable, printable and fast on a phone.
 * Colours come from CSS custom properties so dark mode works for free.
 */
import { esc } from './utils.js';

/**
 * Vertical bar chart, e.g. requests per day.
 * @param {{label:string, value:number, title?:string}[]} data
 */
export function barChart(data, {
  height = 180,
  barWidth = 34,
  gap = 10,
  valueFormat = v => String(v),
  ariaLabel = 'Bar chart'
} = {}) {
  if (!data.length) return '<p class="muted small">No data for this period.</p>';

  const padTop = 22;
  const padBottom = 30;
  const plotHeight = height - padTop - padBottom;
  const width = data.length * barWidth + (data.length - 1) * gap;
  const max = Math.max(1, ...data.map(d => d.value));

  const bars = data.map((d, i) => {
    const h = Math.max(d.value > 0 ? 3 : 0, Math.round((d.value / max) * plotHeight));
    const x = i * (barWidth + gap);
    const y = padTop + (plotHeight - h);
    return `
      <g>
        <title>${esc(d.title ?? `${d.label}: ${valueFormat(d.value)}`)}</title>
        <rect class="bar" x="${x}" y="${y}" width="${barWidth}" height="${h}" rx="5"></rect>
        <text class="val-text" x="${x + barWidth / 2}" y="${y - 6}" text-anchor="middle">${esc(valueFormat(d.value))}</text>
        <text class="axis-text" x="${x + barWidth / 2}" y="${height - 10}" text-anchor="middle">${esc(d.label)}</text>
      </g>`;
  }).join('');

  return `
    <svg class="chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(ariaLabel)}"
         preserveAspectRatio="xMidYMid meet">
      <line class="grid-line" x1="0" y1="${padTop + plotHeight}" x2="${width}" y2="${padTop + plotHeight}"></line>
      ${bars}
    </svg>`;
}

/**
 * Horizontal proportion bars — the readable choice for long category
 * names on a narrow screen. Rendered as HTML, not SVG, so the labels
 * wrap naturally.
 * @param {{label:string, value:number, display?:string, tone?:string}[]} rows
 */
export function proportionBars(rows, { max = null, emptyText = 'No data for this period.' } = {}) {
  if (!rows.length) return `<p class="muted small">${esc(emptyText)}</p>`;
  const peak = max ?? Math.max(1, ...rows.map(r => r.value));

  return `<div class="bars">${rows.map(r => `
    <div class="bar-row"${r.tone ? ` data-tone="${esc(r.tone)}"` : ''}>
      <span class="bar-label">${esc(r.label)}</span>
      <span class="bar-value">${esc(r.display ?? String(r.value))}</span>
      <span class="bar-track">
        <span class="bar-fill" style="width:${Math.round((r.value / peak) * 100)}%"></span>
      </span>
    </div>`).join('')}</div>`;
}
