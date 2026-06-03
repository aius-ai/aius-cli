import HomeFooter from "../feature-plugins/home/footer"
import SidebarFooter from "../feature-plugins/sidebar/footer"
import PluginManager from "../feature-plugins/system/plugins"
import Notifications from "../feature-plugins/system/notifications"
import SessionV2Debug from "../feature-plugins/system/session-v2"
import WhichKey from "../feature-plugins/system/which-key"
import DiffViewer from "../feature-plugins/system/diff-viewer"
import type { TuiPlugin, TuiPluginModule } from "@aius-ai/plugin/tui"
import type { RuntimeFlags } from "@/effect/runtime-flags"

export type InternalTuiPlugin = Omit<TuiPluginModule, "id"> & {
  id: string
  tui: TuiPlugin
  enabled?: boolean
}

export function internalTuiPlugins(flags: Pick<RuntimeFlags.Info, "experimentalEventSystem">): InternalTuiPlugin[] {
  return [
    HomeFooter,
    SidebarFooter,
    Notifications,
    PluginManager,
    WhichKey,
    DiffViewer,
    ...(flags.experimentalEventSystem ? [SessionV2Debug] : []),
  ]
}
