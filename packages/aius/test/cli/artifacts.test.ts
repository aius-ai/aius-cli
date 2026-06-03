import { expect, test, afterAll } from "bun:test"
import { mkdtemp, mkdir, writeFile, rm, symlink } from "fs/promises"
import { tmpdir } from "os"
import path from "path"
import {
  walkOutputDir,
  encodeBase64,
  toPosix,
  fetchClients,
  fetchProjects,
  uploadArtifact,
  diffManifest,
  resolveProject,
  ArtifactsApiError,
  DEFAULT_MAX_BYTES,
  type Manifest,
} from "@/cli/cmd/artifacts"

const dirs: string[] = []
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true })
})

async function fixture(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "aius-artifacts-"))
  dirs.push(root)
  return root
}

test("walkOutputDir finds files recursively with POSIX relative paths", async () => {
  const root = await fixture()
  await mkdir(path.join(root, "reports"), { recursive: true })
  await mkdir(path.join(root, "notebooks", "deep"), { recursive: true })
  await writeFile(path.join(root, "top.txt"), "a")
  await writeFile(path.join(root, "reports", "analysis.ipynb"), "b")
  await writeFile(path.join(root, "notebooks", "deep", "x.py"), "c")

  const { files, skipped } = await walkOutputDir(root)
  expect(skipped).toHaveLength(0)
  expect(files.map((f) => f.relative)).toEqual(["notebooks/deep/x.py", "reports/analysis.ipynb", "top.txt"])
  // relative paths never contain a backslash, even on win32
  for (const f of files) expect(f.relative).not.toContain("\\")
})

test("walkOutputDir partitions oversized files into skipped (max-bytes)", async () => {
  const root = await fixture()
  await writeFile(path.join(root, "small.txt"), "x".repeat(10))
  await writeFile(path.join(root, "big.bin"), "x".repeat(100))

  const { files, skipped } = await walkOutputDir(root, 50)
  expect(files.map((f) => f.relative)).toEqual(["small.txt"])
  expect(skipped.map((f) => f.relative)).toEqual(["big.bin"])
  expect(skipped[0].size).toBe(100)
})

test("walkOutputDir does not follow symlinks", async () => {
  const root = await fixture()
  await writeFile(path.join(root, "real.txt"), "real")
  try {
    await symlink(path.join(root, "real.txt"), path.join(root, "link.txt"))
  } catch {
    return // symlinks unsupported on this platform; skip
  }
  const { files } = await walkOutputDir(root)
  expect(files.map((f) => f.relative)).toEqual(["real.txt"])
})

test("walkOutputDir on empty dir returns nothing", async () => {
  const root = await fixture()
  const { files, skipped } = await walkOutputDir(root)
  expect(files).toHaveLength(0)
  expect(skipped).toHaveLength(0)
})

test("encodeBase64 round-trips file bytes", () => {
  const bytes = new TextEncoder().encode("hello world")
  const b64 = encodeBase64(bytes)
  expect(b64).toBe("aGVsbG8gd29ybGQ=")
  expect(Buffer.from(b64, "base64").toString("utf8")).toBe("hello world")
})

test("toPosix normalizes separators", () => {
  expect(toPosix(["a", "b", "c"].join(path.sep))).toBe("a/b/c")
})

test("DEFAULT_MAX_BYTES is ~10 MB", () => {
  expect(DEFAULT_MAX_BYTES).toBe(10 * 1024 * 1024)
})

// ── HTTP: fetchClients ───────────────────────────────────────────────────────

test("fetchClients unwraps the data envelope and sends a bearer", async () => {
  let seen: { url: string; auth: string | null } | undefined
  const mock = (async (input: RequestInfo | URL, init?: RequestInit) => {
    seen = { url: String(input), auth: new Headers(init?.headers).get("Authorization") }
    return new Response(JSON.stringify({ data: [{ id: "org_1", name: "Acme" }, { id: "org_2" }] }), { status: 200 })
  }) as typeof fetch
  const clients = await fetchClients("https://api.example/v1", "aius_tok", mock)
  expect(clients[0].id).toBe("org_1")
  expect(seen?.url).toBe("https://api.example/v1/clients")
  expect(seen?.auth).toBe("Bearer aius_tok")
})

