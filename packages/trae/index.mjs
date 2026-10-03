// Trae CN (trae.cn), ByteDance's AI IDE, as the IDE signs in to it and
// asks its models: trae.cn's authorization page sends the browser back to
// a callback on 127.0.0.1 with the account's Cloud-IDE-JWT and refresh
// token; the refresh token is exchanged for a new JWT at
// /cloudide/api/v3/trae/oauth/ExchangeToken; model requests go to the IDE
// agent's /api/agent/v3/llm_utils_chat, which answers in its own SSE
// events. Worked out from two open-source relays (wangqi233/trae2api and
// autumnsentiment/Trae2api-cn); not run against a real account here.
import { randomBytes, randomUUID, randomInt } from "node:crypto"
import { createServer, STATUS_CODES } from "node:http"

const ID = "trae-cn"
// where each part of Trae CN is served; tests point them at a fake
const HOSTS = {
  web: "https://www.trae.cn", // the authorization page
  auth: "https://api.trae.cn", // tokens, the account, credits
  api: "https://trae-api-cn.mchost.guru", // the models
}
const CLIENT_ID = "ono9krqynydwx5" // Trae CN's IDE
const APP_ID = "6eefa01c-1036-4c7e-9ca5-d891f63bfcd8"
const IDE_VERSION = "3.3.65"
const IDE_VERSION_CODE = "20260401"
const PLUGIN_VERSION = "2.3.24254"
const BRAND = "ASUS TUF Gaming A15 FA507RM_FA507RM"
const SIGN_IN_TIMEOUT = 10 * 60 * 1000
const EARLY_MS = 2 * 60 * 1000 // a token this close to its end is renewed before a request
const LEAD_MS = 10 * 60 * 1000 // and this close, magpie renews it ahead of time (auth.refresh)
const DAY = 24 * 3600 * 1000
// the IDE's chat functions: the classic IDE's agent, then SOLO's Work
// mode, then the TRAE agent (solo_agent): Trae CN 3.3.104's agent-type map
// files its models under "trae", and only that one has deepseek-v4.1-flash
const FUNCTIONS = ["chat_v3", "solo_work_lite", "solo_agent"]

const MODEL = { attachment: false, tool_call: true, reasoning: true, temperature: true, limit: { context: 128_000, output: 32_000 }, modalities: { input: ["text"], output: ["text"] } }
// what Trae CN's chat_v3 is known to serve; the live list replaces it
const MODELS = {
  "glm-5.2": { name: "GLM-5.2", ...MODEL, limit: { context: 200_000, output: 32_000 } },
  "glm-5": { name: "GLM-5", ...MODEL },
  "kimi-k2.6": { name: "Kimi K2.6", ...MODEL, limit: { context: 256_000, output: 32_000 } },
  "qwen-3.7-plus": { name: "Qwen 3.7 Plus", ...MODEL },
  "DeepSeek-V4-Pro": { name: "DeepSeek V4 Pro", ...MODEL },
  "DeepSeek-V4-Flash": { name: "DeepSeek V4 Flash", ...MODEL },
}

const digits = (n) => Array.from({ length: n }, (_, i) => (i === 0 ? randomInt(1, 10) : randomInt(0, 10))).join("")
const statusLine = (status) => `${status} ${STATUS_CODES[status] ?? ""}`.trim()
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// device is the machine an account signs in from, made once at sign-in and
// named to trae.cn's authorization page, then sent with every request: a
// fresh one each time is what the relays saw requests dropped for.
const newDevice = () => ({ deviceId: digits(19), machineId: randomBytes(16).toString("hex") })

// whenOf reads one of Trae's expiry times: seconds, milliseconds or ISO
function whenOf(v) {
  if (v === undefined || v === null || v === "") return 0
  if (typeof v === "string" && !/^\d+$/.test(v.trim())) {
    const t = Date.parse(v)
    return isNaN(t) ? 0 : t
  }
  const n = Number(v)
  if (!Number.isFinite(n) || n <= 0) return 0
  return n < 1e11 ? n * 1000 : n
}

// jwtExp is a JWT's exp, in ms, 0 when it has none
function jwtExp(token) {
  try {
    const p = JSON.parse(Buffer.from(String(token).split(".")[1], "base64url").toString())
    return whenOf(p?.exp)
  } catch {
    return 0
  }
}

const parseJSON = (s) => {
  if (s && typeof s === "object") return s
  try {
    const v = JSON.parse(String(s ?? ""))
    return v && typeof v === "object" ? v : {}
  } catch {
    return {}
  }
}

// ---- the sign-in as kept ------------------------------------------------------

// The sign-in is kept as OpenCode keeps an OAuth one: access the
// Cloud-IDE-JWT, refresh the refresh token, expires the JWT's end; beside
// them the account, the client it was issued to and its device.
function toAuth(s) {
  return {
    type: "oauth",
    access: s.token,
    refresh: s.refresh,
    expires: s.expires || jwtExp(s.token) || Date.now() + DAY,
    accountId: s.name || s.uid,
    uid: s.uid,
    clientId: s.clientId || CLIENT_ID,
    deviceId: s.deviceId,
    machineId: s.machineId,
    // the model host the sign-in named, if it named one
    ...(/mchost\.guru|trae-api-/i.test(s.api ?? "") ? { api: s.api } : {}),
  }
}

