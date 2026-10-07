// The fork's entry point: GLM-5.3-Flash goes to ZCode's Start Plan first,
// and a Start turn that is refused, unreachable or spent is replayed once
// on the GLM Coding Plan with the agent's own body. Nothing leaves the
// machine: global.fetch is the fake here, and the plugin's own fetch is
// what is exercised.
import { afterEach, beforeEach, expect, test } from "bun:test"
import { homedir, tmpdir } from "node:os"
import { realpathSync } from "node:fs"

if (![tmpdir(), realpathSync(tmpdir())].some((t) => homedir().startsWith(t))) throw new Error("run with HOME=$(mktemp -d) bun test")
const fork = await import("../../index.mjs")
const { _internal: internal } = await import("./index.mjs")

const now = Math.trunc(Date.now() / 1000)
const jwt = ["{}", JSON.stringify({ exp: now + 3600 })].map((s) => Buffer.from(s).toString("base64url")).join(".") + ".sig"
const DEVICE = "11111111-2222-4333-8444-555555555555"
const KEY = "coding-key"
const state = { site: "zai", base: "https://api.z.ai/api/anthropic", key: KEY, jwt, device: DEVICE, plan: "GLM Coding Max" }
const auth = { type: "oauth", access: KEY, refresh: JSON.stringify(state), expires: 0 }
const START_MSG = "https://zcode.z.ai/api/v1/zcode-plan/anthropic/v1/messages"
const CODING_MSG = "https://api.z.ai/api/anthropic/v1/messages"
const body = JSON.stringify({ model: "GLM-5.3-Flash", max_tokens: 10, messages: [{ role: "user", content: "hi" }] })
const envelope = (data) => new Response(JSON.stringify({ code: 0, data }), { headers: { "content-type": "application/json" } })
const ok = (data) => new Response(JSON.stringify({ code: 0, data }), { headers: { "content-type": "application/json" } })
const message = (text) => Response.json({ type: "message", role: "assistant", content: [{ type: "text", text }] })

const sent = []
let balance, startReply, codingReply, preview
const real = globalThis.fetch
beforeEach(() => {
  internal.routes.clear()
  internal.blocked.clear()
  sent.length = 0
  startReply = () => message("START")
  codingReply = () => message("CODING")
  preview = { plans: [] }
  balance = {
    server_time: now,
    plans: [{ plan_id: "zai-start-plan", user_plan_id: "u1", name: "Start Plan", status: "active", ends_at: now + 86400, entitlements: [{ entitlement_id: "e1", period: "daily" }] }],
    balances: [{ plan_id: "zai-start-plan", user_plan_id: "u1", entitlement_id: "e1", show_name: "GLM-5.3-Flash", capabilities: ["model:glm-5.3-flash"], total_units: 1000, used_units: 250, remaining_units: 750, expires_at: now + 3600 }],
  }
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    const text = init.body ?? (input instanceof Request ? await input.text() : undefined)
    if (url.pathname === "/api/biz/subscription/list") return ok([{ status: "VALID", productName: "GLM Coding Max", autoRenew: true }])
    if (url.pathname === "/api/monitor/usage/quota/limit") return ok({ limits: [{ type: "CREDIT_LIMIT", unit: 6, number: 1, usage: 2000, remaining: 1800, percentage: 10 }] })
    if (url.pathname === "/api/v1/zcode-plan/billing/balance") return ok(balance)
    if (url.pathname === "/api/v1/zcode-plan/billing/preview") return ok(preview)
    if (url.pathname.endsWith("/messages")) {
      sent.push({ origin: url.origin, path: url.pathname, headers: Object.fromEntries(new Headers(init.headers ?? {})), body: text })
      return url.origin === "https://zcode.z.ai" ? startReply() : codingReply()
    }
    throw new Error("unmocked request: " + url.pathname)
  }
})
afterEach(() => { globalThis.fetch = real })

const call = async (model = "GLM-5.3-Flash", options = {}) => {
  const hooks = await fork.default({})
  const loader = await hooks.auth.loader(async () => auth, { id: "zcode" })
  const res = await loader.fetch(CODING_MSG, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...JSON.parse(body), model }), ...options })
  return { res, json: await res.clone().json().catch(() => null) }
}

test("a served Flash turn spends the Start Plan first", async () => {
  const { res, json } = await call()
  expect(res.status).toBe(200)
  expect(json.content[0].text).toBe("START")
  const turns = sent.filter((r) => r.path.endsWith("/messages"))
  expect(turns.length).toBe(1)
  expect(turns[0].origin).toBe("https://zcode.z.ai")
  expect(turns[0].headers["x-zcode-app-version"]).toBeDefined()
  expect(JSON.parse(turns[0].body).system.length).toBeGreaterThan(1)
})

test("a spent Start is replayed once on Coding, as the agent sent it", async () => {
  startReply = () => new Response(JSON.stringify({ error: { message: "exceed quota limit" } }), { status: 429, headers: { "content-type": "application/json", "retry-after": "120" } })
  const { res, json } = await call()
  expect(res.status).toBe(200)
  expect(json.content[0].text).toBe("CODING")
  const turns = sent.filter((r) => r.path.endsWith("/messages"))
  expect(turns.length).toBe(2)
  expect(turns[1].origin).toBe("https://api.z.ai")
  expect(turns[1].body).toBe(body)
  expect(turns[1].headers["x-api-key"]).toBe(KEY)
  // the rest the refusal named keeps the next turn on Coding without Start
  sent.length = 0
  await call()
  expect(sent.filter((r) => r.path.endsWith("/messages")).length).toBe(1)
  expect(sent.find((r) => r.path.endsWith("/messages")).origin).toBe("https://api.z.ai")
})