test("fetchClients accepts a bare array response", async () => {
  const mock = (async () => new Response(JSON.stringify([{ id: "org_x" }]), { status: 200 })) as unknown as typeof fetch
  const clients = await fetchClients("https://api.example/v1", "t", mock)
  expect(clients[0].id).toBe("org_x")
})

test("fetchClients maps 401 to an actionable error", async () => {
  const mock = (async () => new Response("nope", { status: 401 })) as unknown as typeof fetch
  await expect(fetchClients("https://api.example/v1", "t", mock)).rejects.toThrow(ArtifactsApiError)
  await expect(fetchClients("https://api.example/v1", "t", mock)).rejects.toThrow(/auth login/)
})

// ── HTTP: uploadArtifact ─────────────────────────────────────────────────────

test("uploadArtifact posts the expected JSON body", async () => {
  let body: any
  const mock = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    body = JSON.parse(String(init?.body))
    return new Response(JSON.stringify({ id: "art_1" }), { status: 200 })
  }) as typeof fetch
  await uploadArtifact(
    "https://api.example/v1",
    "tok",
    { orgId: "org_1", relativePath: "reports/a.ipynb", contentBase64: "aGk=" },
    mock,
  )
  expect(body).toEqual({ org_id: "org_1", path: "reports/a.ipynb", content_base64: "aGk=" })
})

test("uploadArtifact includes content_type only when provided", async () => {
  let body: any
  const mock = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    body = JSON.parse(String(init?.body))
    return new Response("{}", { status: 200 })
  }) as typeof fetch
  await uploadArtifact(
    "https://api.example/v1",
    "tok",
    { orgId: "o", relativePath: "p", contentBase64: "x", contentType: "text/plain" },
    mock,
  )
  expect(body.content_type).toBe("text/plain")
})

test("uploadArtifact surfaces a non-2xx as ArtifactsApiError with status", async () => {
  const mock = (async () => new Response("boom", { status: 500 })) as unknown as typeof fetch
  try {
    await uploadArtifact("https://api.example/v1", "t", { orgId: "o", relativePath: "p", contentBase64: "x" }, mock)
    throw new Error("should have thrown")
  } catch (e) {
    expect(e).toBeInstanceOf(ArtifactsApiError)
    expect((e as ArtifactsApiError).status).toBe(500)
  }
})

test("uploadArtifact includes project_id only when provided", async () => {
  let body: any
  const mock = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    body = JSON.parse(String(init?.body))
    return new Response("{}", { status: 200 })
  }) as typeof fetch
  await uploadArtifact(
    "https://api.example/v1",
    "tok",
    { orgId: "o", relativePath: "p", contentBase64: "x" },
    mock,
  )
  expect("project_id" in body).toBe(false)
  await uploadArtifact(
    "https://api.example/v1",
    "tok",
    { orgId: "o", relativePath: "p", contentBase64: "x", projectId: "proj_9" },
    mock,
  )
  expect(body.project_id).toBe("proj_9")
})

// ── diffManifest (watch core) ─────────────────────────────────────────────────

test("diffManifest uploads brand-new files", () => {
  const prev: Manifest = {}
  const cur: Manifest = { "r/x.ipynb": { size: 10, mtimeMs: 100 } }
  const { toUpload, nextManifest } = diffManifest(prev, cur)
  expect(toUpload).toEqual(["r/x.ipynb"])
  expect(nextManifest).toEqual(cur)
})

test("diffManifest skips unchanged files", () => {
  const same: Manifest = { "a.txt": { size: 3, mtimeMs: 5 }, "b.txt": { size: 4, mtimeMs: 6 } }
  const { toUpload } = diffManifest(same, { ...same })
  expect(toUpload).toEqual([])
})

