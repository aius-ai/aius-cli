import path from "path"
import { Schema } from "effect"
import STYLE from "./style.css" with { type: "text" }
import type { Goal } from "@/ds/goals"

export const Metric = Schema.Struct({
  label: Schema.String,
  value: Schema.String,
  delta: Schema.optional(Schema.String),
  positive: Schema.optional(Schema.Boolean),
})
export type Metric = Schema.Schema.Type<typeof Metric>

export const SliceRow = Schema.Struct({
  slice: Schema.String,
  n: Schema.optional(Schema.Number),
  values: Schema.Record(Schema.String, Schema.Union([Schema.String, Schema.Number])),
})
export type SliceRow = Schema.Schema.Type<typeof SliceRow>

export const FeatureRow = Schema.Struct({
  name: Schema.String,
  importance: Schema.Number,
  direction: Schema.optional(Schema.Literals(["+", "-", "0"])),
})
export type FeatureRow = Schema.Schema.Type<typeof FeatureRow>

export const Figure = Schema.Struct({
  title: Schema.String,
  base64: Schema.String,
  format: Schema.optional(Schema.Literal("png")),
  caption: Schema.optional(Schema.String),
})
export type Figure = Schema.Schema.Type<typeof Figure>

// An interactive chart: title + a raw ECharts `option` object (any JSON). The
// agent composes the option in a notebook and passes it through — full control
// over series, axes, tooltips. Rendered with the Aius dark brand theme.
export const Chart = Schema.Struct({
  title: Schema.String,
  option: Schema.Unknown,
  span: Schema.optional(Schema.Literals(["half", "full"])),
  caption: Schema.optional(Schema.String),
})
export type Chart = Schema.Schema.Type<typeof Chart>

export const SuccessOutcome = Schema.Struct({
  metric: Schema.String,
  target: Schema.String,
  achieved: Schema.String,
  status: Schema.Literals(["met", "at_risk", "missed"]),
})
export type SuccessOutcome = Schema.Schema.Type<typeof SuccessOutcome>

export const Dashboard = Schema.Struct({
  goal: Schema.Unknown,
  generated_at: Schema.String,
  commit_sha: Schema.optional(Schema.String),
  subtitle: Schema.optional(Schema.String),
  primary_metrics: Schema.Array(Metric),
  success_outcomes: Schema.Array(SuccessOutcome),
  charts: Schema.optional(Schema.Array(Chart)),
  slice_table: Schema.optional(
    Schema.Struct({
      caption: Schema.String,
      columns: Schema.Array(Schema.String),
      rows: Schema.Array(SliceRow),
    }),
  ),
  feature_table: Schema.optional(
    Schema.Struct({
      caption: Schema.String,
      rows: Schema.Array(FeatureRow),
    }),
  ),
  figures: Schema.Array(Figure),
  methodology: Schema.Array(Schema.String),
})
export type Dashboard = Schema.Schema.Type<typeof Dashboard> & { goal: Goal }

const escapeHtml = (s: string): string =>
  s.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch] ?? ch)

const pillStatusClass = (s: SuccessOutcome["status"]) => ({ met: "ok", at_risk: "warn", missed: "miss" })[s]
const pillStatusLabel = (s: SuccessOutcome["status"]) => ({ met: "met", at_risk: "at risk", missed: "missed" })[s]
const numFmt = (n: number) => (Number.isInteger(n) ? n.toString() : n.toFixed(3))