test("a 200 whose JSON says quota is spent still falls back", async () => {
  startReply = () => new Response(JSON.stringify({ code: "1005", message: "exceed quota limit" }), { status: 200, headers: { "content-type": "application/json" } })
  const { res, json } = await call()
  expect(res.status).toBe(200)
  expect(json.content[0].text).toBe("CODING")
  expect(sent.filter((r) => r.path.endsWith("/messages")).length).toBe(2)
})

test("a non-Flash model is never routed to Start", async () => {
  const { res, json } = await call("GLM-5.3")
  expect(res.status).toBe(200)
  expect(json.content[0].text).toBe("CODING")
  const turns = sent.filter((r) => r.path.endsWith("/messages"))
  expect(turns.length).toBe(1)
  expect(turns[0].origin).toBe("https://api.z.ai")
})

test("a spent Start bucket leaves Flash on the Coding plan", async () => {
  balance.balances[0] = { ...balance.balances[0], used_units: 1000, remaining_units: 0 }
  const { res, json } = await call()
  expect(json.content[0].text).toBe("CODING")
  const turns = sent.filter((r) => r.path.endsWith("/messages"))
  expect(turns.length).toBe(1)
  expect(turns[0].origin).toBe("https://api.z.ai")
})

for (const missing of [true, false]) {
  test(`${missing ? "a missing" : "an expired"} Start stays on the Coding plan`, async () => {
    if (missing) balance = { plans: [], balances: [] }
    else balance.plans[0].ends_at = now - 1
    const { res, json } = await call()
    expect(res.status).toBe(200)
    expect(json.content[0].text).toBe("CODING")
    expect(sent).toHaveLength(1)
    expect(sent[0].origin).toBe("https://api.z.ai")
  })
}

test("a 400 from Start is the answer, not a second request", async () => {
  startReply = () => Response.json({ error: { message: "invalid model" } }, { status: 400 })
  const { res } = await call()
  expect(res.status).toBe(400)
  expect(sent.filter((r) => r.path.endsWith("/messages")).length).toBe(1)
})

const usage = async () => {
  const hooks = await fork.default({})
  return hooks.auth.usage(async () => auth, { id: "zcode" })
}

test("Start-first usage keeps numeric counts and scopes the two allowances", async () => {
  const card = await usage()
  const [coding, start] = card.windows
  expect([coding.used, coding.amount, coding.limit]).toEqual([10, 200, 2000])
  expect(coding.notModels).toContain("glm-5.3-flash")
  expect([start.used, start.amount, start.limit]).toEqual([25, 250, 1000])
  expect(start.models).toContain("GLM-5.3-Flash")
})

test("a cooling Start stays visible while Coding counts the plain Flash model", async () => {
  startReply = () => Response.json({ error: { message: "exceed quota limit" } }, { status: 429 })
  await call()
  const card = await usage()
  expect(card.windows[0].notModels).not.toContain("glm-5.3-flash")
  expect(card.windows[1].models).toEqual(["GLM-5.3-Flash-Trial"])
  expect([card.windows[1].amount, card.windows[1].limit]).toEqual([250, 1000])
  sent.length = 0
  expect((await call()).json.content[0].text).toBe("CODING")
  expect(sent).toHaveLength(1)
})

test("an exhausted Start stays visible and no longer excludes Coding Flash", async () => {
  balance.balances[0] = { ...balance.balances[0], used_units: 1000, remaining_units: 0 }
  const card = await usage()
  expect(card.windows[0].notModels).not.toContain("glm-5.3-flash")
  expect([card.windows[1].used, card.windows[1].amount, card.windows[1].limit]).toEqual([100, 1000, 1000])
})

test("Start-first usage includes the upstream claim hint outside the allowances", async () => {
  preview = { plans: [{ plan_id: "next-gift", name: "ZCode Trust Build" }] }
  const card = await usage()
  expect(card.windows.at(-1)).toEqual({
    name: "ZCode Trust Build", used: 0, aside: true, display: "1 to claim · claim it in the ZCode app",
  })
  expect(card.windows[1].models).toContain("GLM-5.3-Flash")
})

test("an unreachable Start replays Coding only once even when Coding is limited", async () => {
  startReply = () => { throw new TypeError("Start connection failed") }
  codingReply = () => Response.json({ error: { message: "exceed quota limit" } }, { status: 429 })
  const { res } = await call()
  expect(res.status).toBe(429)
  expect(sent).toHaveLength(2)
  expect(sent[1].origin).toBe("https://api.z.ai")
})

test("a Coding quota error is not replayed after Start already fell back", async () => {
  startReply = () => Response.json({ error: { message: "exceed quota limit" } }, { status: 429 })
  codingReply = () => Response.json({ code: "1005", message: "exceed quota limit" })
  const { json } = await call()
  expect(json.code).toBe("1005")
  expect(sent).toHaveLength(2)
})

test("a cancelled Start request never replays Coding", async () => {
  const controller = new AbortController()
  startReply = () => {
    controller.abort()
    throw new DOMException("The request was aborted", "AbortError")
  }
  await expect(call("GLM-5.3-Flash", { signal: controller.signal })).rejects.toThrow("The request was aborted")
  expect(sent).toHaveLength(1)
})