function fromAuth(auth) {
  if (auth?.type !== "oauth" || !auth.access) return null
  return {
    token: auth.access,
    refresh: auth.refresh ?? "",
    expires: Number(auth.expires) || 0,
    uid: String(auth.uid ?? ""),
    name: String(auth.accountId ?? ""),
    clientId: auth.clientId || CLIENT_ID,
    deviceId: auth.deviceId || "",
    machineId: auth.machineId || "",
    api: auth.api || "",
  }
}

// apiOf is the model host for an account: the one its sign-in named when
// that is a model host (trae.cn's own hosts serve no models), else Trae
// CN's
function apiOf(a) {
  const h = String(a?.api ?? "").replace(/\/+$/, "")
  return /mchost\.guru|trae-api-/i.test(h) ? h : HOSTS.api
}

// ---- errors --------------------------------------------------------------------

class Expired extends Error {
  constructor(msg) {
    super(msg)
    this.signIn = "expired"
  }
}

// errorOf is what Trae said went wrong, from its several shapes: a business
// {code, message}, {error: {code, message}}, or ByteDance's
// {ResponseMetadata: {Error: {Code, Message}}}
function errorOf(v) {
  v = parseJSON(v)
  const meta = v?.ResponseMetadata?.Error
  if (meta && (meta.Code || meta.Message)) return { code: meta.Code ?? "", message: String(meta.Message ?? meta.Code ?? "") }
  const e = v?.error && typeof v.error === "object" ? v.error : v
  const code = e?.code ?? e?.Code ?? v?.code ?? ""
  const message = e?.message ?? e?.msg ?? e?.Message ?? (typeof v?.error === "string" ? v.error : "") ?? ""
  return { code, message: String(message || "") }
}

// lapsed: Trae turned the token away. 1001 is its "not signed in".
const lapsedCode = (code) => [1001, "1001", 401, "401"].includes(code)
const lapsedWords = /not ?log(ged)? ?in|unauthori[sz]ed|token (is )?(expired|invalid)|jwt|未登录|登录(已)?(过期|失效)/i
const quotaCode = (code) => [4008, "4008", 1005, "1005"].includes(code)
const quotaWords = /quota|credit|insufficient|exceed|limit|额度|积分|次数|上限|用完/i

// errorResponse is an OpenAI-style error, as the agent reads one
const errorResponse = (status, message, signIn) => {
  const headers = { "content-type": "application/json" }
  if (signIn) headers["X-Magpie-Sign-In"] = signIn
  return new Response(JSON.stringify({ error: { message, type: status === 429 ? "rate_limit_error" : "api_error", code: null } }), { status, headers })
}

// ---- tokens -----------------------------------------------------------------------

// exchange trades a refresh token for a new Cloud-IDE-JWT, as the IDE
// does: the answer's Result holds the new token pair and the account.
// Trae issues a new refresh token each time and spends the old one.
async function exchange(refresh, clientId, host = HOSTS.auth) {
  let res
  try {
    res = await fetch(host.replace(/\/+$/, "") + "/cloudide/api/v3/trae/oauth/ExchangeToken", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ClientID: clientId || CLIENT_ID, RefreshToken: refresh, ClientSecret: "-", UserID: "" }),
      signal: AbortSignal.timeout(20_000),
    })
  } catch (e) {
    throw new Error("Trae CN: renewing the sign-in: " + (e?.message ?? e))
  }
  const text = await res.text()
  const v = parseJSON(text)
  const r = v.Result ?? v.result ?? v
  const token = r?.Token ?? r?.token ?? ""
  if (res.ok && token) {
    const info = parseJSON(r.UserInfo ?? r.userInfo)
    return {
      token,
      refresh: r.RefreshToken ?? r.refreshToken ?? refresh,
      expires: whenOf(r.TokenExpireAt ?? r.tokenExpireAt) || jwtExp(token),
      clientId: r.ClientID ?? r.clientId ?? clientId,
      uid: String(info.UserID ?? info.userId ?? r.UserID ?? ""),
      name: String(info.ScreenName ?? info.screenName ?? ""),
      api: info.Host ?? "",
    }
  }
  const e = errorOf(text)
  const msg = e.message || (text.trim() ? text.trim().slice(0, 200) : statusLine(res.status))
  // a refresh token Trae no longer takes (spent, revoked, past its end, or
  // of another client) is a sign-in to make again
  if ([400, 401, 403].includes(res.status) || /refresh|expired|invalid|not matched|revoked|unauthori/i.test(msg) || String(e.code) === "10101") {
    throw new Expired(`Trae CN's sign-in has expired (${msg}); sign in again`)
  }
  throw new Error(`Trae CN: renewing the sign-in: ${statusLine(res.status)} ${msg}`.trim())
}

// ---- the browser sign-in --------------------------------------------------------

const page = (ok, title, text) => `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${title}</title>
<style>body{font:15px/1.5 -apple-system,system-ui,sans-serif;margin:0;display:grid;place-items:center;min-height:100vh;background:#f6f6f4;color:#222}
@media(prefers-color-scheme:dark){body{background:#1c1c1c;color:#eee}}main{max-width:420px;padding:24px}h1{font-size:20px;margin:0 0 8px}p{margin:0;opacity:.75}
.dot{display:inline-block;width:10px;height:10px;border-radius:50%;margin-right:8px;background:${ok ? "#2a9d58" : "#d1453b"}}</style>
<main><h1><span class="dot"></span>${title}</h1><p>${String(text).replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" })[c])}</p></main>`

