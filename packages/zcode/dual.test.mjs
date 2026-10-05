// A dual account (a GLM Coding Plan and gift plans) shows both allowances on
// its card and spends the gift first: a request for a model the gift serves
// goes to the Start Plan, dressed as ZCode's; when the gift says it is spent
// the same request is replayed once to the coding plan, undressed, and that
// model keeps to the coding plan for a minute. Anything else the gift says
// (its 405, its "unusual activity") stands as the answer. Nothing leaves the
// machine: the plugin's fetch is the fake here.
import { afterEach, beforeEach, expect, test } from "bun:test"
import { homedir, tmpdir } from "node:os"
import { realpathSync } from "node:fs"

let ZCodeAuthPlugin, _internal
async function setup() {
  if (![tmpdir(), realpathSync(tmpdir())].some((t) => homedir().startsWith(t))) throw new Error("run with HOME=$(mktemp -d) bun test")
  ;({ ZCodeAuthPlugin, _internal } = await import("./index.mjs"))
}
await setup()

const jwt = ["{}", JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })].map((s) => Buffer.from(s).toString("base64url")).join(".") + ".sig"
const DEVICE = "11111111-2222-4333-8444-555555555555"
const KEY = "dual.secret"
const now = Math.trunc(Date.now() / 1000)
// a gift whose only live bucket serves glm-5.3-flash, a quarter used
const balance = {
  server_time: now,
  plans: [{ plan_id: "zai-start-plan", user_plan_id: "up1", name: "Start Plan", status: "active", ends_at: now + 7 * 86400,
    entitlements: [{ entitlement_id: "e1", period: "daily" }] }],
  balances: [{ plan_id: "zai-start-plan", user_plan_id: "up1", entitlement_id: "e1", show_name: "Trust Build", capabilities: ["model:glm-5.3-flash"],
    total_units: 1000, used_units: 250, remaining_units: 750, expires_at: now + 3600 }],
}
const coding = { type: "oauth", access: KEY, refresh: JSON.stringify({ site: "zai", base: "https://api.z.ai/api/anthropic", key: KEY, jwt, device: DEVICE, plan: "GLM Coding Pro" }), expires: 0 }

const sent = []
const answers = {}
const real = globalThis.fetch
beforeEach(async () => {
  _internal.routes.clear()
  _internal.blocked.clear()
  sent.length = 0
  for (const k of Object.keys(answers)) delete answers[k]
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    const c = { path: url.pathname, origin: url.origin, method: init.method ?? (input instanceof Request ? input.method : "GET"), headers: Object.fromEntries(new Headers(init.headers ?? (input instanceof Request ? input.headers : {}))), body: init.body ?? await (input.body ? input.text() : undefined) }
    sent.push(c)
    const a = answers[c.path]
    if (!a) return new Response("", { status: 404 })
    return a instanceof Response ? a.clone() : typeof a === "function" ? await a(c) : a.clone()
  }
})
afterEach(() => (globalThis.fetch = real))
const ok = (data) => new Response(JSON.stringify({ code: 0, data }))

function planAndBalance() {
  answers["/api/biz/subscription/list"] = ok([{ productName: "GLM Coding Pro", status: "VALID" }])
  answers["/api/v1/zcode-plan/billing/balance"] = ok(balance)
}
const hooks = async () => (await ZCodeAuthPlugin({ client: { auth: { set: async () => {} } } })).auth
const loader = async () => (await hooks()).loader(async () => coding, { id: "zcode" })
async function sendTo(url, body) {
  const opts = await loader()
  return opts.fetch(url, { method: "POST", headers: { "content-type": "application/json", "x-api-key": "zcode", "anthropic-version": "2023-06-01" }, body })
}
const MSG = "https://api.z.ai/api/anthropic/v1/messages"
const body = (model) => JSON.stringify({ model, max_tokens: 100, messages: [{ role: "user", content: "hi" }] })

test("the card shows the Coding windows and the gift's buckets together", async () => {
  planAndBalance()
  answers["/api/monitor/usage/quota/limit"] = ok({ level: "pro", limits: [{ type: "CREDIT_LIMIT", unit: 3, number: 5, usage: 2000, remaining: 1500, percentage: 25 }] })
  const u = await (await hooks()).usage(async () => coding, { id: "zcode" })
  expect(u.plan).toBe("GLM Coding Pro")
  expect(u.signIn).toBe("kept")
  expect(u.error).toBeUndefined()
  expect(u.windows.map((w) => w.name)).toEqual(["5 hours", "Start Plan · Trust Build"])
  expect(u.windows[1]).toMatchObject({ used: 25, display: "250 / 1000", models: ["glm-5.3-flash"] })
  // shown, but set aside: spending the gift must not bench the account,
  // since the coding plan serves the same model (the fetch hook replays
  // a spent gift to it)
  expect(u.windows[1].aside).toBe(true)
  expect(u.until).toBeUndefined()
  expect(u.renew).toBeUndefined()
  expect(u.windows[1].resetsAt).toBe(new Date((now + 3600) * 1000).toISOString())
})

