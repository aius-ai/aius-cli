declare global {
  const AIUS_VERSION: string
  const AIUS_CHANNEL: string
}

export const InstallationVersion = typeof AIUS_VERSION === "string" ? AIUS_VERSION : "local"
export const InstallationChannel = typeof AIUS_CHANNEL === "string" ? AIUS_CHANNEL : "local"
export const InstallationLocal = InstallationChannel === "local"