// signedIn reads trae.cn's callback: userJwt (the token pair) and userInfo
// (the account), or, from its older page, a refresh token alone, which is
// exchanged for the pair
async function signedIn(q, device) {
  const jwt = parseJSON(q.get("userJwt"))
  const info = parseJSON(q.get("userInfo"))
  const host = q.get("host") || info.Host || ""
  let s = {
    token: jwt.Token ?? jwt.token ?? "",
    refresh: jwt.RefreshToken ?? jwt.refreshToken ?? q.get("refreshToken") ?? "",
    expires: whenOf(jwt.TokenExpireAt ?? jwt.tokenExpireAt),
    clientId: jwt.ClientID ?? jwt.clientId ?? q.get("clientId") ?? CLIENT_ID,
    uid: String(info.UserID ?? info.userId ?? q.get("userId") ?? ""),
    name: String(info.ScreenName ?? info.screenName ?? ""),
    api: host,
  }
  if (!s.token && s.refresh) {
    const x = await exchange(s.refresh, s.clientId)
    s = { ...s, ...x, uid: x.uid || s.uid, name: x.name || s.name, api: x.api || s.api }
  }
  if (!s.token) throw new Error("trae.cn sent back no token")
  if (!s.refresh) throw new Error("trae.cn sent back no refresh token")
  return { ...s, ...device }
}

// browserSignIn is the IDE's sign-in: trae.cn's authorization page, back
// to a callback on 127.0.0.1 (the page takes no other kind)
async function browserSignIn() {
  const device = newDevice()
  const trace = randomUUID()
  let over = false
  let settle
  const done = new Promise((r) => (settle = r))
  const finish = (result) => {
    if (over) return
    over = true
    settle(result)
  }
  const server = createServer(async (req, res) => {
    // trae.cn's page may call the callback from script as well as open it
    const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, OPTIONS", "Access-Control-Allow-Headers": "Content-Type" }
    if (req.method === "OPTIONS") return res.writeHead(204, cors).end()
    const url = new URL(req.url ?? "/", "http://127.0.0.1")
    const html = (body) => {
      res.writeHead(200, { ...cors, "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" })
      res.end(body)
    }
    if (url.pathname !== "/authorize") return res.writeHead(404, cors).end()
    const q = url.searchParams
    if (over) return html(page(false, "This sign-in is over", "Start it again in magpie."))
    if (q.get("error")) {
      const msg = q.get("error_description") || q.get("error")
      finish({ type: "failed", error: msg })
      return html(page(false, "Sign-in didn't finish", msg))
    }
    if (!q.get("userJwt") && !q.get("refreshToken")) return html(page(false, "Nothing to sign in with", "trae.cn sent no token; start the sign-in again."))
    try {
      const s = await signedIn(q, device)
      finish({ ...toAuth(s), type: "success" })
      html(page(true, "You're signed in", `${s.name || s.uid || "Your Trae CN account"} is signed in. You can close this tab.`))
    } catch (e) {
      finish({ type: "failed", error: e.message })
      html(page(false, "Sign-in didn't finish", e.message))
    }
  })
  await new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })
  const callback = `http://127.0.0.1:${server.address().port}/authorize`
  const timer = setTimeout(() => finish({ type: "failed", error: "the sign-in timed out" }), SIGN_IN_TIMEOUT)
  done.then(() => {
    clearTimeout(timer)
    setTimeout(() => server.close(), 5_000).unref?.()
  })
  const q = new URLSearchParams({
    login_version: "1",
    auth_from: "solo",
    login_channel: "native_ide",
    plugin_version: PLUGIN_VERSION,
    auth_type: "local",
    client_id: CLIENT_ID,
    redirect: "0",
    login_trace_id: trace,
    auth_callback_url: callback,
    machine_id: device.machineId,
    device_id: device.deviceId,
    x_device_id: device.deviceId,
    x_machine_id: device.machineId,
    x_device_brand: BRAND,
    x_device_type: "windows",
    x_os_version: "Windows 10 Pro",
    x_env: "",
    x_app_version: IDE_VERSION,
    x_app_type: "stable",
    hide_saas_login: "true",
  })
  return {
    url: `${HOSTS.web}/authorization?${q}`,
    instructions: "Sign in to Trae CN (trae.cn) in the browser and allow the sign-in. It finishes here by itself.",
    method: "auto",
    callback: () => done,
  }
}

// ---- requests ---------------------------------------------------------------------

// headers are the IDE's, for the account and its device
function ideHeaders(a, extra = {}) {
  return {
    "Content-Type": "application/json",
    Authorization: `Cloud-IDE-JWT ${a.token}`,
    "X-Cloudide-Token": a.token,
    "x-ide-token": a.token,
    "x-uid": a.uid,
    "x-app-id": APP_ID,
    "x-device-id": a.deviceId,
    "x-machine-id": a.machineId,
    "x-request-id": randomUUID(),
    "x-ide-version": IDE_VERSION,
    "x-ide-version-code": IDE_VERSION_CODE,
    "x-ide-version-type": "stable",
    "x-device-cpu": "AMD",
    "x-device-brand": BRAND,
    "x-device-type": "windows",
    "x-os-version": "Windows 10",
    "x-system-type": "Windows",
    ...extra,
  }
}