// Aius brand palette + dark dashboard chrome layered over the shared style.css.
const DASH_CSS = `
:root{
  --bg:#0a0a0a; --panel:#121212; --panel2:#171717; --line:rgba(255,255,255,.08);
  --ink:#ededed; --muted:#9aa0a6;
  --violet:#de7bff; --cyan:#50f3ff; --pink:#ff7bde; --mint:#8cff7b; --amber:#ffb20d; --red:#ff5d8f;
}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font-family:"Geist","Inter",-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;letter-spacing:-.005em}
.wrap{max-width:1180px;margin:0 auto;padding:48px 28px 80px}
.eyebrow{display:inline-flex;align-items:center;gap:8px;color:var(--muted);font-size:12px;letter-spacing:.06em;text-transform:uppercase}
.eyebrow .dot{width:6px;height:6px;border-radius:1px}
h1.title{font-size:34px;font-weight:600;letter-spacing:-.02em;line-height:1.05;margin:10px 0 6px;
  background:linear-gradient(90deg,var(--cyan),var(--violet) 55%,var(--pink));-webkit-background-clip:text;background-clip:text;color:transparent}
.subtitle{color:var(--muted);max-width:780px;font-size:14px;line-height:1.55;margin:0 0 18px}
.pills{display:flex;gap:8px;flex-wrap:wrap;margin:6px 0 26px}
.pill{display:inline-flex;align-items:center;gap:7px;height:24px;padding:0 11px;border-radius:999px;border:1px solid var(--line);background:var(--panel);font-size:12px;font-weight:500}
.pill .sw{width:6px;height:6px;border-radius:2px}
.pill.ok{border-color:rgba(140,255,123,.4)} .pill.ok .sw{background:var(--mint)}
.pill.warn{border-color:rgba(255,178,13,.4)} .pill.warn .sw{background:var(--amber)}
.pill.miss{border-color:rgba(255,93,143,.45)} .pill.miss .sw{background:var(--red)}
.h-sec{font-size:12px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:var(--muted);margin:34px 0 14px}
.kpis{display:grid;grid-template-columns:repeat(4,1fr);gap:12px}
.kpi{border:1px solid var(--line);border-radius:14px;background:linear-gradient(180deg,var(--panel2),var(--panel));padding:16px 18px}
.kpi .lbl{font-size:12px;color:var(--muted)}
.kpi .val{font-size:26px;font-weight:600;letter-spacing:-.02em;margin-top:4px;font-variant-numeric:tabular-nums}
.kpi .delta{font-size:12px;margin-top:4px;color:var(--mint)} .kpi .delta.down{color:var(--red)}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:16px}
.card{border:1px solid var(--line);border-radius:14px;background:var(--panel);padding:16px}
.card.full{grid-column:1 / -1}
.card .ct{font-size:13px;font-weight:600;margin-bottom:10px}
.card .cap{font-size:12px;color:var(--muted);margin-top:8px}
.chart{width:100%;height:300px}
.card img{width:100%;height:auto;border-radius:8px;display:block}
table.tbl{width:100%;border-collapse:collapse;font-size:12.5px}
table.tbl th,table.tbl td{text-align:left;padding:9px 12px;border-bottom:1px solid var(--line)}
table.tbl th{color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:.04em;font-weight:500}
table.tbl td.num,table.tbl th.num{text-align:right;font-variant-numeric:tabular-nums}
.feat{display:grid;grid-template-columns:1fr 80px 40px;gap:10px;align-items:center;padding:7px 0;border-bottom:1px dashed var(--line);font-size:13px}
.feat:last-child{border-bottom:0}
.bar{height:6px;border-radius:3px;background:rgba(255,255,255,.06);overflow:hidden;margin-top:4px}
.bar>span{display:block;height:100%;background:linear-gradient(90deg,var(--cyan),var(--pink))}
.feat .num{text-align:right;font-variant-numeric:tabular-nums;color:var(--muted)}
.feat .dir{text-align:center;color:var(--muted)}
details.meth{border:1px solid var(--line);border-radius:10px;background:var(--panel);padding:12px 14px;margin-bottom:8px}
details.meth summary{cursor:pointer;font-weight:500;font-size:13px}
details.meth div{color:var(--muted);font-size:13px;line-height:1.55;margin-top:8px;white-space:pre-wrap}
.foot{margin-top:46px;padding-top:18px;border-top:1px solid var(--line);font-size:11px;color:var(--muted);display:flex;gap:12px;align-items:center}
.foot .sp{margin-left:auto}
@media(max-width:860px){.kpis{grid-template-columns:repeat(2,1fr)}.grid{grid-template-columns:1fr}}
`

