import path from "path"
import { Effect, Schema } from "effect"
import { InstanceState } from "@/effect/instance-state"
import { Goals } from "@/ds/goals"
import { Render } from "@/dashboard/render"
import DESCRIPTION from "./dashboard_render.txt"
import * as Tool from "./tool"

export const Parameters = Schema.Struct({
  goal_id: Schema.String.annotate({ description: "The goal id from .aius/goals.json this dashboard summarises." }),
  subtitle: Schema.optional(Schema.String).annotate({ description: "Optional one-line subtitle (defaults to the goal outcome)." }),
  primary_metrics: Schema.Array(Render.Metric).annotate({
    description: "1–4 headline KPI tiles. label/value mandatory; delta optional.",
  }),
  success_outcomes: Schema.Array(Render.SuccessOutcome).annotate({
    description: "One entry per success criterion from goals.json: metric, target, achieved, status (met|at_risk|missed).",
  }),
  charts: Schema.optional(Schema.Array(Render.Chart)).annotate({
    description:
      "Interactive ECharts charts (preferred over PNGs). Each: { title, option } where option is a raw ECharts option object (bar/line/scatter/heatmap/gauge — ROC curve, calibration, feature importance, slice metrics). Optional span: 'full'. Compose the option in your notebook and pass it through; the Aius dark theme is applied automatically.",
  }),
  figures: Schema.optional(Schema.Array(Render.Figure)).annotate({
    description: "Base64 PNG figures for things ECharts can't do (e.g. SHAP summary). Read from output/notebooks/<slug>/artifacts/ and base64-encode. Prefer charts.",
  }),
  slice_table: Schema.optional(
    Schema.Struct({
      caption: Schema.String,
      columns: Schema.Array(Schema.String),
      rows: Schema.Array(Render.SliceRow),
    }),
  ),
  feature_table: Schema.optional(
    Schema.Struct({
      caption: Schema.String,
      rows: Schema.Array(Render.FeatureRow),
    }),
  ),
  methodology: Schema.optional(Schema.Array(Schema.String)).annotate({
    description: "Collapsible details. First line = summary; remainder = body. One string per detail.",
  }),
  commit_sha: Schema.optional(Schema.String),
})

export const DashboardRenderTool = Tool.define(
  "dashboard_render",
  Effect.gen(function* () {
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, _ctx: Tool.Context) =>
        Effect.gen(function* () {
          const ins = yield* InstanceState.context
          const goalsFile = yield* Effect.promise(() => Goals.load(ins.directory)).pipe(
            Effect.catch(() => Effect.succeed(null as Goals.GoalsFile | null)),
          )
          const goal = goalsFile?.goals.find((g) => g.id === params.goal_id)
          if (!goal) {
            return {
              title: "dashboard_render: unknown goal",
              metadata: { ok: false, goal_id: params.goal_id } as Record<string, unknown>,
              output: `No goal with id "${params.goal_id}" in .aius/goals.json. Available ids: ${(goalsFile?.goals ?? []).map((g) => g.id).join(", ") || "(none)"}.`,
            }
          }

          const dashboard: Render.Dashboard = {
            goal,
            generated_at: new Date().toISOString(),
            commit_sha: params.commit_sha,
            subtitle: params.subtitle,
            charts: [...(params.charts ?? [])],
            primary_metrics: [...params.primary_metrics],
            success_outcomes: [...params.success_outcomes],
            slice_table: params.slice_table
              ? {
                  caption: params.slice_table.caption,
                  columns: [...params.slice_table.columns],
                  rows: [...params.slice_table.rows],
                }
              : undefined,
            feature_table: params.feature_table
              ? { caption: params.feature_table.caption, rows: [...params.feature_table.rows] }
              : undefined,
            figures: [...(params.figures ?? [])],
            methodology: [...(params.methodology ?? [])],
          }

          const dest = yield* Effect.promise(() => Render.write(ins.directory, dashboard))
          const rel = path.relative(ins.directory, dest)

          return {
            title: `dashboard_render: ${goal.slug}`,
            metadata: {
              ok: true,
              path: rel,
              kpis: dashboard.primary_metrics.length,
              figures: dashboard.figures.length,
              outcomes: dashboard.success_outcomes.length,
            } as Record<string, unknown>,
            output: [
              `Wrote dashboard to \`${rel}\`.`,
              `${dashboard.primary_metrics.length} KPI${dashboard.primary_metrics.length === 1 ? "" : "s"}, ${dashboard.figures.length} figure${dashboard.figures.length === 1 ? "" : "s"}, ${dashboard.success_outcomes.length} success outcome${dashboard.success_outcomes.length === 1 ? "" : "s"}.`,
              "",
              "Open it in a browser to verify before declaring the goal complete.",
            ].join("\n"),
          }
        }).pipe(Effect.orDie),
    }
  }),
)

export * as DashboardRender from "./dashboard_render"