// Trae's chat takes text only and has no turn for a tool call or its
// result. The agent's tools are named to it natively and in a system
// prompt that asks for each call as a tagged block; earlier calls and
// their results go in as text. A native call in its answer is taken too.
const OPEN = "<tool_call>"
const CLOSE = "</tool_call>"

function toolPrompt(tools, choice, parallel) {
  const defs = tools.map((t) => {
    const f = t.function ?? t
    return { name: f.name, description: f.description ?? "", parameters: f.parameters ?? {} }
  })
  const lines = [
    "You can call the client's tools, listed below as JSON. They run on the user's machine, not on yours: use no built-in or server tool to reach the user's files.",
    `To call a tool, write one block per call and nothing after it: ${OPEN}{"name":"tool_name","arguments":{...}}${CLOSE}. Use an exact tool name and fill arguments from its schema. Then stop and wait: the result comes back in the next message.`,
    "A call is not done until its result comes back; don't say it is, and don't repeat a call whose result you have.",
  ]
  if (parallel === false) lines.push("Call at most one tool at a time.")
  if (choice === "required") lines.push("Call a tool before answering.")
  else if (choice && typeof choice === "object" && (choice.function?.name || choice.name)) lines.push(`Call the tool ${choice.function?.name || choice.name} before answering.`)
  lines.push("Tools:", JSON.stringify(defs))
  return lines.join("\n")
}

const partText = (content) => {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return content == null ? "" : String(content)
  return content
    .map((p) => (typeof p === "string" ? p : p?.type === "text" || p?.type === "input_text" ? p.text ?? "" : p?.type === "image_url" ? "[an image, which this model can't see]" : ""))
    .filter(Boolean)
    .join("\n")
}

// traeMessages is the conversation as Trae's chat takes it
function traeMessages(req) {
  const tools = Array.isArray(req.tools) && req.tools.length && req.tool_choice !== "none" ? req.tools : []
  const names = new Map()
  const out = []
  if (tools.length) out.push({ role: "system", text: toolPrompt(tools, req.tool_choice, req.parallel_tool_calls) })
  for (const m of req.messages ?? []) {
    const role = m.role === "developer" ? "system" : m.role
    let text = partText(m.content)
    if (role === "assistant") {
      const calls = (m.tool_calls ?? []).map((c) => {
        names.set(c.id, c.function?.name)
        let args = c.function?.arguments ?? "{}"
        try {
          args = JSON.parse(args)
        } catch {}
        return OPEN + JSON.stringify({ name: c.function?.name, arguments: args }) + CLOSE
      })
      text = [text, ...calls].filter(Boolean).join("\n")
      out.push({ role: "assistant", text })
    } else if (role === "tool") {
      out.push({ role: "user", text: `Result of ${names.get(m.tool_call_id) || m.name || "the tool"} (call ${m.tool_call_id ?? "?"}):\n${text}` })
    } else {
      out.push({ role: role === "system" ? "system" : "user", text })
    }
  }
  // Trae takes no empty message, nor two of one role in a row
  const merged = []
  for (const m of out) {
    if (!m.text) continue
    const last = merged.at(-1)
    if (last && last.role === m.role && m.role !== "system") last.text += "\n\n" + m.text
    else merged.push({ ...m })
  }
  return merged.map((m) => ({ role: m.role, content: [{ type: "text", text: m.text }] }))
}

// nativeTools are the tools as Trae names them: parameters a JSON string
const nativeTools = (tools) =>
  tools.map((t) => {
    const f = t.function ?? t
    return { type: "function", function: { name: f.name, description: f.description ?? "", parameters: typeof f.parameters === "string" ? f.parameters : JSON.stringify(f.parameters ?? {}) } }
  })

function chatBody(req, fn) {
  const session = randomUUID()
  const body = {
    messages: traeMessages(req),
    function: fn,
    config_name: req.model,
    model: req.model,
    stream: true, // Trae answers in SSE either way
    request_id: session,
    session_id: session,
  }
  const max = req.max_completion_tokens ?? req.max_tokens
  if (Number.isFinite(max) && max > 0) body.max_tokens = Math.floor(max)
  if (typeof req.temperature === "number") body.temperature = req.temperature
  if (Array.isArray(req.tools) && req.tools.length && req.tool_choice !== "none") {
    body.tools = nativeTools(req.tools)
    const c = req.tool_choice
    if (c && typeof c === "object") body.tool_choice = c.function?.name || c.name || "auto"
    else if (typeof c === "string") body.tool_choice = c
    if (typeof req.parallel_tool_calls === "boolean") body.parallel_tool_calls = req.parallel_tool_calls
  }
  return body
}