// ECharts dark brand theme registered before charts init.
const ECHARTS_THEME = `
echarts.registerTheme('aius', {
  color: ['#de7bff','#50f3ff','#ff7bde','#8cff7b','#ffb20d','#3eacff','#ff5d8f'],
  backgroundColor: 'transparent',
  textStyle: { fontFamily: 'Geist, Inter, sans-serif', color: '#cfd2d6' },
  title: { textStyle: { color: '#ededed' } },
  legend: { textStyle: { color: '#9aa0a6' } },
  grid: { borderColor: 'rgba(255,255,255,.08)', containLabel: true },
  categoryAxis: { axisLine:{lineStyle:{color:'rgba(255,255,255,.18)'}}, splitLine:{show:false}, axisLabel:{color:'#9aa0a6'} },
  valueAxis: { axisLine:{lineStyle:{color:'rgba(255,255,255,.18)'}}, splitLine:{lineStyle:{color:'rgba(255,255,255,.06)'}}, axisLabel:{color:'#9aa0a6'} },
  tooltip: { backgroundColor:'#171717', borderColor:'rgba(255,255,255,.12)', textStyle:{color:'#ededed'} }
})
`

const renderHead = (title: string) => `
<head>
  <meta charset="utf-8" />
  <title>${escapeHtml(title)}</title>
  <meta name="generator" content="Aius" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Geist:wght@400;450;500;600;700&family=Geist+Mono:wght@400;500&display=swap" rel="stylesheet" />
  <script src="https://cdn.jsdelivr.net/npm/echarts@5.5.1/dist/echarts.min.js"></script>
  <style>${STYLE}</style>
  <style>${DASH_CSS}</style>
</head>`

const renderKpis = (metrics: readonly Metric[]) =>
  metrics.length === 0
    ? ""
    : `<div class="h-sec">Headline metrics</div><div class="kpis">${metrics
        .map(
          (m) =>
            `<div class="kpi"><div class="lbl">${escapeHtml(m.label)}</div><div class="val">${escapeHtml(m.value)}</div>${m.delta ? `<div class="delta${m.positive === false ? " down" : ""}">${escapeHtml(m.delta)}</div>` : ""}</div>`,
        )
        .join("")}</div>`

const renderCharts = (charts: readonly Chart[]) => {
  if (charts.length === 0) return ""
  const cards = charts
    .map(
      (c, i) =>
        `<div class="card${c.span === "full" ? " full" : ""}"><div class="ct">${escapeHtml(c.title)}</div><div class="chart" id="chart-${i}"></div>${c.caption ? `<div class="cap">${escapeHtml(c.caption)}</div>` : ""}</div>`,
    )
    .join("")
  const init = charts
    .map(
      // Escape `<` so a `</script>` inside chart data can't break out of the
      // inline <script> tag — the agent composes options from data it doesn't
      // fully control, so neutralise it here rather than trusting the input.
      (c, i) =>
        `(function(){var el=document.getElementById('chart-${i}');var ch=echarts.init(el,'aius');ch.setOption(${JSON.stringify(c.option).replace(/</g, "\\u003c")});window.addEventListener('resize',function(){ch.resize()});})();`,
    )
    .join("\n")
  return `<div class="h-sec">Charts</div><div class="grid">${cards}</div><script>${ECHARTS_THEME}\n${init}</script>`
}

const renderFigures = (figures: readonly Figure[]) =>
  figures.length === 0
    ? ""
    : `<div class="h-sec">Figures</div><div class="grid">${figures
        .map(
          (f) =>
            `<div class="card"><div class="ct">${escapeHtml(f.title)}</div><img alt="${escapeHtml(f.title)}" src="data:image/${f.format ?? "png"};base64,${f.base64}" />${f.caption ? `<div class="cap">${escapeHtml(f.caption)}</div>` : ""}</div>`,
        )
        .join("")}</div>`

