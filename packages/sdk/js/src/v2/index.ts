export * from "./client.js"
export * from "./server.js"

import { createAiusClient } from "./client.js"
import { createAiusServer } from "./server.js"
import type { ServerOptions } from "./server.js"

export * as data from "./data.js"

export async function createAius(options?: ServerOptions) {
  const server = await createAiusServer({
    ...options,
  })

  const client = createAiusClient({
    baseUrl: server.url,
  })

  return {
    client,
    server,
  }
}
