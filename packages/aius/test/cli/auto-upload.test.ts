import { expect, test } from "bun:test"
import { autoUploadEnabled } from "@/cli/auto-upload"

test("autoUploadEnabled defaults ON when the var is unset", () => {
  expect(autoUploadEnabled({})).toBe(true)
})

test("autoUploadEnabled is OFF for falsey values (case/space-insensitive)", () => {
  for (const v of ["0", "false", "no", "off", "FALSE", " Off "]) {
    expect(autoUploadEnabled({ AIUS_AUTO_UPLOAD_ARTIFACTS: v })).toBe(false)
  }
})

test("autoUploadEnabled is ON for truthy/other values", () => {
  for (const v of ["1", "true", "yes", "on", "anything"]) {
    expect(autoUploadEnabled({ AIUS_AUTO_UPLOAD_ARTIFACTS: v })).toBe(true)
  }
})