// sse reads Trae's events: {event, data} for each, data parsed when JSON
async function* sse(stream) {
  const reader = stream.getReader()
  const dec = new TextDecoder()
  let buf = ""
  let event = ""
  let data = []
  const flush = function* () {
    if (!data.length) return
    const raw = data.join("\n")
    data = []
    let v = raw
    try {
      v = JSON.parse(raw)
    } catch {}
    yield { event: event || (v && typeof v === "object" ? String(v.event ?? v.type ?? "") : ""), data: v }
    event = ""
  }
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    buf += dec.decode(value, { stream: true })
    let i
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).replace(/\r$/, "")
      buf = buf.slice(i + 1)
      if (!line) {
        yield* flush()
        continue
      }
      if (line.startsWith(":")) continue
      if (line.startsWith("event:")) {
        yield* flush()
        event = line.slice(6).trim()
      } else if (line.startsWith("data:")) data.push(line.slice(5).trimStart())
    }
  }
  buf += dec.decode()
  if (buf.startsWith("data:")) data.push(buf.slice(5).trimStart())
  yield* flush()
}

// normalised event names: "TokenUsage", "token-usage" → token_usage
const eventName = (s) =>
  String(s ?? "")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .toLowerCase()
    .replace(/^_|_$/g, "")

// usageOf maps Trae's token counts to OpenAI's
function tokensOf(u) {
  if (!u || typeof u !== "object") return null
  const p = Number(u.prompt_tokens ?? u.input_tokens ?? u.promptTokens ?? u.inputTokens ?? 0) || 0
  const c = Number(u.completion_tokens ?? u.output_tokens ?? u.completionTokens ?? u.outputTokens ?? 0) || 0
  if (!p && !c) return null
  return { prompt_tokens: p, completion_tokens: c, total_tokens: Number(u.total_tokens ?? u.totalTokens) || p + c }
}

let callSeq = 0
const callId = () => "call_" + randomBytes(12).toString("hex") + (callSeq++).toString(36)

// TextTools splits the model's text into what the agent sees and the tool
// calls it wrote as blocks, holding back the start of a block until it
// is whole
class TextTools {
  constructor() {
    this.buf = ""
  }
  push(s, end = false) {
    this.buf += s
    let text = ""
    const calls = []
    for (;;) {
      const i = this.buf.indexOf(OPEN)
      if (i < 0) break
      const j = this.buf.indexOf(CLOSE, i + OPEN.length)
      if (j < 0) break
      text += this.buf.slice(0, i)
      const raw = this.buf.slice(i + OPEN.length, j).trim()
      this.buf = this.buf.slice(j + CLOSE.length)
      const v = parseJSON(raw)
      if (v.name) calls.push({ name: String(v.name), arguments: typeof v.arguments === "string" ? v.arguments : JSON.stringify(v.arguments ?? v.input ?? v.parameters ?? {}) })
      else text += OPEN + raw + CLOSE
    }
    if (end) {
      text += this.buf
      this.buf = ""
    } else {
      // keep back an opened block, or what may be the start of one
      const i = this.buf.indexOf(OPEN)
      let keep = i >= 0 ? this.buf.length - i : 0
      if (!keep) for (let k = Math.min(OPEN.length - 1, this.buf.length); k > 0; k--) if (OPEN.startsWith(this.buf.slice(-k))) { keep = k; break }
      text += this.buf.slice(0, this.buf.length - keep)
      this.buf = this.buf.slice(this.buf.length - keep)
    }
    return { text, calls }
  }
}

// nativeCall is a tool call as Trae's events carry one
function nativeCall(tc) {
  const f = tc?.function ?? tc?.function_call ?? tc
  const name = f?.name ?? tc?.tool_name ?? ""
  if (!name) return null
  const a = f?.arguments ?? tc?.params ?? tc?.input ?? tc?.parameters ?? {}
  return { id: tc?.id || tc?.tool_call_id || "", name: String(name), arguments: typeof a === "string" ? a : JSON.stringify(a) }
}

// parts turns Trae's events into what the answer is made of: text,
// reasoning, tool calls, the token counts, the finish, or an error.
async function* parts(events) {
  const tt = new TextTools()
  const seen = new Set()
  for await (const { event, data } of events) {
    const name = eventName(event)
    const d = data && typeof data === "object" ? data : {}
    if (data === "[DONE]") break
    if (name === "error" || (name !== "output" && d.code && d.message && !d.response && !d.content)) {
      const e = errorOf(d)
      yield { error: e.message || "Trae CN returned an error", code: e.code }
      return
    }
    if (name === "token_usage") {
      const u = tokensOf(d.usage ?? d)
      if (u) yield { usage: u }
      continue
    }
    if (name === "done" || name === "response_done" || name === "stream_done") {
      const u = tokensOf(d.usage)
      if (u) yield { usage: u }
      break
    }
    if (name && name !== "output" && name !== "message") continue // queueing, metadata, timing
    const reasoning = d.reasoning_content ?? d.reasoning ?? ""
    if (typeof reasoning === "string" && reasoning) yield { reasoning }
    let text = typeof d.response === "string" ? d.response : typeof d.content === "string" ? d.content : ""
    // the IDE's own progress notes, not the model's
    if (/^(Building prompt:|Completed building prompt)/.test(text)) text = ""
    if (text) {
      const r = tt.push(text)
      if (r.text) yield { text: r.text }
      for (const c of r.calls) yield { call: { ...c, id: callId() } }
    }
    for (const tc of Array.isArray(d.tool_calls) ? d.tool_calls : []) {
      const c = nativeCall(tc)
      if (!c) continue
      const key = c.id || c.name + c.arguments
      if (seen.has(key)) continue
      seen.add(key)
      yield { call: { ...c, id: c.id || callId() } }
    }
    const u = tokensOf(d.usage)
    if (u) yield { usage: u }
  }
  const r = tt.push("", true)
  if (r.text) yield { text: r.text }
  for (const c of r.calls) yield { call: { ...c, id: callId() } }
}