test("a spent gift window stays on the card, aside, so the account is not benched", async () => {
  answers["/api/biz/subscription/list"] = ok([{ productName: "GLM Coding Pro", status: "VALID" }])
  answers["/api/monitor/usage/quota/limit"] = ok({ limits: [{ type: "CREDIT_LIMIT", unit: 6, number: 1, percentage: 97 }] })
  answers["/api/v1/zcode-plan/billing/balance"] = ok({
    server_time: now,
    plans: [{ plan_id: "zai-start-plan", user_plan_id: "up1", name: "Start Plan", status: "active", ends_at: now + 86400,
      entitlements: [{ entitlement_id: "e1", period: "daily" }] }],
    balances: [{ plan_id: "zai-start-plan", user_plan_id: "up1", entitlement_id: "e1", show_name: "Trust Build", capabilities: ["model:glm-5.3-flash"],
      total_units: 100000000, used_units: 100000000, remaining_units: 0, expires_at: now + 3600 }],
  })
  const u = await (await hooks()).usage(async () => coding, { id: "zcode" })
  const gift = u.windows.find((w) => w.name === "Start Plan · Trust Build")
  expect(gift).toMatchObject({ used: 100, aside: true })
})

test("a gift read that fails after the gift was known leaves just the Coding card", async () => {
  answers["/api/biz/subscription/list"] = ok([{ productName: "GLM Coding Pro", status: "VALID" }])
  answers["/api/monitor/usage/quota/limit"] = ok({ limits: [{ type: "CREDIT_LIMIT", unit: 3, number: 5, usage: 2000, remaining: 1500, percentage: 25 }] })
  answers["/api/v1/zcode-plan/billing/balance"] = ok(balance)
  await (await hooks()).usage(async () => coding, { id: "zcode" }) // reads and caches the gift
  answers["/api/v1/zcode-plan/billing/balance"] = new Response("", { status: 500 })
  const u = await (await hooks()).usage(async () => coding, { id: "zcode" })
  expect(u.windows.map((w) => w.name)).toEqual(["5 hours"])
  expect(u.error).toBeUndefined()
})

test("a model the gift serves goes to the Start Plan, dressed", async () => {
  planAndBalance()
  answers["/api/v1/zcode-plan/anthropic/v1/messages"] = ok({ type: "message", content: [] })
  const res = await sendTo(MSG, body("glm-5.3-flash"))
  expect(res.status).toBe(200)
  expect(sent.length).toBe(3) // the plan list and the balance read, then the message
  const m = sent.at(-1)
  expect(m.origin).toBe("https://zcode.z.ai")
  expect(m.path).toBe("/api/v1/zcode-plan/anthropic/v1/messages")
  expect(m.headers["x-title"]).toBe("Z Code@cli")
  expect(m.headers.authorization).toBe("Bearer " + jwt)
  expect(m.headers["x-api-key"]).toBeUndefined()
  expect(JSON.parse(m.body).system.length).toBeGreaterThan(1) // dressed
})

test("a model the gift does not serve goes to the coding plan as sent", async () => {
  planAndBalance()
  answers["/api/anthropic/v1/messages"] = ok({ type: "message", content: [] })
  const res = await sendTo(MSG, body("GLM-5.3"))
  expect(res.status).toBe(200)
  const m = sent.at(-1)
  expect(m.origin).toBe("https://api.z.ai")
  expect(m.path).toBe("/api/anthropic/v1/messages")
  expect(m.body).toBe(body("GLM-5.3"))
  expect(m.headers["x-api-key"]).toBe(KEY)
  expect(m.headers["x-title"]).toBeUndefined()
})

test("a spent gift replays the request once to the coding plan, undressed", async () => {
  planAndBalance()
  answers["/api/v1/zcode-plan/anthropic/v1/messages"] = new Response(JSON.stringify({ error: { code: "1113", message: "Insufficient balance or no resource package" } }), { status: 429 })
  answers["/api/anthropic/v1/messages"] = ok({ type: "message", content: [] })
  const res = await sendTo(MSG, body("glm-5.3-flash"))
  expect(res.status).toBe(200)
  const m = sent.at(-1)
  expect(m.origin).toBe("https://api.z.ai")
  expect(m.body).toBe(body("glm-5.3-flash")) // the agent's body, not dressed
  expect(m.headers["x-api-key"]).toBe(KEY)
  // the second try for the same model skips the gift: kept off for a minute
  const before = sent.length
  await sendTo(MSG, body("glm-5.3-flash"))
  expect(sent.slice(before).at(-1).origin).toBe("https://api.z.ai")
})

