// yetone/magpie#952: pi 1.0.4 through magpie got 403 "Factory: Forbidden"
// on DeepSeek (chat completions) and Claude (Messages) for "hi". The
// reporter's replays found the refused part: pi's opening sentence, whole
// (either half passes). The shapes below are pi's two requests as the
// reporter captured them: a developer message on chat completions, one
// system text block with cache_control on Messages.
import { afterEach, expect, test } from "bun:test"
import { FactoryAuthPlugin, _internal } from "./index.mjs"

const { DROID_LINE } = _internal
const real = globalThis.fetch
afterEach(() => (globalThis.fetch = real))

const API = "https://api.factory.ai"
const chat = API + "/api/llm/o/v1/chat/completions"
const responses = API + "/api/llm/o/v1/responses"
const messages = API + "/api/llm/a/v1/messages?beta=true"

const OPENING = "You are an expert coding assistant operating inside pi, a coding agent harness."
const REST = " You help users by reading files, executing commands, editing code, and writing new files.\n\nAvailable tools:\n- read: Read file contents"
const PI = OPENING + REST
const ADAPTED = "You are an expert coding assistant." + REST

async function loaded() {
  const sent = []
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(String(url))
    if (u.pathname === "/api/cli/whoami") return new Response(JSON.stringify({ userId: "u", orgId: "fac_D", email: "d@example.com", region: "" }))
    sent.push({ url: String(url), body: init.body })
    return new Response('{"id":"ok"}')
  }
  let saved = { type: "oauth", access: "tok", refresh: "r", expires: Date.now() + 3_600_000, accountId: "d@example.com", activeOrganizationId: "fac_D", region: "", premBaseHost: "" }
  const hooks = await FactoryAuthPlugin({ client: { auth: { set: async ({ body }) => (saved = body) } } })
  const l = await hooks.auth.loader(async () => saved)
  return async (url, body) => {
    const s = JSON.stringify(body)
    const res = await l.fetch(url, { method: "POST", headers: { "content-type": "application/json", "user-agent": "pi (darwin 24.6.0; arm64)" }, body: s })
    expect(res.status).toBe(200)
    return JSON.parse(sent.at(-1).body)
  }
}

const tools = ["read", "bash", "edit", "write"].map((name) => ({ type: "function", function: { name, description: name, parameters: { type: "object", properties: {} } } }))

test("pi's opening sentence is cut to its first half on chat completions, the rest of its prompt kept", async () => {
  const send = await loaded()
  const b = await send(chat, { model: "deepseek-v4.1-flash", messages: [{ role: "developer", content: PI }, { role: "user", content: "hi" }], tools, stream: true })
  expect(b.messages).toEqual([{ role: "system", content: DROID_LINE }, { role: "developer", content: ADAPTED }, { role: "user", content: "hi" }])
  expect(b.tools).toEqual(tools)
  // as a system message too, and in text parts
  let c = await send(chat, { model: "kimi-k3", messages: [{ role: "system", content: PI }, { role: "user", content: "hi" }] })
  expect(c.messages[0]).toEqual({ role: "system", content: DROID_LINE + "\n" + ADAPTED })
  c = await send(chat, { model: "kimi-k3", messages: [{ role: "developer", content: [{ type: "text", text: PI }] }, { role: "user", content: "hi" }] })
  expect(c.messages[1]).toEqual({ role: "developer", content: [{ type: "text", text: ADAPTED }] })
})

test("pi's opening sentence is adapted in Messages' system block, its cache_control kept", async () => {
  const send = await loaded()
  const b = await send(messages, { model: "claude-opus-5-5", max_tokens: 100, system: [{ type: "text", text: PI, cache_control: { type: "ephemeral" } }], messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] })
  expect(b.system).toEqual([{ type: "text", text: DROID_LINE }, { type: "text", text: ADAPTED, cache_control: { type: "ephemeral" } }])
  expect(b.messages).toEqual([{ role: "user", content: [{ type: "text", text: "hi" }] }])
})

test("pi's opening sentence is adapted in Responses' instructions and input", async () => {
  const send = await loaded()
  let b = await send(responses, { model: "gpt-6.1", instructions: PI, input: [{ role: "user", content: "hi" }] })
  expect(b.instructions).toBe(DROID_LINE + "\n" + ADAPTED)
  b = await send(responses, { model: "gpt-6.1", input: [{ role: "developer", content: PI }, { role: "user", content: "hi" }] })
  expect(b.instructions).toBe(DROID_LINE)
  expect(b.input[0]).toEqual({ role: "developer", content: ADAPTED })
  // droid's own instructions are untouched unless the sentence is in them
  b = await send(responses, { model: "gpt-6.1", instructions: DROID_LINE + "\n" + PI, input: [{ role: "user", content: "hi" }] })
  expect(b.instructions).toBe(DROID_LINE + "\n" + ADAPTED)
})

test("the sentence quoted by the user, or only part of it, goes on as it is", async () => {
  const send = await loaded()
  const user = "Why does pi say: " + OPENING
  let b = await send(chat, { model: "kimi-k3", messages: [{ role: "system", content: "Be brief." }, { role: "user", content: user }] })
  expect(b.messages[1]).toEqual({ role: "user", content: user })
  b = await send(messages, { model: "claude-opus-5-5", max_tokens: 100, system: [{ type: "text", text: "You are an expert coding assistant operating inside pi." }], messages: [{ role: "user", content: [{ type: "text", text: user }] }] })
  expect(b.system[1].text).toBe("You are an expert coding assistant operating inside pi.")
  expect(b.messages[0].content[0].text).toBe(user)
  // mid-line in a system prompt: not pi's opening
  b = await send(messages, { model: "claude-opus-5-5", max_tokens: 100, system: [{ type: "text", text: "Quote: " + OPENING }], messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] })
  expect(b.system[1].text).toBe("Quote: " + OPENING)
})