// first reads events up to the first that is the answer's, so an answer
// that is only an error (signed out, out of credit, a model this account
// lacks) is known before anything is sent on
async function first(it) {
  const held = []
  for (;;) {
    const n = await it.next()
    if (n.done) return { held, done: true }
    held.push(n.value)
    if (!n.value.usage) return { held, done: false }
  }
}

async function* chain(held, it) {
  yield* held
  for (;;) {
    const n = await it.next()
    if (n.done) return
    yield n.value
  }
}

// failure is the response for an error Trae answered with
function failure(status, code, message) {
  message = message || statusLine(status)
  if (status === 401 || lapsedCode(code) || (status === 403 && lapsedWords.test(message))) {
    return errorResponse(401, `Trae CN's sign-in has expired (${message}); sign in again`, "expired")
  }
  if (status === 429 || quotaCode(code) || (status === 403 && quotaWords.test(message))) return errorResponse(429, `Trae CN: ${message}`)
  return errorResponse(status >= 400 ? status : 502, `Trae CN: ${message}${code ? ` (code ${code})` : ""}`)
}

// openai is the answer as an OpenAI chat completion: a stream, or one body
async function openai(req, it) {
  const id = "chatcmpl-" + randomBytes(12).toString("hex")
  const created = Math.floor(Date.now() / 1000)
  const model = req.model
  if (!req.stream) {
    let text = ""
    let reasoning = ""
    const calls = []
    let usage = null
    for await (const p of it) {
      if (p.error) return failure(502, p.code, p.error)
      if (p.text) text += p.text
      if (p.reasoning) reasoning += p.reasoning
      if (p.call) calls.push(p.call)
      if (p.usage) usage = p.usage
    }
    const message = { role: "assistant", content: text || (calls.length ? null : "") }
    if (reasoning) message.reasoning_content = reasoning
    if (calls.length) message.tool_calls = calls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: c.arguments } }))
    const body = { id, object: "chat.completion", created, model, choices: [{ index: 0, message, finish_reason: calls.length ? "tool_calls" : "stop" }] }
    if (usage) body.usage = usage
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } })
  }
  const enc = new TextEncoder()
  const chunk = (delta, finish = null, extra = {}) => enc.encode(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta, finish_reason: finish }], ...extra })}\n\n`)
  const stream = new ReadableStream({
    async start(ctl) {
      let calls = 0
      let usage = null
      ctl.enqueue(chunk({ role: "assistant", content: "" }))
      try {
        for await (const p of it) {
          if (p.error) {
            ctl.enqueue(enc.encode(`data: ${JSON.stringify({ error: { message: `Trae CN: ${p.error}`, type: "api_error", code: p.code ?? null } })}\n\n`))
            break
          }
          if (p.text) ctl.enqueue(chunk({ content: p.text }))
          if (p.reasoning) ctl.enqueue(chunk({ reasoning_content: p.reasoning }))
          if (p.call) ctl.enqueue(chunk({ tool_calls: [{ index: calls++, id: p.call.id, type: "function", function: { name: p.call.name, arguments: p.call.arguments } }] }))
          if (p.usage) usage = p.usage
        }
        ctl.enqueue(chunk({}, calls ? "tool_calls" : "stop"))
        if (usage) ctl.enqueue(enc.encode(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model, choices: [], usage })}\n\n`))
        ctl.enqueue(enc.encode("data: [DONE]\n\n"))
      } catch (e) {
        ctl.enqueue(enc.encode(`data: ${JSON.stringify({ error: { message: `Trae CN: ${e?.message ?? e}`, type: "api_error", code: null } })}\n\n`))
      }
      ctl.close()
    },
  })
  return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } })
}

// a model or function this account's chat_v3 doesn't take: another may
const wrongFunction = (code) => ["4001", "4023", "1005"].includes(String(code))

// ---- usage ------------------------------------------------------------------------

// credits adds up the account's entitlement packs as the IDE shows them:
// each pack with a credit limit (-1 unlimited) and what it used
function credits(v) {
  let limit = 0
  let used = 0
  let unlimited = false
  let soonest = 0
  for (const p of v?.user_entitlement_pack_list ?? []) {
    const bi = p?.entitlement_base_info ?? {}
    const l = Number(bi?.quota?.credits_limit)
    if (!Number.isFinite(l)) continue
    const u = Number(p?.usage?.credits_amount) || 0
    if (l === -1) unlimited = true
    else if (l >= 0) limit += l
    if (u > 0) used += u
    const end = whenOf(bi.end_time ?? bi.expire_time ?? p.end_time)
    if (end && (!soonest || end < soonest)) soonest = end
  }
  return { limit, used, unlimited, until: soonest }
}

const round = (n) => Math.round(n * 100) / 100

// ---- the plugin ---------------------------------------------------------------------