test("a gift's 200 with a quota error replays to the coding plan too", async () => {
  planAndBalance()
  answers["/api/v1/zcode-plan/anthropic/v1/messages"] = new Response(JSON.stringify({ code: 1005, msg: "exceed quota limit", logid: "x" }), { status: 200, headers: { "content-type": "application/json" } })
  answers["/api/anthropic/v1/messages"] = ok({ type: "message", content: [] })
  const res = await sendTo(MSG, body("glm-5.3-flash"))
  expect(res.status).toBe(200)
  const m = sent.at(-1)
  expect(m.origin).toBe("https://api.z.ai")
  expect(m.body).toBe(body("glm-5.3-flash"))
})

test("a gift's 200 success answers normally: no replay", async () => {
  planAndBalance()
  const sse = new Response("data: {}\n\n", { status: 200, headers: { "content-type": "text/event-stream" } })
  answers["/api/v1/zcode-plan/anthropic/v1/messages"] = sse
  const res = await sendTo(MSG, body("glm-5.3-flash"))
  expect(res.status).toBe(200)
  expect(res.headers.get("x-magpie-sign-in")).toBe("kept")
  expect(sent.filter((c) => c.path === "/api/anthropic/v1/messages").length).toBe(0)
  expect(await res.text()).toBe("data: {}\n\n")
})

test("a gift refusal replays to the coding plan but keeps the gift unblocked", async () => {
  planAndBalance()
  answers["/api/v1/zcode-plan/anthropic/v1/messages"] = new Response(JSON.stringify({ code: "3012", msg: "unusual activity" }), { status: 405 })
  answers["/api/anthropic/v1/messages"] = ok({ type: "message", content: [] })
  const res = await sendTo(MSG, body("glm-5.3-flash"))
  expect(res.status).toBe(200)
  expect(sent.at(-1).origin).toBe("https://api.z.ai")
  expect(_internal.blocked.size).toBe(0)
  const before = sent.length
  await sendTo(MSG, body("glm-5.3-flash"))
  expect(sent.slice(before).some((c) => c.origin === "https://zcode.z.ai")).toBe(true)
})

test("a ZCode sign-in that expired after the gift was cached goes to the coding plan", async () => {
  planAndBalance()
  answers["/api/anthropic/v1/messages"] = ok({ type: "message", content: [] })
  const dead = ["{}", JSON.stringify({ exp: Math.floor(Date.now() / 1000) - 10 })].map((s) => Buffer.from(s).toString("base64url")).join(".") + ".sig"
  _internal.routes.set(KEY + "\0" + dead, { start: false, gift: { models: ["glm-5.3-flash"] }, at: Date.now(), ttl: 600_000 })
  const aged = { ...coding, refresh: JSON.stringify({ ...JSON.parse(coding.refresh), jwt: dead }) }
  const opts = await (await hooks()).loader(async () => aged, { id: "zcode" })
  const res = await opts.fetch(MSG, { method: "POST", headers: { "content-type": "application/json", "x-api-key": "zcode" }, body: body("glm-5.3-flash") })
  expect(res.status).toBe(200)
  expect(sent.at(-1).origin).toBe("https://api.z.ai")
  expect(sent.at(-1).headers["x-api-key"]).toBe(KEY)
})

test("a gift read that fails at once still trusts the plan list for ten minutes", async () => {
  answers["/api/biz/subscription/list"] = ok([{ productName: "GLM Coding Pro", status: "VALID" }])
  answers["/api/v1/zcode-plan/billing/balance"] = new Response("", { status: 500 })
  await sendTo(MSG, body("glm-5.3-flash"))
  const r = _internal.routes.get(KEY + "\0" + jwt)
  expect(r.start).toBe(false) // on the coding plan
  expect(r.gift).toBeNull() // the balance read failed: no gift known
  expect(r.ttl).toBe(600_000) // the plan list read fine: 10 minutes
})

test("a coding account with no gift keeps its 10-minute cache", async () => {
  answers["/api/biz/subscription/list"] = ok([{ productName: "GLM Coding Pro", status: "VALID" }])
  answers["/api/v1/zcode-plan/billing/balance"] = ok({ server_time: now, plans: [], balances: [] })
  answers["/api/anthropic/v1/messages"] = ok({ type: "message", content: [] })
  await sendTo(MSG, body("GLM-5.3"))
  const r = _internal.routes.get(KEY + "\0" + jwt)
  expect(r.start).toBe(false)
  expect(r.gift).toBeNull()
  expect(r.ttl).toBe(600_000) // plan list read fine: 10 minutes, not 1
})