const renderSlices = (d: Dashboard) => {
  if (!d.slice_table) return ""
  const cols = d.slice_table.columns
  const head = `<tr><th>Slice</th><th class="num">n</th>${cols.map((c) => `<th class="num">${escapeHtml(c)}</th>`).join("")}</tr>`
  const body = d.slice_table.rows
    .map((r) => {
      const cells = cols
        .map((c) => {
          const v = r.values[c]
          return `<td class="num">${escapeHtml(typeof v === "number" ? numFmt(v) : v == null ? "—" : String(v))}</td>`
        })
        .join("")
      return `<tr><td>${escapeHtml(r.slice)}</td><td class="num">${r.n ?? "—"}</td>${cells}</tr>`
    })
    .join("")
  return `<div class="h-sec">${escapeHtml(d.slice_table.caption)}</div><div class="card full"><table class="tbl"><thead>${head}</thead><tbody>${body}</tbody></table></div>`
}

const renderFeatures = (d: Dashboard) => {
  if (!d.feature_table || d.feature_table.rows.length === 0) return ""
  const max = Math.max(...d.feature_table.rows.map((r) => Math.abs(r.importance)))
  const rows = d.feature_table.rows
    .map((r) => {
      const w = Math.max(2, Math.round((Math.abs(r.importance) / max) * 100))
      return `<div class="feat"><div>${escapeHtml(r.name)}<div class="bar"><span style="width:${w}%"></span></div></div><div class="num">${numFmt(r.importance)}</div><div class="dir">${r.direction ?? "0"}</div></div>`
    })
    .join("")
  return `<div class="h-sec">${escapeHtml(d.feature_table.caption)}</div><div class="card full">${rows}</div>`
}

const renderMethodology = (d: Dashboard) =>
  d.methodology.length === 0
    ? ""
    : `<div class="h-sec">Methodology</div>${d.methodology
        .map((m) => {
          const [head, ...rest] = m.split("\n")
          const body = rest.join("\n").trim()
          return `<details class="meth"><summary>${escapeHtml(head)}</summary>${body ? `<div>${escapeHtml(body)}</div>` : ""}</details>`
        })
        .join("")}`

export const render = (d: Dashboard): string => {
  const goal = d.goal
  return `<!doctype html>
<html lang="en">
${renderHead(`${goal.title} — Aius`)}
<body>
  <div class="wrap">
    <div class="eyebrow"><span class="dot" style="background:#8cff7b"></span><span class="dot" style="background:#ff7bde"></span><span class="dot" style="background:#3eacff"></span><span>Aius · Goal ${escapeHtml(goal.id)} · ${escapeHtml(goal.slug)}</span></div>
    <h1 class="title">${escapeHtml(goal.title)}</h1>
    <p class="subtitle">${escapeHtml(d.subtitle ?? goal.outcome)}</p>
    <div class="pills">${d.success_outcomes
      .map(
        (o) =>
          `<span class="pill ${pillStatusClass(o.status)}"><span class="sw"></span>${escapeHtml(o.metric)} · ${escapeHtml(o.target)} → ${escapeHtml(o.achieved)} · ${pillStatusLabel(o.status)}</span>`,
      )
      .join("")}</div>
${renderKpis(d.primary_metrics)}
${renderCharts(d.charts ?? [])}
${renderFigures(d.figures)}
${renderSlices(d)}
${renderFeatures(d)}
${renderMethodology(d)}
    <div class="foot"><span>Generated by Aius</span><span>·</span><span>${escapeHtml(d.generated_at)}</span>${d.commit_sha ? `<span>·</span><span>commit ${escapeHtml(d.commit_sha)}</span>` : ""}<span class="sp">seed=42</span></div>
  </div>
</body>
</html>
`
}

export const outputPath = (projectRoot: string, slug: string) => path.join(projectRoot, "output", "dashboards", `${slug}.html`)

export const write = async (projectRoot: string, dashboard: Dashboard): Promise<string> => {
  const dest = outputPath(projectRoot, dashboard.goal.slug)
  await Bun.write(dest, render(dashboard))
  return dest
}

export * as Render from "./render"
