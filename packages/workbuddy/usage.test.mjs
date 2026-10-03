// auth.usage tells what magpie's built-in WorkBuddy usage told for the same
// answers (internal/provider/workbuddy_test.go, workbuddy_ai_test.go).
import { test, expect, afterAll, beforeAll, afterEach } from "bun:test"
import { mkdirSync, writeFileSync, readFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { realpathSync } from "node:fs"
import { join } from "node:path"

let WorkBuddyAuthPlugin, WorkBuddyAIAuthPlugin, _internal, home
beforeAll(async () => {
  // Bun reads HOME once, at start: run as HOME=$(mktemp -d) bun test, so
  // no real sign-in is ever read
  if (![tmpdir(), realpathSync(tmpdir())].some((t) => homedir().startsWith(t))) throw new Error("run with HOME=$(mktemp -d) bun test")
  home = homedir()
  ;({ WorkBuddyAuthPlugin, WorkBuddyAIAuthPlugin, _internal } = await import("./index.mjs"))
})
// nothing leaves the machine; the fetch this file found is put back when
// it is done, so the next test file (bun runs them all in one process)
// doesn't inherit offline: qoder's cn.test.mjs, taking it as the real
// fetch, sent its stand-in's requests nowhere and its sign-in polled on
const offline = async () => { throw new Error("no network in tests") }
const real = globalThis.fetch
globalThis.fetch = offline
afterAll(() => (globalThis.fetch = real))
afterEach(() => {
  globalThis.fetch = offline
  _internal.desktopHeld.clear()
})

const later = () => Date.now() + 3600_000
const ok = (data) => new Response(JSON.stringify({ code: 0, msg: "ok", data }))
// the summary as the live API sends it: capacities as strings, some fractional
const PAID = { IsPaidUser: true, Packages: [
  { PackageCode: "coding", CycleTotalCapacity: "9500", CycleRemainCapacity: "7500", CycleUsedCapacity: "2000" },
  { PackageCode: "vibe", CycleTotalCapacity: "500", CycleRemainCapacity: "0", CycleUsedCapacity: "500.00000000" },
] }

function serve(routes) {
  const calls = []
  globalThis.fetch = async (url, init) => {
    const u = new URL(String(url))
    calls.push({ url: u, init, headers: new Headers(init?.headers) })
    const r = routes[u.pathname]
    return r ? r(init) : new Response("", { status: 404 })
  }
  return calls
}
const usageOf = async (plugin, auth, client = {}) => (await plugin({ client })).auth.usage(async () => auth)

test("a paid WorkBuddy account's credits", async () => {
  const calls = serve({ "/billing/meter/get-user-resource-summary": () => ok(PAID) })
  const auth = { type: "oauth", access: "two-access", refresh: "r", expires: later(), uid: "u2", domain: "" }
  expect(await usageOf(WorkBuddyAuthPlugin, auth)).toEqual({ signIn: "kept", plan: "Pro", windows: [{ name: "Credits", used: 25, display: "2500 / 10000", amount: 2500, limit: 10000, unit: "credits" }] })
  const c = calls[0]
  expect(c.url.origin).toBe("https://copilot.tencent.com")
  expect(c.init.method).toBe("POST")
  expect(c.init.body).toBe("{}")
  expect(Object.fromEntries(["authorization", "x-user-id", "x-domain", "x-product", "x-ide-type", "user-agent"].map((h) => [h, c.headers.get(h)])))
    .toEqual({ authorization: "Bearer two-access", "x-user-id": "u2", "x-domain": "copilot.tencent.com", "x-product": "SaaS",
      "x-ide-type": "WorkBuddy", "user-agent": "WorkBuddy/5.5.6" })
})

test("a free WorkBuddy AI account, at its own site and domain", async () => {
  const calls = serve({ "/billing/meter/get-user-resource-summary": () =>
    ok({ IsPaidUser: false, Packages: [{ CycleTotalCapacity: "1000", CycleUsedCapacity: "100" }] }) })
  const auth = { type: "oauth", access: "ai-access", expires: later(), uid: "ai2", domain: "www.codebuddy.ai" }
  expect(await usageOf(WorkBuddyAIAuthPlugin, auth)).toEqual({ signIn: "kept", plan: "Free", windows: [{ name: "Credits", used: 10, display: "100 / 1000", amount: 100, limit: 1000, unit: "credits" }] })
  expect(calls[0].url.origin).toBe("https://www.workbuddy.ai")
  expect(calls[0].headers.get("x-domain")).toBe("www.codebuddy.ai")
})

test("counts and plans as Go says them", () => {
  expect(_internal.usageOf({ IsPaidUser: true, Packages: [{ CycleTotalCapacity: 3300, CycleUsedCapacity: "438.88000002" }, {}] }, "Team"))
    .toEqual({ plan: "Team", windows: [{ name: "Credits", used: (100 * 438.88000002) / 3300, display: "438.88 / 3300", amount: 438.88000002, limit: 3300, unit: "credits" }] })
  // no capacity, no window
  expect(_internal.usageOf({ IsPaidUser: false, Packages: [{ CycleTotalCapacity: "", CycleUsedCapacity: null }] }, ""))
    .toEqual({ plan: "Free", windows: [] })
  expect(() => _internal.usageOf({ Packages: [{ CycleTotalCapacity: "lots" }] })).toThrow('strconv.ParseFloat: parsing "lots": invalid syntax')
})

test("WorkBuddy's refusals are the card's error", async () => {
  const auth = { type: "oauth", access: "a", expires: later(), uid: "u" }
  serve({ "/billing/meter/get-user-resource-summary": () => new Response("", { status: 401 }) })
  expect(await usageOf(WorkBuddyAuthPlugin, auth)).toEqual({ signIn: "kept", error: "Unauthorized" })
  serve({ "/billing/meter/get-user-resource-summary": () => new Response(JSON.stringify({ code: 10085, msg: "" }), { status: 403 }) })
  expect(await usageOf(WorkBuddyAuthPlugin, auth)).toEqual({ signIn: "kept", error: "error 10085" })
  serve({ "/billing/meter/get-user-resource-summary": () => new Response(JSON.stringify({ code: 11001, msg: "token expired" })) })
  expect(await usageOf(WorkBuddyAuthPlugin, auth)).toEqual({ signIn: "kept", error: "token expired" })
  expect(await usageOf(WorkBuddyAuthPlugin, null)).toEqual({ signIn: "kept", error: "not signed in" })
})

// Go's http.StatusText has words for every status WorkBuddy may give, and
// the card must never get an empty error
test("any refused status is an error with words", async () => {
  const auth = { type: "oauth", access: "a", expires: later(), uid: "u" }
  for (const [status, said] of [[409, "Conflict"], [402, "Payment Required"], [422, "Unprocessable Entity"], [501, "Not Implemented"], [520, "HTTP 520"], [302, "Found"]]) {
    serve({ "/billing/meter/get-user-resource-summary": () => new Response("", { status }) })
    expect([status, await usageOf(WorkBuddyAuthPlugin, auth)]).toEqual([status, { error: said, signIn: "kept" }])
  }
})

test("a token near its end is renewed and saved, as the loader does", async () => {
  const sets = []
  const calls = serve({
    "/v2/plugin/auth/token/refresh": () => ok({ accessToken: "new-access", refreshToken: "new-refresh", expiresIn: 3600 }),
    "/billing/meter/get-user-resource-summary": () => ok(PAID),
  })
  const auth = { type: "oauth", access: "old-access", refresh: "old-refresh", expires: Date.now() + 1000, uid: "u2" }
  const out = await usageOf(WorkBuddyAuthPlugin, auth, { auth: { set: async (x) => sets.push(x) } })
  expect(out.windows[0].used).toBe(25)
  // the built-in's renewal took no mark off: the read keeps the sign-in
  expect(out.signIn).toBe("kept")
  expect(calls[0].headers.get("x-refresh-token")).toBe("old-refresh")
  expect(calls[1].headers.get("authorization")).toBe("Bearer new-access")
  expect(sets.length).toBe(1)
  expect(sets[0].path).toEqual({ id: "workbuddy" })
  expect(sets[0].body).toMatchObject({ access: "new-access", refresh: "new-refresh", uid: "u2" })
})

test("the desktop's sign-in is renewed in memory only", async () => {
  const dir = process.platform === "darwin" ? join(home, "Library", "Application Support", "CodeBuddyExtension")
    : process.platform === "win32" ? join(home, "AppData", "Local", "CodeBuddyExtension") : join(home, ".local", "share", "CodeBuddyExtension")
  mkdirSync(join(dir, "Data", "Public", "auth"), { recursive: true })
  const file = join(dir, "Data", "Public", "auth", "workbuddy-desktop.info")
  const info = JSON.stringify({ auth: { accessToken: "desk-old", refreshToken: "desk-refresh", expiresAt: Date.now() + 1000, domain: "www.codebuddy.cn" },
    account: { uid: "u1", nickname: "旅行者" } })
  writeFileSync(file, info)
  const sets = []
  const calls = serve({
    "/v2/plugin/auth/token/refresh": () => ok({ accessToken: "desk-new", expiresIn: 3600 }),
    "/billing/meter/get-user-resource-summary": () => ok(PAID),
  })
  const auth = { type: "oauth", access: "", refresh: "", expires: 0, source: "desktop", uid: "u1" }
  const client = { auth: { set: async (x) => sets.push(x) } }
  expect(await usageOf(WorkBuddyAuthPlugin, auth, client)).toEqual({ signIn: "kept", plan: "Pro", windows: [{ name: "Credits", used: 25, display: "2500 / 10000", amount: 2500, limit: 10000, unit: "credits" }] })
  expect(calls[1].headers.get("authorization")).toBe("Bearer desk-new")
  expect(calls[1].headers.get("x-domain")).toBe("www.codebuddy.cn")
  expect(sets).toEqual([]) // never saved,
  expect(readFileSync(file, "utf8")).toBe(info) // nor written where the app keeps it
  // and held: the next ask doesn't renew again
  await usageOf(WorkBuddyAuthPlugin, auth, client)
  expect(calls.filter((c) => c.url.pathname.endsWith("/refresh")).length).toBe(1)
})

test("a desktop sign-in with the app signed out says why it failed", async () => {
  const p = await WorkBuddyAIAuthPlugin({ client: {} })
  const m = p.auth.methods.find((x) => x.label.endsWith("desktop's sign-in"))
  const r = await (await m.authorize()).callback()
  expect(r).toEqual({ type: "failed", error: "WorkBuddy AI desktop isn't signed in" })
})

// Each model carries the credits WorkBuddy's picker shows by it, as
// magpie's built-in reads them (internal/provider/workbuddy_free_test.go,
// TestWBCreditsRate): x0.03 is 0.03, X1.00 is 1; x0.00 is free and no
// rate, and one it can't read (or an infinite one) is neither.
test("each model's rate is its credits", async () => {
  for (const plugin of [WorkBuddyAuthPlugin, WorkBuddyAIAuthPlugin]) {
    const calls = serve({ "/v3/config": () => ok({
      agents: [{ name: "cli", models: ["deepseek-v4.1-flash", "deepseek-v4.1-flash-sg", "gpt-5.5", "kimi-k3", "hy3", "odd", "inf"] }],
      models: [
        { id: "deepseek-v4.1-flash", name: "Deepseek-V4.1-Flash", credits: "x0.00" },
        { id: "deepseek-v4.1-flash-sg", name: "Deepseek-V4.1-Flash SG", credits: "x0.03" },
        { id: "gpt-5.5", credits: "X1.00" },
        { id: "kimi-k3", credits: 1.5 },
        { id: "hy3" },
        { id: "odd", credits: "lots" },
        { id: "inf", credits: "xInfinity" },
      ],
    }) })
    const hooks = await plugin({ client: {} })
    const auth = { type: "oauth", access: "a", refresh: "r", expires: later(), uid: "u", domain: "" }
    const ms = await hooks.provider.models({ id: hooks.auth.provider, models: {} }, { auth })
    expect(calls.map((c) => c.url.pathname)).toEqual(["/v3/config"])
    expect(Object.fromEntries(Object.entries(ms).map(([k, m]) => [k, [m.rate, m.free]]))).toEqual({
      "deepseek-v4.1-flash": [0, true],
      "deepseek-v4.1-flash-sg": [0.03, false],
      "gpt-5.5": [1, false],
      "kimi-k3": [1.5, false],
      hy3: [0, false],
      odd: [0, false],
      inf: [0, false],
    })
  }
  const { creditsOf } = _internal
  expect(["x0.03", " X1.00 ", 1.5, "0"].map(creditsOf)).toEqual([0.03, 1, 1.5, 0])
  for (const c of ["", null, undefined, "free", "x-1", "Infinity"]) expect(creditsOf(c)).toBeUndefined()
})