export const TraeCNAuthPlugin = async ({ client }) => {
  // renewals under way, one to a refresh token (Trae spends it once), and
  // the last each account got here, so a sign-in from before it is given
  // that one rather than spending the token again
  const renewing = new Map()
  const renewed = new Map()
  // the chat function that served each account last
  const fnOf = new Map()
  // the first chat function whose model list has each model
  const listedBy = new Map()

  const save = async (auth) => {
    try {
      await client?.auth?.set?.({ path: { id: ID }, body: auth })
    } catch {}
  }

  const renew = (a, keep) => {
    const key = a.refresh
    let r = renewing.get(key)
    if (!r) {
      r = (async () => {
        const x = await exchange(a.refresh, a.clientId)
        const got = { ...a, token: x.token, refresh: x.refresh, expires: x.expires || jwtExp(x.token) || Date.now() + DAY, clientId: x.clientId || a.clientId, renewed: true }
        renewed.set(a.uid || a.name, { was: a.refresh, got })
        if (keep) await save(toAuth(got))
        return got
      })().finally(() => renewing.delete(key))
      renewing.set(key, r)
    }
    return r
  }

  // fresh is the account with a token that has a while to go, renewed
  // when it hasn't
  const fresh = async (getAuth) => {
    const a = fromAuth(await getAuth())
    if (!a) throw new Expired("Trae CN: not signed in")
    const last = renewed.get(a.uid || a.name)
    if (last && last.was === a.refresh) return { ...last.got, renewed: false }
    if (!a.expires || a.expires - Date.now() > EARLY_MS || !a.refresh) return a
    try {
      return await renew(a, true)
    } catch (e) {
      // a hiccup: the token in hand may still do
      if (!(e instanceof Expired) && a.expires > Date.now()) return a
      throw e
    }
  }

  // refresh is magpie's auth.refresh: the token renewed LEAD_MS before its
  // end, as the fields that changed
  const refresh = async (auth) => {
    const a = fromAuth(auth)
    if (!a || !a.refresh) return undefined
    const last = renewed.get(a.uid || a.name)
    if (last && last.was === a.refresh) return { access: last.got.token, refresh: last.got.refresh, expires: last.got.expires }
    const s = await renew(a, false)
    return { access: s.token, refresh: s.refresh, expires: s.expires }
  }

  // post asks one of Trae's JSON pages with the account
  const post = async (a, url, body) => {
    const res = await fetch(url, { method: "POST", headers: ideHeaders(a, { Accept: "application/json" }), body: JSON.stringify(body), signal: AbortSignal.timeout(20_000) })
    const text = await res.text()
    return { status: res.status, text, v: parseJSON(text) }
  }

  const usage = async (getAuth) => {
    let a
    try {
      a = await fresh(getAuth)
    } catch (e) {
      return { error: e.message, signIn: e instanceof Expired ? "expired" : "kept" }
    }
    const signIn = a.renewed ? "renewed" : "kept"
    let r
    try {
      r = await post(a, HOSTS.auth + "/trae/api/v2/pay/ide_user_ent_usage", { require_usage: true, req_source: 0 })
    } catch (e) {
      return { error: "Trae CN credits: " + (e?.message ?? e), signIn }
    }
    const e = errorOf(r.v)
    if (r.status === 401 || lapsedCode(e.code)) return { error: `${a.name || a.uid}: Trae CN's sign-in has expired — sign in again`, signIn: "expired" }
    if (r.status !== 200 || (e.code && String(e.code) !== "0")) return { error: `Trae CN credits: ${e.message || statusLine(r.status)}`, signIn, user: a.name }
    const c = credits(r.v)
    const out = { plan: r.v.is_credits_billing ? "Credits" : "Free", user: a.name || a.uid, signIn }
    if (c.unlimited) out.balance = "unlimited"
    else if (c.limit > 0) {
      out.balance = `${round(Math.max(0, c.limit - c.used))} of ${round(c.limit)} credits left`
      const w = { name: "Credits", used: Math.max(0, Math.min(100, (c.used / c.limit) * 100)) }
      if (c.until) w.resetsAt = new Date(c.until).toISOString()
      out.windows = [w]
    }
    return out
  }

  // listOf is one function's model list, as the IDE asks for it
  const listOf = async (a, fn) => {
    const r = await post(a, apiOf(a) + "/api/ide/v1/get_detail_param", {
      function: fn, config_names: null, need_prompt: false, current_config_info: null, poly_prompt: true, mode_type: null, agent_type: null,
    })
    if (r.status === 401 || lapsedCode(errorOf(r.v).code)) throw new Expired("Trae CN's sign-in has expired; sign in again")
    if (r.status !== 200) throw new Error(`Trae CN models: ${statusLine(r.status)}`)
    const list = r.v.config_info_list ?? r.v.data?.config_info_list ?? []
    return list.filter((m) => m?.config_name)
  }

  // liveModels is the account's model list: every chat function's, since
  // SOLO lists models the classic IDE's chat_v3 doesn't (deepseek-v4.1-flash
  // came to the TRAE agent's first, yetone/magpie#681); a model listed by one function
  // only is asked through that one. One function's list failing leaves the
  // others'; all failing is the error.
  const liveModels = async (a) => {
    const got = await Promise.allSettled(FUNCTIONS.map((fn) => listOf(a, fn)))
    const expired = got.find((g) => g.status === "rejected" && g.reason instanceof Expired)
    if (expired) throw expired.reason
    if (got.every((g) => g.status === "rejected")) throw got[0].reason
    const out = new Map()
    got.forEach((g, i) => {
      if (g.status !== "fulfilled") return
      for (const m of g.value) {
        const id = String(m.config_name)
        if (!out.has(id)) out.set(id, { m, fn: FUNCTIONS[i] })
      }
    })
    for (const [id, { fn }] of out) listedBy.set(id, fn)
    return [...out.values()].map((x) => x.m)
  }

  const modelOf = (provider, m) => {
    const id = String(m.config_name)
    const was = provider.models?.[id] ?? {}
    const ctx = Number(m.context_window_size?.max?.[0] ?? m.context_window_size?.max ?? m.context_window_tokens?.max ?? m.prompt_max_tokens) || was.limit?.context || MODEL.limit.context
    return { ...MODEL, ...was, id, providerID: ID, name: String(m.display_name || m.display_model_name || was.name || id), limit: { context: ctx, output: was.limit?.output ?? MODEL.limit.output }, api: was.api ?? { id, url: HOSTS.api, npm: "@ai-sdk/openai-compatible" } }
  }

  return {
    config: async (config) => {
      config.provider ??= {}
      const was = config.provider[ID] ?? {}
      config.provider[ID] = {
        name: "Trae CN",
        npm: "@ai-sdk/openai-compatible",
        api: HOSTS.api + "/v1",
        ...was,
        models: { ...MODELS, ...(was.models ?? {}) },
      }
    },
    provider: {
      id: ID,
      // the account's own list, when Trae answers; else the list above
      async models(provider, { auth }) {
        if (auth?.type !== "oauth" || !auth.access) return provider.models
        try {
          const ms = await liveModels(await fresh(async () => auth))
          if (!ms.length) return provider.models
          return Object.fromEntries(ms.map((m) => [String(m.config_name), modelOf(provider, m)]))
        } catch (e) {
          if (e instanceof Expired) throw e
          return provider.models
        }
      },
    },
    auth: {
      provider: ID,
      usage,
      // magpie renews the token LEAD_MS before its end, once, before its
      // requests, models and usage ask; the check before each request
      // stays for OpenCode, which doesn't call this
      refreshLead: LEAD_MS,
      refresh,
      loader: async (getAuth) => {
        const a0 = fromAuth(await getAuth())
        if (!a0) return {}
        return {
          baseURL: apiOf(a0) + "/v1",
          apiKey: "trae", // the engine's placeholder; the request carries the JWT
          async fetch(input, init = {}) {
            const r0 = input instanceof Request ? input : null
            let body = init.body ?? (r0 ? await r0.text() : undefined)
            if (body instanceof ArrayBuffer) body = new TextDecoder().decode(body)
            else if (ArrayBuffer.isView(body)) body = new TextDecoder().decode(new Uint8Array(body.buffer, body.byteOffset, body.byteLength))
            const req = parseJSON(body)
            if (!Array.isArray(req.messages)) return errorResponse(400, "Trae CN: only chat completions are served")
            let a
            try {
              a = await fresh(getAuth)
            } catch (e) {
              if (e instanceof Expired) return errorResponse(401, `${a0.name || a0.uid}: ${e.message}`, "expired")
              throw e
            }
            const signIn = a.renewed ? "renewed" : "kept"
            const who = a.uid || a.name
            // the function that lists the model first, then the one that
            // served this account last, then the rest
            const fns = [...new Set([listedBy.get(String(req.model)), fnOf.get(who), ...FUNCTIONS].filter(Boolean))]
            let last
            for (const fn of fns) {
              const res = await fetch(apiOf(a) + "/api/agent/v3/llm_utils_chat", {
                method: "POST",
                headers: ideHeaders(a, { Accept: "text/event-stream", "X-Request-ID": randomUUID() }),
                body: JSON.stringify(chatBody(req, fn)),
                signal: init.signal ?? r0?.signal,
              })
              if (!res.ok) {
                const text = await res.text()
                const e = errorOf(text)
                last = failure(res.status, e.code, e.message || text.trim().slice(0, 300))
                if (res.status === 400 && wrongFunction(e.code)) continue
                break
              }
              const ct = res.headers.get("content-type") ?? ""
              if (!ct.includes("event-stream") && ct.includes("json")) {
                // an answer that isn't a stream is an error in a 200
                const e = errorOf(await res.text())
                last = failure(502, e.code, e.message)
                if (wrongFunction(e.code)) continue
                break
              }
              const it = parts(sse(res.body))[Symbol.asyncIterator]()
              const { held, done } = await first(it)
              const err = held.find((p) => p.error)
              if (err) {
                last = failure(502, err.code, err.error)
                if (wrongFunction(err.code)) continue
                break
              }
              fnOf.set(who, fn)
              const out = await openai(req, done ? held : chain(held, it))
              out.headers.set("X-Magpie-Sign-In", signIn)
              return out
            }
            if (!last.headers.has("X-Magpie-Sign-In")) last.headers.set("X-Magpie-Sign-In", signIn)
            return last
          },
        }
      },
      methods: [{ type: "oauth", label: "Trae CN account (browser)", authorize: browserSignIn }],
    },
  }
}

// for tests
export const _internal = { HOSTS, MODELS, TextTools, traeMessages, chatBody, credits, whenOf, newDevice }