test("a plan-list failure on a key account takes the dual route, not gift-only", async () => {
  answers["/api/biz/subscription/list"] = new Response("", { status: 500 })
  answers["/api/v1/zcode-plan/billing/balance"] = ok(balance)
  answers["/api/anthropic/v1/messages"] = ok({ type: "message", content: [] })
  await sendTo(MSG, body("GLM-5.3"))
  const r = _internal.routes.get(KEY + "\0" + jwt)
  expect(r.start).toBe(false) // dual: coding first, gift for its models
  expect(r.gift).toMatchObject({ models: ["glm-5.3-flash"] })
  expect(r.ttl).toBe(60_000) // unsure: the plan list failed
})

// several plans can be active at once: the gift is what any live plan's live
// bucket can spend, whatever the plan is named
test("every live plan spends first by its buckets' models, and the card shows them all", async () => {
  answers["/api/biz/subscription/list"] = ok([{ productName: "GLM Coding Pro", status: "VALID" }])
  answers["/api/monitor/usage/quota/limit"] = ok({ limits: [{ type: "CREDIT_LIMIT", unit: 3, number: 5, usage: 2000, remaining: 1500, percentage: 25 }] })
  answers["/api/v1/zcode-plan/billing/balance"] = ok({
    server_time: now,
    plans: [
      { plan_id: "zai-start-plan", user_plan_id: "up1", name: "Start Plan", status: "active", ends_at: now + 7 * 86400, entitlements: [{ entitlement_id: "e1", period: "daily" }] },
      { plan_id: "zai-bonus-plan", user_plan_id: "up2", name: "GLM Festival Grant", status: "active", ends_at: now + 3 * 86400, entitlements: [{ entitlement_id: "e2", period: "weekly" }] },
      { plan_id: "zai-old-plan", user_plan_id: "up3", name: "Old Grant", status: "active", ends_at: now - 86400, entitlements: [{ entitlement_id: "e3", period: "daily" }] },
    ],
    balances: [
      ...balance.balances,
      { plan_id: "zai-bonus-plan", user_plan_id: "up2", entitlement_id: "e2", show_name: "GLM-5.2", capabilities: ["model:GLM-5.2"], total_units: 100, used_units: 10, remaining_units: 90, expires_at: now + 3600 },
      { plan_id: "zai-bonus-plan", user_plan_id: "up2", entitlement_id: "e2b", show_name: "GLM-5.2 late", capabilities: ["model:glm-5.2"], total_units: 100, used_units: 100, remaining_units: 0, expires_at: now + 3600 },
      { plan_id: "zai-old-plan", user_plan_id: "up3", entitlement_id: "e3", show_name: "Old", capabilities: ["model:glm-4"], total_units: 10, used_units: 0, remaining_units: 10, expires_at: now + 3600 },
    ],
  })
  answers["/api/anthropic/v1/messages"] = ok({ type: "message", content: [] })
  answers["/api/v1/zcode-plan/anthropic/v1/messages"] = ok({ type: "message", content: [] })
  // models of both live plans go to the gift first
  for (const m of ["glm-5.3-flash", "GLM-5.2"]) {
    const before = sent.length
    expect((await sendTo(MSG, body(m))).status).toBe(200)
    expect(sent.slice(before).at(-1).origin).toBe("https://zcode.z.ai")
  }
  // the ended plan's bucket does not put GLM-4 on the gift
  const before = sent.length
  expect((await sendTo(MSG, body("GLM-4"))).status).toBe(200)
  expect(sent.slice(before).at(-1).origin).toBe("https://api.z.ai")
  // the card shows both plans' live buckets, spent ones included, none of the ended plan's
  const u = await (await hooks()).usage(async () => coding, { id: "zcode" })
  expect(u.windows.map((w) => w.name)).toEqual(["5 hours", "Start Plan · Trust Build", "GLM Festival Grant · GLM-5.2", "GLM Festival Grant · GLM-5.2 late"])
  expect(u.windows.some((w) => w.name === "Old")).toBe(false)
})

test("a gift-only account sends every request to the gift, and reads no balance to do it", async () => {
  answers["/api/v1/zcode-plan/anthropic/v1/messages"] = ok({ type: "message", content: [] })
  const only = { type: "oauth", access: jwt, refresh: JSON.stringify({ site: "zai", base: "https://api.z.ai/api/anthropic", jwt, device: DEVICE }), expires: 0 }
  const opts = await (await hooks()).loader(async () => only, { id: "zcode" })
  const res = await opts.fetch(MSG, { method: "POST", headers: { "content-type": "application/json" }, body: body("glm-5.3-flash") })
  expect(res.status).toBe(200)
  expect(sent.at(-1).origin).toBe("https://zcode.z.ai")
  expect(sent.filter((c) => c.path === "/api/v1/zcode-plan/billing/balance").length).toBe(0)
})
