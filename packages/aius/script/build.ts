#!/usr/bin/env bun

import { $ } from "bun"
import fs from "fs"
import os from "os"
import path from "path"
import { fileURLToPath } from "url"
import { createSolidTransformPlugin } from "@opentui/solid/bun-plugin"

// uv is bundled next to the Aius binary so the runtime never depends on the
// user having uv (or Python) installed — uv brings its own managed Pythons.
// resolveUv() (src/util/uv.ts) finds this sibling binary at runtime.
const UV_VERSION = "0.11.17"
const uvTriple = (osName: string, arch: "arm64" | "x64", abi?: string): string => {
  const a = arch === "arm64" ? "aarch64" : "x86_64"
  if (osName === "darwin") return `uv-${a}-apple-darwin`
  if (osName === "linux") return `uv-${a}-unknown-linux-${abi === "musl" ? "musl" : "gnu"}`
  if (osName === "win32") return `uv-${a}-pc-windows-msvc`
  throw new Error(`no uv build for ${osName}/${arch}`)
}
const uvCacheDir = path.join(os.tmpdir(), `aius-uv-${UV_VERSION}`)
const bundleUv = async (osName: string, arch: "arm64" | "x64", abi: string | undefined, binDir: string) => {
  const triple = uvTriple(osName, arch, abi)
  const isWin = osName === "win32"
  const asset = `${triple}.${isWin ? "zip" : "tar.gz"}`
  const cached = path.join(uvCacheDir, asset)
  if (!fs.existsSync(cached)) {
    fs.mkdirSync(uvCacheDir, { recursive: true })
    await $`curl -fsSL -o ${cached} https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/${asset}`
  }
  if (isWin) {
    await $`unzip -o -j ${cached} -d ${binDir}`
  } else {
    await $`tar -xzf ${cached} -C ${binDir} --strip-components=1`
    await $`chmod +x ${path.join(binDir, "uv")}`
  }
}

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const dir = path.resolve(__dirname, "..")

process.chdir(dir)

const generated = await import("./generate.ts")

import { Script } from "@aius-ai/script"
import pkg from "../package.json"

// Load migrations from migration directories
const migrationDirs = (
  await fs.promises.readdir(path.join(dir, "migration"), {
    withFileTypes: true,
  })
)
  .filter((entry) => entry.isDirectory() && /^\d{4}\d{2}\d{2}\d{2}\d{2}\d{2}/.test(entry.name))
  .map((entry) => entry.name)
  .sort()

const migrations = await Promise.all(
  migrationDirs.map(async (name) => {
    const file = path.join(dir, "migration", name, "migration.sql")
    const sql = await Bun.file(file).text()
    const match = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/.exec(name)
    const timestamp = match
      ? Date.UTC(
          Number(match[1]),
          Number(match[2]) - 1,
          Number(match[3]),
          Number(match[4]),
          Number(match[5]),
          Number(match[6]),
        )
      : 0
    return { sql, timestamp, name }
  }),
)
console.log(`Loaded ${migrations.length} migrations`)

const singleFlag = process.argv.includes("--single")
const baselineFlag = process.argv.includes("--baseline")
const skipInstall = process.argv.includes("--skip-install")
const sourcemapsFlag = process.argv.includes("--sourcemaps")
const plugin = createSolidTransformPlugin()
const skipEmbedWebUi = process.argv.includes("--skip-embed-web-ui")

const createEmbeddedWebUIBundle = async () => {
  console.log(`Building Web UI to embed in the binary`)
  const appDir = path.join(import.meta.dirname, "../../app")
  const dist = path.join(appDir, "dist")
  await $`AIUS_CHANNEL=${Script.channel} bun run --cwd ${appDir} build`
  const files = (await Array.fromAsync(new Bun.Glob("**/*").scan({ cwd: dist })))
    .map((file) => file.replaceAll("\\", "/"))
    .filter((file) => !file.endsWith(".map"))
    .sort()
  const imports = files.map((file, i) => {
    const spec = path.relative(dir, path.join(dist, file)).replaceAll("\\", "/")
    return `import file_${i} from ${JSON.stringify(spec.startsWith(".") ? spec : `./${spec}`)} with { type: "file" };`
  })
  const entries = files.map((file, i) => `  ${JSON.stringify(file)}: file_${i},`)
  return [
    `// Import all files as file_$i with type: "file"`,
    ...imports,
    `// Export with original mappings`,
    `export default {`,
    ...entries,
    `}`,
  ].join("\n")
}

const embeddedFileMap = skipEmbedWebUi ? null : await createEmbeddedWebUIBundle()

const allTargets: {
  os: string
  arch: "arm64" | "x64"
  abi?: "musl"
  avx2?: false
}[] = [
  {
    os: "linux",
    arch: "arm64",
  },
  {
    os: "linux",
    arch: "x64",
  },
  {
    os: "linux",
    arch: "x64",
    avx2: false,
  },
  {
    os: "linux",
    arch: "arm64",
    abi: "musl",
  },
  {
    os: "linux",
    arch: "x64",
    abi: "musl",
  },
  {
    os: "linux",
    arch: "x64",
    abi: "musl",
    avx2: false,
  },
  {
    os: "darwin",
    arch: "arm64",
  },
  {
    os: "darwin",
    arch: "x64",
  },
  {
    os: "darwin",
    arch: "x64",
    avx2: false,
  },
  {
    os: "win32",
    arch: "arm64",
  },
  {
    os: "win32",
    arch: "x64",
  },
  {
    os: "win32",
    arch: "x64",
    avx2: false,
  },
]

