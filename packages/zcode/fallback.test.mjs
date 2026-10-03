// The fork entry point, end to end against a local server: GLM-5.3-Flash
// goes to the Start Plan first, and a refused Start request is retried once
// on the GLM Coding Plan with the agent's own body and headers. Nothing
// reaches zcode.z.ai or bigmodel.cn.
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test"
import { homedir, tmpdir } from "node:os"
import { realpathSync } from "node:fs"

let fork, internal, server
const got = []

const jwt = ["{}", JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })].map((s) => Buffer.from(s).toString("base64url")).join(".") + ".sig"
const DEVICE = "11111111-2222-4333-8444-555555555555"
const auth = (() => {
  const s = { site: "bigmodel", device: DEVICE, key: "coding-key", jwt, base: "https://open.bigmodel.cn/api/anthropic", plan: "GLM Coding Max" }
  return { type: "oauth", access: "coding-key", refresh: JSON.stringify(s), expires: 0 }
})()

// the agent's request, exactly as OpenCode's @ai-sdk/anthropic sends it
const body = JSON.stringify({
  model: "GLM-5.3-Flash",
  max_tokens: 1024,
  system: [{ type: "text", text: "You are opencode, an agent." }],
  messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
  stream: false,
})

const envelope = (data) => Response.json({ code: 0, msg: "", data })
const now = () => Math.trunc(Date.now() / 1000)

beforeAll(async () => {
  if (![tmpdir(), realpathSync(tmpdir())].some((t) => homedir().startsWith(t))) throw new Error("run with HOME=$(mktemp -d) bun test")
  fork = await import("../../index.mjs")
  ;({ _internal: internal } = await import("./index.mjs"))
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const path = new URL(req.url).pathname
      const text = await req.text()
      got.push({ path, headers: Object.fromEntries(req.headers), body: text })
      if (path.endsWith("/billing/balance")) {
        return envelope({
          server_time: now(),
          plans: [{ plan_id: "start-plan-monthly", user_plan_id: "u1", name: "ZCode Trust Build", status: "active", ends_at: now() + 3600, entitlements: [{ entitlement_id: "e1", period: "monthly" }] }],
          balances: [{ plan_id: "start-plan-monthly", user_plan_id: "u1", entitlement_id: "e1", show_name: "GLM-5.3-Flash", total_units: 100000000, remaining_units: 99000000, used_units: 1000000, expires_at: now() + 3600, capabilities: ["model:glm-5.3-flash"] }],
        })
      }
      if (path.endsWith("/subscription/list")) return envelope([{ status: "VALID", productName: "GLM Coding Max", autoRenew: true, nextRenewTime: "2027-07-09 16:00:00" }])
      // the Start Plan refusing the turn, as it does at its limit
      if (path.includes("/zcode-plan/")) return new Response(JSON.stringify({ error: { message: "exceed quota limit" } }), { status: 429, headers: { "content-type": "application/json", "retry-after": "120" } })
      return Response.json({ type: "message", role: "assistant", content: [{ type: "text", text: "CODING" }] })
    },
  })
})
afterAll(() => server?.stop(true))

const real = globalThis.fetch
const HOSTS = ["https://zcode.z.ai", "https://api.z.ai", "https://open.bigmodel.cn"]
const routeToFake = () => {
  globalThis.fetch = (input, init) => {
    const url = input instanceof Request ? input.url : String(input)
    const host = HOSTS.find((h) => url.startsWith(h + "/"))
    if (!host) throw new Error("no network in tests: " + url)
    return real(`http://127.0.0.1:${server.port}/${new URL(host).host}${url.slice(host.length)}`, init)
  }
}

afterEach(() => {
  globalThis.fetch = real
  got.length = 0
  internal.startPriority.clear()
  internal.routes.clear()
})

// call sends one turn as the chat client does and hands back the response
async function call() {
  const hooks = await fork.default({})
  const loader = await hooks.auth.loader(async () => auth, { id: "zcode" })
  const res = await loader.fetch(loader.baseURL + "/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "anthropic-version": "2023-06-01", "x-api-key": "zcode" },
    body,
  })
  return { res, json: await res.clone().json().catch(() => null) }
}

test("a refused Start request retries once on Coding, as the agent sent it", async () => {
  routeToFake()
  const { res, json } = await call()
  expect(res.status).toBe(200)
  expect(json?.content?.[0]?.text).toBe("CODING")
  const turns = got.filter((r) => r.path.endsWith("/messages"))
  expect(turns.length).toBe(2)
  // the allowance read that decided the turn, before it was sent
  expect(got[0].path).toBe("/zcode.z.ai/api/v1/zcode-plan/billing/balance")

  const [start, coding] = turns
  expect(start.path).toBe("/zcode.z.ai/api/v1/zcode-plan/anthropic/v1/messages")
  expect(start.headers["x-zcode-app-version"]).toBeDefined()
  expect(start.headers["authorization"]).toBe("Bearer " + jwt)
  // dressed, as the plan is served only ZCode's own request
  expect(JSON.parse(start.body).system.length).toBeGreaterThan(1)

  expect(coding.path).toBe("/open.bigmodel.cn/api/anthropic/v1/messages")
  expect(coding.body).toBe(body)
  expect(coding.headers["x-api-key"]).toBe("coding-key")
  expect(coding.headers["authorization"]).toBe("Bearer coding-key")
  expect(coding.headers["x-zcode-app-version"]).toBeUndefined()
  expect(coding.headers["x-title"]).toBeUndefined()
  expect(coding.headers["x-device-mid"]).toBeUndefined()
})

test("the rest Start took from the refusal keeps the next turn on Coding", async () => {
  routeToFake()
  expect((await call()).res.status).toBe(200)
  expect(got.filter((r) => r.path.endsWith("/messages")).length).toBe(2)
  got.length = 0
  expect((await call()).res.status).toBe(200)
  expect(got.length).toBe(1)
  expect(got[0].path).toBe("/open.bigmodel.cn/api/anthropic/v1/messages")
  expect(internal.startPriority.get("coding-key\u0000" + jwt)?.restUntil).toBeGreaterThan(Date.now())
})