test("diffManifest re-uploads when size changes", () => {
  const prev: Manifest = { "a.txt": { size: 3, mtimeMs: 5 } }
  const cur: Manifest = { "a.txt": { size: 9, mtimeMs: 5 } }
  expect(diffManifest(prev, cur).toUpload).toEqual(["a.txt"])
})

test("diffManifest re-uploads when mtime changes", () => {
  const prev: Manifest = { "a.txt": { size: 3, mtimeMs: 5 } }
  const cur: Manifest = { "a.txt": { size: 3, mtimeMs: 99 } }
  expect(diffManifest(prev, cur).toUpload).toEqual(["a.txt"])
})

test("diffManifest returns sorted toUpload and ignores deletions", () => {
  const prev: Manifest = { gone: { size: 1, mtimeMs: 1 } }
  const cur: Manifest = {
    "z.txt": { size: 1, mtimeMs: 1 },
    "a.txt": { size: 1, mtimeMs: 1 },
  }
  const { toUpload, nextManifest } = diffManifest(prev, cur)
  expect(toUpload).toEqual(["a.txt", "z.txt"])
  // deletion of `gone` is not reported; nextManifest reflects current disk state
  expect("gone" in nextManifest).toBe(false)
})

// ── fetchProjects + resolveProject ────────────────────────────────────────────

test("fetchProjects sends org_id query and unwraps the data envelope", async () => {
  let seenUrl: string | undefined
  const mock = (async (input: RequestInfo | URL) => {
    seenUrl = String(input)
    return new Response(JSON.stringify({ data: [{ id: "proj_1" }] }), { status: 200 })
  }) as typeof fetch
  const projects = await fetchProjects("https://api.example/v1", "t", "org_7", mock)
  expect(projects[0].id).toBe("proj_1")
  expect(seenUrl).toBe("https://api.example/v1/projects?org_id=org_7")
})

test("resolveProject uses the explicit project without calling the API", async () => {
  let called = false
  const mock = (async () => {
    called = true
    return new Response("{}", { status: 200 })
  }) as unknown as typeof fetch
  const r = await resolveProject("https://api.example/v1", "t", "org_1", "proj_explicit", mock)
  expect(r.projectId).toBe("proj_explicit")
  expect(r.hint).toBeUndefined()
  expect(called).toBe(false)
})

test("resolveProject auto-selects the sole project", async () => {
  const mock = (async () =>
    new Response(JSON.stringify({ data: [{ id: "proj_only" }] }), { status: 200 })) as unknown as typeof fetch
  const r = await resolveProject("https://api.example/v1", "t", "org_1", undefined, mock)
  expect(r.projectId).toBe("proj_only")
  expect(r.hint).toBeUndefined()
})

test("resolveProject returns undefined + hint for zero projects", async () => {
  const mock = (async () => new Response(JSON.stringify({ data: [] }), { status: 200 })) as unknown as typeof fetch
  const r = await resolveProject("https://api.example/v1", "t", "org_1", undefined, mock)
  expect(r.projectId).toBeUndefined()
  expect(r.hint).toContain("--project")
})

test("resolveProject returns undefined + hint for many projects", async () => {
  const mock = (async () =>
    new Response(JSON.stringify({ data: [{ id: "p1" }, { id: "p2" }] }), { status: 200 })) as unknown as typeof fetch
  const r = await resolveProject("https://api.example/v1", "t", "org_1", undefined, mock)
  expect(r.projectId).toBeUndefined()
  expect(r.hint).toContain("--project")
})

test("resolveProject falls back to org-level when the projects endpoint errors", async () => {
  const mock = (async () => new Response("boom", { status: 500 })) as unknown as typeof fetch
  const r = await resolveProject("https://api.example/v1", "t", "org_1", undefined, mock)
  expect(r.projectId).toBeUndefined()
  expect(r.hint).toBeUndefined()
})
