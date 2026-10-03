import { expect, test } from "bun:test"
import { _internal } from "./index.mjs"

const { startHasFlash, startRefused, restStart, startPriority } = _internal

// Captured from the account's real balance on 2026-10-03; no sign-in data.
const allowance = {
  plan: "ZCode Trust Build",
  windows: [{ name: "GLM-5.3-Flash", used: 0.771617, display: "771617 / 100000000", resetsAt: "2026-10-03T16:00:00.000Z", span: 86085, models: ["glm-5.3-flash"] }],
  until: "2026-10-03T16:00:00.000Z", renew: "off", signIn: "kept",
}

test("the captured Flash balance is eligible only before its end", () => {
  expect(startHasFlash(allowance, Date.parse("2026-10-03T00:00:00Z"))).toBe(true)
  expect(startHasFlash(allowance, Date.parse("2026-10-03T16:00:00Z"))).toBe(false)
  expect(startHasFlash({ ...allowance, until: "invalid" })).toBe(false)
})

test("an exhausted bucket or a different model cannot supply Flash", () => {
  const now = Date.parse("2026-10-03T00:00:00Z")
  const window = allowance.windows[0]
  expect(startHasFlash({ ...allowance, windows: [{ ...window, used: 100 }] }, now)).toBe(false)
  expect(startHasFlash({ ...allowance, windows: [{ ...window, models: ["glm-5.3"] }] }, now)).toBe(false)
  expect(startHasFlash({ ...allowance, windows: [window, { ...window, used: 100 }] }, now)).toBe(false)
  expect(startHasFlash({ ...allowance, windows: [{ ...window, display: undefined }] }, now)).toBe(false)
  expect(startHasFlash({ ...allowance, windows: [null, { ...window, models: "glm-5.3-flash" }] }, now)).toBe(false)
})

test("a missing or ended Start Plan is not eligible", () => {
  expect(startHasFlash(null)).toBe(false)
  expect(startHasFlash({ error: "inactive" })).toBe(false)
  expect(startHasFlash({ until: "2026-10-03T16:00:00Z", windows: [] }, Date.parse("2026-10-03T16:00:00Z"))).toBe(false)
})

test("Start refuses rate limits and quota failures, not arbitrary server errors", () => {
  expect(startRefused(429)).toBe(true)
  expect(startRefused(405)).toBe(true)
  expect(startRefused(502, "exceed quota limit")).toBe(true)
  expect(startRefused(502, "connection reset")).toBe(false)
  expect(startRefused(400, "invalid model")).toBe(false)
  expect(startRefused(200)).toBe(false)
})

test("retry-after supports seconds and HTTP dates and has a one-hour ceiling", () => {
  const s = { key: "", jwt: "" }
  const now = Date.parse("2026-10-03T00:00:00Z")
  try {
    restStart(s, null, now)
    expect(startPriority.get("\0").restUntil).toBe(now + 15 * 60_000)
    restStart(s, "120", now)
    expect(startPriority.get("\0").restUntil).toBe(now + 120_000)
    restStart(s, "Sat, 03 Oct 2026 00:03:00 GMT", now)
    expect(startPriority.get("\0").restUntil).toBe(now + 180_000)
    restStart(s, "7200", now)
    expect(startPriority.get("\0").restUntil).toBe(now + 60 * 60_000)
  } finally {
    startPriority.delete("\0")
  }
})