const targets = singleFlag
  ? allTargets.filter((item) => {
      if (item.os !== process.platform || item.arch !== process.arch) {
        return false
      }

      // When building for the current platform, prefer a single native binary by default.
      // Baseline binaries require additional Bun artifacts and can be flaky to download.
      if (item.avx2 === false) {
        return baselineFlag
      }

      // also skip abi-specific builds for the same reason
      if (item.abi !== undefined) {
        return false
      }

      return true
    })
  : allTargets

await $`rm -rf dist`

const binaries: Record<string, string> = {}
if (!skipInstall) {
  await $`bun install --os="*" --cpu="*" @opentui/core@${pkg.dependencies["@opentui/core"]}`
  await $`bun install --os="*" --cpu="*" @parcel/watcher@${pkg.dependencies["@parcel/watcher"]}`
}
for (const item of targets) {
  const name = [
    pkg.name,
    // changing to win32 flags npm for some reason
    item.os === "win32" ? "windows" : item.os,
    item.arch,
    item.avx2 === false ? "baseline" : undefined,
    item.abi === undefined ? undefined : item.abi,
  ]
    .filter(Boolean)
    .join("-")
  console.log(`building ${name}`)
  await $`mkdir -p dist/${name}/bin`
  await bundleUv(item.os, item.arch, item.abi, `dist/${name}/bin`)

  const localPath = path.resolve(dir, "node_modules/@opentui/core/parser.worker.js")
  const rootPath = path.resolve(dir, "../../node_modules/@opentui/core/parser.worker.js")
  const parserWorker = fs.realpathSync(fs.existsSync(localPath) ? localPath : rootPath)
  const workerPath = "./src/cli/cmd/tui/worker.ts"

  // Use platform-specific bunfs root path based on target OS
  const bunfsRoot = item.os === "win32" ? "B:/~BUN/root/" : "/$bunfs/root/"
  const workerRelativePath = path.relative(dir, parserWorker).replaceAll("\\", "/")

  await Bun.build({
    conditions: ["browser"],
    tsconfig: "./tsconfig.json",
    plugins: [plugin],
    external: ["node-gyp"],
    format: "esm",
    minify: true,
    sourcemap: sourcemapsFlag ? "linked" : "none",
    splitting: true,
    compile: {
      autoloadBunfig: false,
      autoloadDotenv: false,
      autoloadTsconfig: true,
      autoloadPackageJson: true,
      target: name.replace(pkg.name, "bun") as any,
      outfile: `dist/${name}/bin/aius`,
      execArgv: [`--user-agent=aius/${Script.version}`, "--use-system-ca", "--"],
      windows: {},
    },
    files: embeddedFileMap ? { "aius-web-ui.gen.ts": embeddedFileMap } : {},
    entrypoints: ["./src/index.ts", parserWorker, workerPath, ...(embeddedFileMap ? ["aius-web-ui.gen.ts"] : [])],
    define: {
      AIUS_VERSION: `'${Script.version}'`,
      AIUS_MIGRATIONS: JSON.stringify(migrations),
      AIUS_MODELS_DEV: generated.modelsData,
      OTUI_TREE_SITTER_WORKER_PATH: bunfsRoot + workerRelativePath,
      AIUS_WORKER_PATH: workerPath,
      AIUS_CHANNEL: `'${Script.channel}'`,
      AIUS_LIBC: item.os === "linux" ? `'${item.abi ?? "glibc"}'` : "",
      // Default api URL baked into the binary; AIUS_API_URL at runtime overrides.
      // Override per-build for prod: AIUS_API_URL=https://api.aius.co/v1 bun run … build
      AIUS_DEFAULT_API_URL: `'${process.env.AIUS_API_URL ?? "https://api.dev.aius.co/v1"}'`,
    },
  })

  // Smoke test: only run if binary is for current platform
  if (item.os === process.platform && item.arch === process.arch && !item.abi) {
    const binaryPath = `dist/${name}/bin/aius`
    console.log(`Running smoke test: ${binaryPath} --version`)
    try {
      const versionOutput = await $`${binaryPath} --version`.text()
      console.log(`Smoke test passed: ${versionOutput.trim()}`)
    } catch (e) {
      console.error(`Smoke test failed for ${name}:`, e)
      process.exit(1)
    }
  }

  await $`rm -rf ./dist/${name}/bin/tui`
  await Bun.file(`dist/${name}/package.json`).write(
    JSON.stringify(
      {
        name,
        version: Script.version,
        preferUnplugged: true,
        os: [item.os],
        cpu: [item.arch],
      },
      null,
      2,
    ),
  )
  binaries[name] = Script.version
}

if (Script.release) {
  const { createHash } = await import("node:crypto")
  for (const key of Object.keys(binaries)) {
    const ext = key.includes("linux") ? "tar.gz" : "zip"
    if (ext === "tar.gz") {
      await $`tar -czf ../../${key}.tar.gz *`.cwd(`dist/${key}/bin`)
    } else {
      await $`zip -r ../../${key}.zip *`.cwd(`dist/${key}/bin`)
    }
    // Publish a SHA-256 next to each archive so install.sh / install.ps1 can
    // verify the download before running it (sha256sum/shasum-compatible format).
    const archivePath = `dist/${key}.${ext}`
    const digest = createHash("sha256")
      .update(Buffer.from(await Bun.file(archivePath).arrayBuffer()))
      .digest("hex")
    await Bun.write(`${archivePath}.sha256`, `${digest}  ${key}.${ext}\n`)
  }
  await $`gh release upload v${Script.version} ./dist/*.zip ./dist/*.tar.gz ./dist/*.sha256 --clobber --repo ${process.env.GH_REPO}`
}

export { binaries }
