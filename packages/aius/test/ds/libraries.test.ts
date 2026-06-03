import { describe, expect, test } from "bun:test"
import { Init } from "../../src/ds/init"

describe("Init.LIBRARIES (fixed environment)", () => {
  test("includes the notebook runtime", () => {
    const names = Init.LIBRARIES.map((l) => l.split(/[>=<]/)[0])
    for (const lib of ["jupyter-client", "ipykernel", "nbformat", "nbclient"]) {
      expect(names).toContain(lib)
    }
  })

  test("includes the DS stack", () => {
    const names = Init.LIBRARIES.map((l) => l.split(/[>=<]/)[0])
    for (const lib of ["pandas", "numpy", "scikit-learn", "lightgbm", "matplotlib", "pyarrow"]) {
      expect(names).toContain(lib)
    }
  })
})
