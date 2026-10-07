// The account's fetch sends Qoder's campaigns pages (the daily check-in) as
// the account, on the device token, for both sites; anything else on those
// hosts is still refused as not a chat.
import { afterEach, expect, test } from "bun:test"
import { QoderAuthPlugin, QoderCNAuthPlugin, _internal } from "./index.mjs"

const real = globalThis.fetch
afterEach(() => (globalThis.fetch = real))

const account = () => ({
  type: "oauth",
  access: "jt-one",
  refresh: "rt-one",
  expires: Date.now() + 3_600_000,
  accountId: "one@x",
  uid: "u1",
  deviceToken: "dt-old",
  deviceRefresh: "drt-old",
})

const json = (v, status = 200) => new Response(JSON.stringify(v), { status })

async function loader(make, serve) {
  let auth = account()
  const seen = []
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(String(url))
    seen.push({ origin: u.origin, path: u.pathname, method: init.method ?? "GET", auth: init.headers?.Authorization, body: init.body })
    return serve(u, init)
  }
  const client = { auth: { set: async ({ body }) => (auth = body) } }
  const hooks = await make({ client })
  const l = await hooks.auth.loader(async () => auth)
  return { fetch: l.fetch, seen, auth: () => auth }
}

const LIST = { campaigns: [{ campaignId: "c1", actionType: "CLAIM_BENEFIT", claimStatus: "CLAIMABLE", benefit: { amount: 100 } }] }

for (const [make, origin] of [
  [QoderAuthPlugin, "https://openapi.qoder.sh"],
  [QoderCNAuthPlugin, "https://openapi.qoder.com.cn"],
]) {
  test(`${origin}: the campaigns list and a claim go out on the device token`, async () => {
    const p = await loader(make, (u, init) => {
      if (u.pathname === "/sash/api/v1/me/campaigns") return json(LIST)
      if (u.pathname === "/sash/api/v1/me/campaigns/c1/claim") return json({ data: { status: "CLAIMED", benefit: { amount: 100 } } })
      return new Response("", { status: 404 })
    })
    const list = await p.fetch(origin + "/sash/api/v1/me/campaigns", { method: "GET" })
    expect(list.status).toBe(200)
    expect(await list.json()).toEqual(LIST)
    const claim = await p.fetch(origin + "/sash/api/v1/me/campaigns/c1/claim", { method: "POST", body: "{}" })
    expect(claim.status).toBe(200)
    expect((await claim.json()).data.status).toBe("CLAIMED")
    expect(p.seen).toEqual([
      { origin, path: "/sash/api/v1/me/campaigns", method: "GET", auth: "Bearer dt-old", body: undefined },
      { origin, path: "/sash/api/v1/me/campaigns/c1/claim", method: "POST", auth: "Bearer dt-old", body: "{}" },
    ])
  })
}

test("a refused device token is rotated, saved, and the claim asked again", async () => {
  const p = await loader(QoderAuthPlugin, (u, init) => {
    if (u.pathname === "/api/v1/deviceToken/refresh") return json({ device_token: "dt-new", refresh_token: "drt-new" })
    if (u.pathname === "/sash/api/v1/me/campaigns/c1/claim")
      return init.headers.Authorization === "Bearer dt-new" ? json({ status: "CLAIMED" }) : new Response("", { status: 401 })
    return new Response("", { status: 404 })
  })
  const res = await p.fetch("https://openapi.qoder.sh/sash/api/v1/me/campaigns/c1/claim", { method: "POST", body: "{}" })
  expect(res.status).toBe(200)
  expect(p.auth().deviceToken).toBe("dt-new")
  expect(p.auth().deviceRefresh).toBe("drt-new")
})

test("only the campaigns pages of the account's own site pass", () => {
  const { campaignPage, SITES } = _internal
  expect(campaignPage(SITES.qoder, "https://openapi.qoder.sh/sash/api/v1/me/campaigns")).toBe(true)
  expect(campaignPage(SITES.qoder, "https://openapi.qoder.sh/sash/api/v1/me/campaigns/x-1/claim")).toBe(true)
  expect(campaignPage(SITES.qoder, "https://openapi.qoder.com.cn/sash/api/v1/me/campaigns")).toBe(false)
  expect(campaignPage(SITES.qoder, "https://openapi.qoder.sh/sash/api/v2/me/usage")).toBe(false)
  expect(campaignPage(SITES.qoder, "https://openapi.qoder.sh/sash/api/v1/me/campaigns/a/b/claim")).toBe(false)
  expect(campaignPage(SITES.qoder, "https://evil.example/sash/api/v1/me/campaigns")).toBe(false)
  expect(campaignPage(SITES["qoder-cn"], "https://openapi.qoder.com.cn/sash/api/v1/me/campaigns/c/claim")).toBe(true)
})

test("another page on the openapi host is still refused", async () => {
  const p = await loader(QoderAuthPlugin, () => json({}))
  const res = await p.fetch("https://openapi.qoder.sh/api/v1/userinfo", { method: "GET" })
  expect(res.status).toBe(404)
  expect(p.seen).toEqual([])
})
