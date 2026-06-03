import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { Render } from "../../src/dashboard/render"
import type { Goal } from "../../src/ds/goals"

const tmp = async () => {
  const dir = path.join(os.tmpdir(), "aius-render-" + Math.random().toString(36).slice(2))
  await fs.mkdir(path.join(dir, "output", "dashboards"), { recursive: true })
  return dir
}

const goal: Goal = {
  id: "g1",
  slug: "predict-viewability",
  type: "modeling",
  title: "Predict ad viewability",
  outcome: "A calibrated classifier surfacing P(viewable) per impression.",
  success_criteria: [
    { metric: "ROC AUC", target: ">= 0.78", rationale: "Brief benchmark" },
  ],
  data: { source: "data/raw/main.parquet", target: "viewable" },
  tooling: { intent: "result", primary: "sklearn:LogisticRegression" },
  deliverables: ["notebook", "dashboard"],
}

const baseDashboard = (): Render.Dashboard => ({
  goal,
  generated_at: "2026-05-28T12:00:00Z",
  commit_sha: "abc1234",
  subtitle: "Holdout performance and where the model wins.",
  primary_metrics: [
    { label: "ROC AUC", value: "0.812", delta: "+0.04 vs baseline", positive: true },
    { label: "Brier score", value: "0.182" },
  ],
  success_outcomes: [
    { metric: "ROC AUC", target: ">= 0.78", achieved: "0.812", status: "met" },
  ],
  charts: [
    {
      title: "ROC curve",
      option: { xAxis: { type: "value" }, yAxis: { type: "value" }, series: [{ type: "line", data: [[0, 0], [1, 1]] }] },
      span: "full",
      caption: "Mean across folds",
    },
  ],
  figures: [
    { title: "SHAP summary", base64: "iVBORw0KGgoAAAANSUhEUgAA", format: "png", caption: "Test fold 1" },
  ],
  slice_table: {
    caption: "AUC by placement (top 5)",
    columns: ["AUC", "Calibration"],
    rows: [
      { slice: "Home", n: 12000, values: { AUC: 0.81, Calibration: 0.19 } },
      { slice: "Article", n: 7500, values: { AUC: 0.78, Calibration: 0.22 } },
    ],
  },
  feature_table: {
    caption: "Top features (SHAP)",
    rows: [
      { name: "creative_size", importance: 0.34, direction: "+" },
      { name: "placement_floor", importance: -0.21, direction: "-" },
    ],
  },
  methodology: [
    "Cleaning\nDropped 12 dupes, coerced 4 datetimes, median-imputed 3 numeric columns.",
    "Modeling\nLogisticRegression with class_weight='balanced', 5-fold StratifiedKFold, seed=42.",
  ],
})

describe("Render.render", () => {
  test("produces a self-contained HTML document", () => {
    const html = Render.render(baseDashboard())
    expect(html).toMatch(/^<!doctype html>/i)
    expect(html).toMatch(/<html lang="en">/)
    expect(html).toMatch(/<\/html>/)
  })

  test("loads ECharts and applies the Aius dark brand chrome", () => {
    const html = Render.render(baseDashboard())
    expect(html).toMatch(/cdn\.jsdelivr\.net\/npm\/echarts@5\.5\.1/)
    // Dark brand tokens win over the shared light style.css via the cascade.
    expect(html).toMatch(/--bg:#0a0a0a/)
    expect(html).toMatch(/--violet:#de7bff/)
    expect(html).toMatch(/--cyan:#50f3ff/)
    // Gradient wordmark title.
    expect(html).toMatch(/h1\.title\{[^}]*background:linear-gradient/)
  })

  test("registers the aius theme and initialises each chart with its option", () => {
    const html = Render.render(baseDashboard())
    expect(html).toMatch(/echarts\.registerTheme\('aius'/)
    expect(html).toMatch(/echarts\.init\(el,'aius'\)/)
    expect(html).toMatch(/id="chart-0"/)
    // The raw option object is passed straight through to setOption.
    expect(html).toMatch(/ch\.setOption\(\{"xAxis"/)
    expect(html).toMatch(/"type":"line"/)
  })

  test("escapes `<` in chart options so data can't break out of the script tag", () => {
    const d: Render.Dashboard = { ...baseDashboard(), charts: [{ title: "x", option: { evil: "</script><img src=x>" } }] }
    const html = Render.render(d)
    expect(html).not.toMatch(/<\/script><img src=x>/)
    expect(html).toMatch(/\\u003c\/script>/)
  })

  test("omits the chart block entirely when there are no charts", () => {
    const html = Render.render({ ...baseDashboard(), charts: [] })
    expect(html).not.toMatch(/echarts\.registerTheme/)
    expect(html).not.toMatch(/echarts\.init/)
  })

  test("renders the goal title, subtitle, and success outcome pills", () => {
    const html = Render.render(baseDashboard())
    expect(html).toMatch(/Predict ad viewability/)
    expect(html).toMatch(/Holdout performance and where the model wins\./)
    expect(html).toMatch(/ROC AUC · &gt;= 0\.78 → 0\.812 · met/)
    expect(html).toMatch(/class="pill ok"/)
  })

  test("renders KPI tiles and figures", () => {
    const html = Render.render(baseDashboard())
    expect(html).toMatch(/class="kpi"/)
    expect(html).toMatch(/0\.812/)
    expect(html).toMatch(/\+0\.04 vs baseline/)
    expect(html).toMatch(/data:image\/png;base64,iVBORw0KGgo/)
  })

  test("renders the slice table with tabular data", () => {
    const html = Render.render(baseDashboard())
    expect(html).toMatch(/AUC by placement \(top 5\)/)
    expect(html).toMatch(/class="tbl"/)
    expect(html).toMatch(/Home/)
    expect(html).toMatch(/0\.81/)
  })

  test("renders feature importance bars with direction markers", () => {
    const html = Render.render(baseDashboard())
    expect(html).toMatch(/creative_size/)
    expect(html).toMatch(/class="feat"/)
    expect(html).toMatch(/class="bar"/)
    expect(html).toMatch(/<div class="dir">\+<\/div>/)
    expect(html).toMatch(/<div class="dir">-<\/div>/)
  })

  test("renders methodology as collapsible details", () => {
    const html = Render.render(baseDashboard())
    expect(html).toMatch(/<details class="meth"><summary>Cleaning<\/summary>/)
    expect(html).toMatch(/<details class="meth"><summary>Modeling<\/summary>/)
    expect(html).toMatch(/StratifiedKFold/)
  })

  test("renders the footer with generated_at and commit sha", () => {
    const html = Render.render(baseDashboard())
    expect(html).toMatch(/Generated by Aius/)
    expect(html).toMatch(/2026-05-28T12:00:00Z/)
    expect(html).toMatch(/commit abc1234/)
  })

  test("escapes user-supplied strings so injection is impossible", () => {
    const dirty = baseDashboard()
    dirty.goal = { ...dirty.goal, title: '<script>alert("x")</script>' }
    const html = Render.render(dirty)
    expect(html).not.toMatch(/<script>alert/)
    expect(html).toMatch(/&lt;script&gt;alert/)
  })
})

describe("Render.write", () => {
  test("writes the HTML to output/dashboards/<slug>.html", async () => {
    const dir = await tmp()
    const dest = await Render.write(dir, baseDashboard())
    expect(dest).toBe(path.join(dir, "output", "dashboards", "predict-viewability.html"))
    const body = await Bun.file(dest).text()
    expect(body).toMatch(/Predict ad viewability/)
    await fs.rm(dir, { recursive: true, force: true })
  })
})
