import path from "path"
import { which } from "./which"

const uvName = process.platform === "win32" ? "uv.exe" : "uv"

// uv is bundled next to the Aius executable (dist/<platform>/bin/uv) — see
// script/build.ts. In a compiled binary `process.execPath` IS that executable,
// so a sibling `uv` is the bundled one. In dev `process.execPath` is `bun`, so
// we must NOT trust a sibling (it'd coincidentally match e.g. a brew uv next to
// bun) — only treat a sibling as bundled when we're actually the Aius binary.
const siblingUv = (exePath: string): string | null => {
  if (!/aius(\.exe)?$/i.test(exePath)) return null
  return path.join(path.dirname(exePath), uvName)
}

// Resolve the uv to use: the bundled one shipped with Aius first, then any uv
// on PATH (which() also searches Aius's managed bin dir). Returns null only if
// no uv can be found at all. The `exePath` param is a test seam.
export const resolveUv = async (exePath: string = process.execPath): Promise<string | null> => {
  const bundled = siblingUv(exePath)
  if (bundled && (await Bun.file(bundled).exists())) return bundled
  return which("uv")
}
