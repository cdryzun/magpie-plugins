// Checks a ZCode plugin build against the live account: read-only, plus one
// tiny GLM-5.3-Flash request. Prints the usage windows (name, used, aside)
// and which plan answered the request. No secret is printed.
import { readFileSync } from "node:fs"

const [pluginPath, authPath] = process.argv.slice(2)
if (!pluginPath || !authPath) throw new Error("usage: verify-aside.mjs <plugin index.mjs> <plugin-auth.json>")

const auth = JSON.parse(readFileSync(authPath, "utf8")).zcode
if (!auth) throw new Error("no zcode entry in " + authPath)

const seen = []
const real = globalThis.fetch
globalThis.fetch = (input, init) => {
  const u = input instanceof Request ? input.url : String(input)
  try {
    const p = new URL(u)
    seen.push(p.origin + p.pathname)
  } catch {}
  return real(input, init)
}

const { ZCodeAuthPlugin } = await import(pluginPath)
const hooks = await ZCodeAuthPlugin({ client: { app: { log: () => {} }, auth: { set: async () => {} } } })

const usage = await hooks.auth.usage(async () => auth, { id: "zcode" })
console.log(JSON.stringify({
  plan: usage.plan ?? null,
  error: usage.error ?? null,
  windows: (usage.windows ?? []).map((w) => ({ name: w.name, used: w.used, aside: !!w.aside, models: w.models ?? [] })),
}, null, 1))

const opts = await hooks.auth.loader(async () => auth, { id: "zcode" })
seen.length = 0
const res = await opts.fetch("https://api.z.ai/api/anthropic/v1/messages", {
  method: "POST",
  headers: { "content-type": "application/json", "x-api-key": "zcode", "anthropic-version": "2023-06-01" },
  body: JSON.stringify({ model: "GLM-5.3-Flash", max_tokens: 8, messages: [{ role: "user", content: "Reply with the single word pong." }] }),
})
const text = await res.text()
console.log(JSON.stringify({ status: res.status, calls: seen, body: text.slice(0, 240) }, null, 1))
