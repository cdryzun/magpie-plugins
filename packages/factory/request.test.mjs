import { afterEach, expect, test } from "bun:test"
import { FactoryAuthPlugin } from "./index.mjs"

const real = globalThis.fetch
afterEach(() => (globalThis.fetch = real))
const url = "https://api.factory.ai/api/llm/a/v1/messages"
const droid = "You are Droid, an AI software engineering agent built by Factory."
// The built-in update-config description emitted by Claude Code 2.1.287.
const configSkill = '- update-config: Use this skill to configure the Claude Code harness via settings.json. Automated behaviors ("from now on when X", "each time X", "whenever X", "before/after X") require hooks configured in settings.json - the harness executes these, not Claude, so memory/preferences cannot fulfill them. Also use for: permissions, env vars and hook troubleshooting.'
const skillReminder = "<system-reminder>\nThe following skills are available for use with the Skill tool:\n\n" + configSkill + "\n- custom: Keep every user-defined skill description intact.\n</system-reminder>"

async function loaded() {
  const seen = []
  globalThis.fetch = async (url, init) => {
    seen.push({ url: String(url), ...init })
    return new Response('event: message_stop\ndata: {"type":"message_stop"}\n\n', { headers: { "content-type": "text/event-stream" } })
  }
  const auth = { type: "oauth", access: "factory-token", expires: Date.now() + 3_600_000, activeOrganizationId: "org_A" }
  const hooks = await FactoryAuthPlugin({ client: { auth: { set: async () => {} } } })
  return { l: await hooks.auth.loader(async () => auth), seen }
}

test("adapts Claude Code metadata, preserving instructions, tool turns, images and capabilities", async () => {
  const { l, seen } = await loaded()
  const request = {
    model: "claude-sonnet-4-6",
    system: [
      { type: "text", text: "x-anthropic-billing-header: cc_version=2.1.287.abc; cc_entrypoint=cli;" },
      { type: "text", text: "You are Claude Code, Anthropic's official CLI for Claude.", cache_control: { type: "ephemeral" } },
      { type: "text", text: "Follow the user's coding instructions. Keep this byte-for-byte.", cache_control: { type: "ephemeral" } },
    ],
    messages: [
      { role: "user", content: [
        { type: "text", text: "<system-reminder>\n# Environment\nYou have been invoked in the following environment:\n - Primary working directory: /tmp/project\n</system-reminder>" },
        { type: "text", text: "<system-reminder>\nYou are powered by the model named Sonnet 4.6. The exact model ID is claude-sonnet-4-6. Assistant knowledge cutoff is January 2025.\n</system-reminder>" },
        { type: "text", text: "Explain Claude Code's environment. Do not rewrite this user instruction." },
        { type: "image", source: { type: "base64", media_type: "image/png", data: "image-data" } },
      ] },
      { role: "assistant", content: [{ type: "tool_use", id: "tool_1", name: "Read", input: { file_path: "/tmp/project/proof.txt" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "tool_1", content: [{ type: "text", text: "You are powered by the model named — file content must stay unchanged." }], cache_control: { type: "ephemeral" } }] },
    ],
    tools: [{ name: "Read", input_schema: { type: "object", properties: { file_path: { type: "string" } } } }],
    metadata: { user_id: "caller" }, max_tokens: 256, thinking: { type: "adaptive" }, output_config: { effort: "high" }, stream: true,
    context_management: { edits: [] }, safeguards: [{ type: "dangerous_tool_use" }],
  }
  const res = await l.fetch(url, { method: "POST", headers: { "content-length": "1", "anthropic-version": "2023-06-01", "anthropic-beta": "client-beta", "x-api-key": "caller-key" }, body: JSON.stringify(request) })
  const sent = JSON.parse(seen[0].body)
  expect(sent.system[0]).toEqual({ ...request.system[1], text: droid })
  expect(sent.system[1]).toEqual(request.system[2])
  expect(sent.messages[0].content[0].text).toContain("Primary working directory: /tmp/project")
  expect(sent.messages[0].content[0].text).toContain("The session environment is:")
  expect(sent.messages[0].content[1].text).toContain("Current model name: Sonnet 4.6")
  expect(sent.messages[0].content[1].text).toContain("Model knowledge cutoff: January 2025.")
  expect(sent.messages[0].content.slice(2)).toEqual(request.messages[0].content.slice(2))
  expect(sent.messages.slice(1)).toEqual(request.messages.slice(1))
  for (const field of ["model", "tools", "metadata", "max_tokens", "thinking", "output_config", "stream", "context_management", "safeguards"]) expect(sent[field]).toEqual(request[field])
  expect(seen[0].headers.get("content-length")).toBeNull()
  expect(seen[0].headers.get("Authorization")).toBe("Bearer factory-token")
  expect(seen[0].headers.get("x-api-key")).toBe("placeholder")
  expect(seen[0].headers.get("anthropic-beta")).toBe("client-beta")
  expect(res.headers.get("content-type")).toBe("text/event-stream")
  expect(await res.text()).toBe('event: message_stop\ndata: {"type":"message_stop"}\n\n')
})

test("keeps native Droid requests byte-for-byte and adds its preamble to generic callers", async () => {
  const { l, seen } = await loaded()
  const body = '{ "model": "claude-sonnet-4-6", "system": [{"type":"text","text":' + JSON.stringify(droid) + '}], "messages": [{"role":"user","content":"OK"}] }'
  await l.fetch(url, { method: "POST", body })
  expect(seen[0].body).toBe(body)
  await l.fetch(url, { method: "POST", body: JSON.stringify({ model: "claude-sonnet-4-6", system: "Keep these exact instructions.", messages: [{ role: "user", content: "OK" }] }) })
  expect(JSON.parse(seen[1].body).system).toEqual([{ type: "text", text: droid }, { type: "text", text: "Keep these exact instructions." }])
})

test("handles SDK identity, request bodies and offset byte views without duplicating metadata", async () => {
  const { l, seen } = await loaded()
  const body = JSON.stringify({ model: "claude-sonnet-4-6", system: [{ type: "text", text: "You are a Claude agent, built on Anthropic's Claude Agent SDK." }], messages: [{ role: "user", content: "OK" }] })
  const bytes = Buffer.from("unused" + body + "unused")
  const view = new Uint8Array(bytes.buffer, bytes.byteOffset + 6, Buffer.byteLength(body))
  await l.fetch(url, { method: "POST", body: view })
  expect(JSON.parse(seen[0].body).system).toEqual([{ type: "text", text: droid }])
  await l.fetch(new Request(url, { method: "POST", body }))
  expect(seen[1].body).toBe(seen[0].body)
  await l.fetch(url, { method: "POST", body: seen[0].body })
  expect(seen[2].body).toBe(seen[0].body)
})

test("does not change OpenAI requests, malformed JSON or invalid system schemas", async () => {
  const { l, seen } = await loaded()
  const body = JSON.stringify({ model: "gpt-6-sol", instructions: droid, input: "OK" })
  await l.fetch("https://api.factory.ai/api/llm/o/v1/responses", { method: "POST", body })
  expect(seen[0].body).toBe(body)
  for (const body of ["not-json", JSON.stringify({ model: "claude-sonnet-4-6", system: {}, messages: [] }), JSON.stringify({ system: [{ type: "text", text: 123 }], messages: [] })]) {
    await l.fetch(url, { method: "POST", body })
    expect(seen.at(-1).body).toBe(body)
  }
})

test("recognizes Claude Code running within the Agent SDK", async () => {
  const { l, seen } = await loaded()
  await l.fetch(url, { method: "POST", body: JSON.stringify({
    system: [{ type: "text", text: "You are Claude Code, Anthropic's official CLI for Claude, running within the Claude Agent SDK.", cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: "OK" }],
  }) })
  expect(JSON.parse(seen[0].body).system).toEqual([{ type: "text", text: droid, cache_control: { type: "ephemeral" } }])
})

test("adapts the complete model reminder without a marketing name", async () => {
  const { l, seen } = await loaded()
  await l.fetch(url, { method: "POST", body: JSON.stringify({
    messages: [{ role: "user", content: [{ type: "text", text: "<system-reminder>\nYou are powered by the model custom-model.\n</system-reminder>" }] }],
  }) })
  expect(JSON.parse(seen[0].body).messages[0].content[0].text).toBe("<system-reminder>\nCurrent model: custom-model.\n</system-reminder>")
})

test("adapts complete environment reminders with nested additional working directories", async () => {
  const { l, seen } = await loaded()
  const reminder = "<system-reminder>\n# Environment\nYou have been invoked in the following environment:\n - Primary working directory: /tmp/project\n - Additional working directories:\n  - /extra/one\n  - /extra/two\n - Platform: darwin\n</system-reminder>"
  const pasted = reminder + "\nPlease explain these directories."
  const body = JSON.stringify({ messages: [{ role: "user", content: [
    { type: "text", text: reminder, cache_control: { type: "ephemeral" } },
    { type: "text", text: pasted },
  ] }] })
  for (const endpoint of [url, url + "/count_tokens"]) {
    await l.fetch(endpoint, { method: "POST", body })
    expect(JSON.parse(seen.at(-1).body).messages[0].content).toEqual([
      { type: "text", text: reminder.replace("# Environment", "# Runtime context").replace("You have been invoked in the following environment:", "The session environment is:"), cache_control: { type: "ephemeral" } },
      { type: "text", text: pasted },
    ])
  }
})

test("explains an Anthropic 403 without claiming these clients are always refused", async () => {
  const { l } = await loaded()
  globalThis.fetch = async () => new Response(JSON.stringify({ error: { message: "Model unavailable for this organization" } }), { status: 403 })
  const res = await l.fetch(url, { method: "POST", body: JSON.stringify({ model: "claude-sonnet-4-6", messages: [{ role: "user", content: "OK" }] }) })
  expect(res.status).toBe(403)
  const message = (await res.json()).error.message
  expect(message).toStartWith("Model unavailable for this organization — Factory refused")
  expect(message).toContain("OpenAI and Anthropic")
  expect(message).toContain("regional provider availability")
  expect(message).not.toContain("are sent as the agent sent them")
})

test("drops an empty or whitespace-only string system", async () => {
  const { l, seen } = await loaded()
  for (const system of ["", " \n\t", [{ type: "text", text: "" }]]) {
    await l.fetch(url, { method: "POST", body: JSON.stringify({ system, messages: [{ role: "user", content: "OK" }] }) })
    expect(JSON.parse(seen.at(-1).body).system).toEqual([{ type: "text", text: droid }])
  }
})

test("preserves a native Droid string system without duplicating the preamble", async () => {
  const { l, seen } = await loaded()
  for (const system of [droid, droid + "\nKeep the user's instructions."]) {
    const body = JSON.stringify({ system, messages: [{ role: "user", content: "OK" }] })
    await l.fetch(url, { method: "POST", body })
    expect(seen.at(-1).body).toBe(body)
  }
})

test("preserves pasted reminders with user text outside the complete block", async () => {
  const { l, seen } = await loaded()
  const reminders = [
    "<system-reminder>\n# Environment\nYou have been invoked in the following environment:\n - Platform: linux\n</system-reminder>",
    "<system-reminder>\nYou are powered by the model named Sonnet 4.6.\n</system-reminder>",
    "<system-reminder>\nYou are powered by the model custom-model.\n</system-reminder>",
  ]
  const texts = reminders.flatMap((r) => [r + "\nPlease explain this pasted reminder.", r.replace("</system-reminder>", ""), "Please explain:\n" + r])
  await l.fetch(url, { method: "POST", body: JSON.stringify({
    messages: [{ role: "user", content: texts.map((text) => ({ type: "text", text })) }],
  }) })
  expect(JSON.parse(seen[0].body).messages[0].content).toEqual(texts.map((text) => ({ type: "text", text })))
})

test("removes duplicate exact Droid identities while retaining the first block's metadata", async () => {
  const { l, seen } = await loaded()
  const identity = { type: "text", text: "You are Claude Code, Anthropic's official CLI for Claude.", cache_control: { type: "ephemeral" } }
  const native = { type: "text", text: droid }
  const instructions = { type: "text", text: "Keep all task instructions." }
  for (const system of [[identity, native, instructions], [native, identity, instructions], [native, native, instructions]]) {
    await l.fetch(url, { method: "POST", body: JSON.stringify({ system, messages: [{ role: "user", content: "OK" }] }) })
    expect(JSON.parse(seen.at(-1).body).system).toEqual([{ ...system[0], text: droid }, instructions])
  }
})

test("adapts token-counting requests consistently with Messages and leaves other paths alone", async () => {
  const { l, seen } = await loaded()
  const body = JSON.stringify({ system: "Count these instructions.", messages: [{ role: "user", content: "OK" }] })
  await l.fetch(url, { method: "POST", body })
  await l.fetch(url + "/count_tokens", { method: "POST", body })
  expect(seen[1].body).toBe(seen[0].body)
  expect(seen[1].headers.get("content-length")).toBeNull()
  await l.fetch("https://api.factory.ai/api/llm/a/v1/models", { method: "POST", body })
  expect(seen[2].body).toBe(body)
})

test("adapts MiniMax M2.7 on the Anthropic route while keeping its provider and options", async () => {
  const { l, seen } = await loaded()
  const options = { model: "minimax-m2.7", messages: [{ role: "user", content: "OK" }], max_tokens: 32, stream: true }
  await l.fetch(url, { method: "POST", body: JSON.stringify({ ...options, system: "You are OpenCode." }) })
  expect(JSON.parse(seen[0].body)).toEqual({ ...options, system: [{ type: "text", text: droid }, { type: "text", text: "You are OpenCode." }] })
  expect(seen[0].headers.get("x-api-provider")).toBe("fireworks")
})

test("retains large integer tokens byte-for-byte in an unmodified native Droid request", async () => {
  const { l, seen } = await loaded()
  const body = '{"system":[{"type":"text","text":' + JSON.stringify(droid) + '}],"messages":[{"role":"assistant","content":[{"type":"tool_use","id":"call_1","name":"Read","input":{"id":12345678901234567890}}]}]}'
  await l.fetch(url, { method: "POST", body })
  expect(seen[0].body).toBe(body)
})

test("adapts the built-in configuration skill self-reference on inference and counting", async () => {
  const { l, seen } = await loaded()
  const block = { type: "text", text: skillReminder, cache_control: { type: "ephemeral" } }
  const tools = [{ name: "Skill", description: "Load a skill.", input_schema: { type: "object", properties: { skill: { type: "string" } } } }]
  const body = JSON.stringify({ system: droid, tools, messages: [{ role: "user", content: [block, { type: "text", text: "Reply OK." }] }] })
  for (const endpoint of [url, url + "/count_tokens"]) {
    await l.fetch(endpoint, { method: "POST", body })
    const sent = JSON.parse(seen.at(-1).body)
    expect(sent.messages[0].content).toEqual([{ ...block, text: skillReminder.replace("not Claude", "not the assistant") }, { type: "text", text: "Reply OK." }])
    expect(sent.tools).toEqual(tools)
    expect(sent.system).toBe(droid)
  }
})

test("preserves pasted skill listings and configuration text outside the generated block", async () => {
  const { l, seen } = await loaded()
  const texts = [
    skillReminder + "\nExplain this pasted skill list.",
    "Explain this:\n" + skillReminder,
    skillReminder.replace("</system-reminder>", ""),
    configSkill,
    skillReminder.replace("- update-config:", "- custom-config:"),
  ]
  const content = texts.map((text) => ({ type: "text", text }))
  const body = JSON.stringify({ system: droid, messages: [{ role: "user", content }] })
  await l.fetch(url, { method: "POST", body })
  expect(seen[0].body).toBe(body)
})

test("preserves a skill listing inside tool results and is idempotent after adapting it", async () => {
  const { l, seen } = await loaded()
  const toolResult = { role: "user", content: [{ type: "tool_result", tool_use_id: "call_1", content: [{ type: "text", text: skillReminder }] }] }
  const body = JSON.stringify({ system: droid, messages: [{ role: "user", content: [{ type: "text", text: skillReminder }] }, toolResult] })
  await l.fetch(url, { method: "POST", body })
  expect(JSON.parse(seen[0].body).messages[1]).toEqual(toolResult)
  await l.fetch(url, { method: "POST", body: seen[0].body })
  expect(seen[1].body).toBe(seen[0].body)
})

test("adapts Claude 5 system-role runtime context without changing its role or instructions", async () => {
  const { l, seen } = await loaded()
  const environment = "# Environment\nYou have been invoked in the following environment: \n - Primary working directory: /tmp/project\n - Additional working directories:\n  - /extra/one\n  - C:\\extra two\n - Platform: darwin\n"
  const skills = "The following skills are available for use with the Skill tool:\n\n" + configSkill + "\n- custom: Keep not Claude in this user's description."
  for (const model of ["You are powered by the model named Sonnet 5.5. The exact model ID is factory/claude-sonnet-5-5. Assistant knowledge cutoff is June 2026.", "You are powered by the model group/claude-default."]) {
    const context = environment + "\n" + model + "\n\n" + skills + "\n\nToday's date is 2026-10-02.\n\nKeep these session instructions verbatim."
    const adapted = context.replace("# Environment", "# Runtime context")
      .replace("You have been invoked in the following environment:", "The session environment is:")
      .replace("You are powered by the model named", "Current model name:")
      .replace("You are powered by the model", "Current model:")
      .replace("The exact model ID is", "Model ID:")
      .replace("Assistant knowledge cutoff is", "Model knowledge cutoff:")
      .replace("not Claude", "not the assistant")
    const request = {
      system: [{ type: "text", text: droid }],
      messages: [{ role: "user", content: [{ type: "text", text: "Reply OK.", cache_control: { type: "ephemeral" } }] }, { role: "system", content: context }],
      tools: [{ name: "Read", input_schema: { type: "object", properties: { path: { type: "string" } } } }],
      thinking: { type: "adaptive" }, stream: true,
    }
    for (const endpoint of [url, url + "/count_tokens"]) {
      await l.fetch(endpoint, { method: "POST", body: JSON.stringify(request) })
      expect(JSON.parse(seen.at(-1).body)).toEqual({ ...request, messages: [request.messages[0], { role: "system", content: adapted }] })
    }
  }
})

test("leaves ordinary system messages and incomplete context outside the generated shape unchanged", async () => {
  const { l, seen } = await loaded()
  const context = "# Environment\nYou have been invoked in the following environment:\n - Platform: linux\n\nYou are powered by the model custom-model."
  for (const message of [
    { role: "user", content: context },
    { role: "assistant", content: context },
    { role: "system", content: "Follow the user's instructions.\n\n" + context },
    { role: "system", content: context.replace(" - Platform", "   - Platform") },
    { role: "system", content: "You are powered by the model custom-model." },
    { role: "system", content: [{ type: "text", text: "Follow the user's instructions.\n\n" + context }] },
  ]) {
    const body = JSON.stringify({ system: droid, messages: [message] })
    await l.fetch(url, { method: "POST", body })
    expect(seen.at(-1).body).toBe(body)
  }
})

test("adapts Claude Code 2.1.288's system-role context sent as text blocks, as the string would be (#658)", async () => {
  const { l, seen } = await loaded()
  // the shape #658 captured from Claude Code 2.1.288
  const context = "# Environment\nYou have been invoked in the following environment: \n - Platform: darwin\n\nYou are powered by the model named Opus 5.5. The exact model ID is claude-opus-5-5. Assistant knowledge cutoff is June 2026.\n\n<total_tokens>10000 tokens left</total_tokens>"
  const adapted = context.replace("# Environment", "# Runtime context")
    .replace("You have been invoked in the following environment:", "The session environment is:")
    .replace("You are powered by the model named", "Current model name:")
    .replace("The exact model ID is", "Model ID:")
    .replace("Assistant knowledge cutoff is", "Model knowledge cutoff:")
  const other = { type: "image", source: { type: "base64", media_type: "image/png", data: "x" } }
  const plain = { type: "text", text: "Keep these instructions verbatim." }
  const request = {
    system: [{ type: "text", text: droid }],
    messages: [{ role: "user", content: [{ type: "text", text: "你好" }] }, { role: "system", content: [{ type: "text", text: context, cache_control: { type: "ephemeral" } }, plain, other] }],
    stream: true,
  }
  for (const endpoint of [url, url + "/count_tokens"]) {
    await l.fetch(endpoint, { method: "POST", body: JSON.stringify(request) })
    const sent = JSON.parse(seen.at(-1).body)
    expect(sent).toEqual({ ...request, messages: [request.messages[0], { role: "system", content: [{ type: "text", text: adapted, cache_control: { type: "ephemeral" } }, plain, other] }] })
    // the same text as a string comes out the same
    await l.fetch(endpoint, { method: "POST", body: JSON.stringify({ ...request, messages: [request.messages[0], { role: "system", content: context }] }) })
    expect(JSON.parse(seen.at(-1).body).messages[1].content).toBe(adapted)
    // and adapting again changes nothing
    await l.fetch(endpoint, { method: "POST", body: JSON.stringify(sent) })
    expect(seen.at(-1).body).toBe(JSON.stringify(sent))
  }
  // folded into the user's turn on its way here
  await l.fetch(url, { method: "POST", body: JSON.stringify({ system: droid, messages: [{ role: "user", content: [{ type: "text", text: "你好" }, { type: "text", text: context }] }] }) })
  expect(JSON.parse(seen.at(-1).body).messages[0].content).toEqual([{ type: "text", text: "你好" }, { type: "text", text: adapted }])
})

test("system-role context adaptation is idempotent and preserves non-metadata paragraphs", async () => {
  const { l, seen } = await loaded()
  const context = "# Environment\nYou have been invoked in the following environment:\n - Platform: linux\n\nUser quoted: You are powered by the model custom-model.\n\nKeep the phrase not Claude in the instructions."
  await l.fetch(url, { method: "POST", body: JSON.stringify({ system: droid, messages: [{ role: "system", content: context }] }) })
  expect(JSON.parse(seen[0].body).messages[0].content).toBe(context.replace("# Environment", "# Runtime context").replace("You have been invoked in the following environment:", "The session environment is:"))
  await l.fetch(url, { method: "POST", body: seen[0].body })
  expect(seen[1].body).toBe(seen[0].body)
})

test("adapts accumulated model-switch updates when continuing a Claude 5 session", async () => {
  const { l, seen } = await loaded()
  const tokenContext = "<total_tokens>15000000 tokens left</total_tokens>"
  const instructions = "## Auto Mode Active\n\nKeep all permission instructions verbatim.\n\nUser quoted: You are powered by the model custom-model."
  const update = [
    "You are powered by the model named Sonnet 5.5. The exact model ID is factory/claude-sonnet-5-5. Assistant knowledge cutoff is June 2026.",
    tokenContext,
    "You are powered by the model group/claude-default.",
    instructions,
    tokenContext,
    "You are powered by the model named Opus 5.5. The exact model ID is factory/claude-opus-5-5. Assistant knowledge cutoff is June 2026.",
    "The following agent types are no longer available:\n- claude-code-guide",
    tokenContext,
    "USD budget: $0/$0.4; $0.4 remaining",
  ].join("\n\n")
  const messages = [
    { role: "user", content: "Continue the existing conversation." },
    { role: "system", content: "# Environment update\n - Primary working directory: /tmp/project (was /tmp/old)\n\n" + tokenContext },
    { role: "assistant", content: [{ type: "tool_use", id: "read_1", name: "Read", input: { path: "/tmp/project/proof" } }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "read_1", content: update, cache_control: { type: "ephemeral" } }] },
    { role: "system", content: update },
  ]
  const request = { system: droid, messages, tools: [{ name: "Read", input_schema: { type: "object" } }], stream: true }
  const adapted = update.replaceAll("\n\nYou are powered by the model named", "\n\nCurrent model name:")
    .replace(/^You are powered by the model named/, "Current model name:")
    .replace("\n\nYou are powered by the model group/", "\n\nCurrent model: group/")
    .replaceAll("The exact model ID is", "Model ID:")
    .replaceAll("Assistant knowledge cutoff is", "Model knowledge cutoff:")
  for (const endpoint of [url, url + "/count_tokens"]) {
    await l.fetch(endpoint, { method: "POST", body: JSON.stringify(request) })
    expect(JSON.parse(seen.at(-1).body)).toEqual({ ...request, messages: [...messages.slice(0, -1), { role: "system", content: adapted }] })
    const once = seen.at(-1).body
    await l.fetch(endpoint, { method: "POST", body: once })
    expect(seen.at(-1).body).toBe(once)
  }
})

test("requires a model-update preamble and complete token metadata before adapting standalone system text", async () => {
  const { l, seen } = await loaded()
  const model = "You are powered by the model group/claude-default."
  const update = model + "\n\n<total_tokens>15000000 tokens left</total_tokens>"
  for (const content of [
    model,
    update.replace("</total_tokens>", ""),
    update.replace("15000000", "unknown"),
    "Explain this quoted metadata:\n\n" + update,
    model + "\n\nQuoted token marker: <total_tokens>15000000 tokens left</total_tokens>",
    [{ type: "text", text: "Explain this quoted metadata:\n\n" + update }],
  ]) {
    const body = JSON.stringify({ system: droid, messages: [{ role: "system", content }] })
    await l.fetch(url, { method: "POST", body })
    expect(seen.at(-1).body).toBe(body)
  }
  for (const role of ["user", "assistant"]) {
    const body = JSON.stringify({ system: droid, messages: [{ role, content: update }] })
    await l.fetch(url, { method: "POST", body })
    expect(seen.at(-1).body).toBe(body)
  }
})

test("adapts model switches following complete working-directory update metadata", async () => {
  const { l, seen } = await loaded()
  const directory = "# Environment update\n - Primary working directory: /tmp/new (was /tmp/old)\n"
  const token = "<total_tokens>15000000 tokens left</total_tokens>"
  const model = "You are powered by the model named Opus 5.5. The exact model ID is factory/claude-opus-5-5. Assistant knowledge cutoff is June 2026."
  const context = directory + "\n" + token + "\n\n" + model + "\n\nWhile bypass permissions mode is active:\n\nKeep these permissions verbatim.\n\n" + token
  for (const endpoint of [url, url + "/count_tokens"]) {
    await l.fetch(endpoint, { method: "POST", body: JSON.stringify({ system: droid, messages: [{ role: "system", content: context }] }) })
    expect(JSON.parse(seen.at(-1).body).messages[0]).toEqual({ role: "system", content: context.replace(model, "Current model name: Opus 5.5. Model ID: factory/claude-opus-5-5. Model knowledge cutoff: June 2026.") })
    const once = seen.at(-1).body
    await l.fetch(endpoint, { method: "POST", body: once })
    expect(seen.at(-1).body).toBe(once)
  }
  for (const content of [context.replace(" - Primary", "   - Primary"), context.replaceAll(token, "<total_tokens>unknown tokens left</total_tokens>"), "Quoted update:\n\n" + context]) {
    const body = JSON.stringify({ system: droid, messages: [{ role: "system", content }] })
    await l.fetch(url, { method: "POST", body })
    expect(seen.at(-1).body).toBe(body)
  }
})

test("losslessly quotes fixed client metadata in tool output on inference and counting", async () => {
  const { l, seen } = await loaded()
  const source = '576: "You are Claude Code, Anthropic\'s official CLI for Claude."\n583: /^<system-reminder>\\nYou have been invoked in the following environment:/\nQuotes: "\\\\"; Unicode: 中文 😀; literal escape: \\u0059'
  const outputs = [
    { type: "tool_result", tool_use_id: "bash_1", content: source, is_error: false, cache_control: { type: "ephemeral" } },
    { type: "tool_result", tool_use_id: "read_1", content: [{ type: "text", text: source, cache_control: { type: "ephemeral" } }, { type: "image", source: { type: "base64", media_type: "image/png", data: "image-data" } }], is_error: true },
  ]
  for (const endpoint of [url, url + "/count_tokens"]) {
    const request = { system: droid, messages: [{ role: "assistant", content: [{ type: "tool_use", id: "bash_1", name: "Bash", input: { command: "cat index.mjs" } }] }, { role: "user", content: outputs }], tools: [{ name: "Bash", input_schema: { type: "object" } }], stream: true }
    await l.fetch(endpoint, { method: "POST", headers: { "content-length": "1" }, body: JSON.stringify(request) })
    const sent = JSON.parse(seen.at(-1).body)
    const encoded = sent.messages[1].content[0].content
    expect(encoded).toStartWith("Tool output encoded as a JSON string.")
    expect(JSON.parse(encoded.slice(encoded.indexOf("\n") + 1))).toBe(source)
    expect(encoded).not.toContain("You are Claude Code")
    expect(encoded).not.toContain("You have been invoked")
    expect(encoded).not.toContain("system-reminder")
    expect(sent.messages[1].content[0]).toEqual({ ...outputs[0], content: encoded })
    expect(sent.messages[1].content[1]).toEqual({ ...outputs[1], content: [{ ...outputs[1].content[0], text: encoded }, outputs[1].content[1]] })
    expect(sent.messages[0]).toEqual(request.messages[0])
    expect(sent.tools).toEqual(request.tools)
    expect(seen.at(-1).headers.get("content-length")).toBeNull()
    const once = seen.at(-1).body
    await l.fetch(endpoint, { method: "POST", body: once })
    expect(seen.at(-1).body).toBe(once)
  }
})

test("leaves ordinary tool results and fixed phrases outside tool-result content untouched", async () => {
  const { l, seen } = await loaded()
  const identity = "You are Claude Code, Anthropic's official CLI for Claude."
  const messages = [
    { role: "user", content: [{ type: "text", text: identity }, { type: "tool_result", tool_use_id: "plain", content: "Claude Code docs; You are Claude Code is an incomplete fragment." }, { type: "tool_result", tool_use_id: "object", content: { text: identity } }] },
    { role: "assistant", content: [{ type: "text", text: identity }] },
  ]
  const body = JSON.stringify({ system: droid, messages })
  await l.fetch(url, { method: "POST", body })
  expect(seen[0].body).toBe(body)
})

// #634: shapes Claude Code 2.1.288 and Claude Desktop send that Factory refused.
test("adapts runtime context after a SessionStart hook's output, as a system message or folded into the user's turn", async () => {
  const { l, seen } = await loaded()
  const hook = "SessionStart:startup hook success: Memory loaded.\n# Environment notes from the hook stay as they are.\n"
  const context = "# Environment\nYou have been invoked in the following environment: \n - Primary working directory: /tmp/project\n - Platform: darwin\n\nYou are powered by the model named Sonnet 5.5. The exact model ID is factory/claude-sonnet-5-5.\n\nThe following skills are available for use with the Skill tool:\n\n" + configSkill
  const adapted = context.replace("# Environment", "# Runtime context")
    .replace("You have been invoked in the following environment:", "The session environment is:")
    .replace("You are powered by the model named", "Current model name:")
    .replace("The exact model ID is", "Model ID:")
    .replace("not Claude", "not the assistant")
  const text = hook + "\n" + context
  for (const message of [{ role: "system", content: text }, { role: "user", content: [{ type: "text", text: "Reply OK." }, { type: "text", text }] }]) {
    await l.fetch(url, { method: "POST", body: JSON.stringify({ system: droid, messages: [message] }) })
    const got = JSON.parse(seen.at(-1).body).messages[0]
    const out = typeof got.content === "string" ? got.content : got.content[1].text
    expect(out).toBe(hook + "\n" + adapted)
    await l.fetch(url, { method: "POST", body: seen.at(-1).body })
    expect(seen.at(-1).body).toBe(seen.at(-2).body)
  }
  // a hook's output with no generated context after it is left alone
  const body = JSON.stringify({ system: droid, messages: [{ role: "system", content: hook + "\nYou are powered by the model named X." }] })
  await l.fetch(url, { method: "POST", body })
  expect(seen.at(-1).body).toBe(body)
})

test("renames the global CLAUDE.md in the instructions reminder only", async () => {
  const { l, seen } = await loaded()
  const reminder = "<system-reminder>\nCodebase and user instructions are shown below. Be sure to adhere to these instructions.\n\nContents of /home/u/.claude/CLAUDE.md (user's private global instructions for all projects):\n\nUse tabs.\n</system-reminder>"
  const pasted = "Why does Claude Code write (user's private global instructions for all projects)?"
  await l.fetch(url, { method: "POST", body: JSON.stringify({ system: droid, messages: [{ role: "user", content: [{ type: "text", text: reminder }, { type: "text", text: pasted }] }] }) })
  const content = JSON.parse(seen.at(-1).body).messages[0].content
  expect(content[0].text).toBe(reminder.replace("(user's private global instructions for all projects)", "(global instructions)"))
  expect(content[1].text).toBe(pasted)
})

test("adapts the model line inside Claude Desktop's system prompt", async () => {
  const { l, seen } = await loaded()
  const prompt = "<application_details>\nClaude Desktop.\n</application_details>\nYou are powered by the model named Sonnet 5.5. The exact model ID is factory/claude-sonnet-5-5.\nKeep the rest verbatim."
  await l.fetch(url, { method: "POST", body: JSON.stringify({ system: [{ type: "text", text: "You are a Claude agent, built on Anthropic's Claude Agent SDK." }, { type: "text", text: prompt }], messages: [{ role: "user", content: "hi" }] }) })
  expect(JSON.parse(seen.at(-1).body).system).toEqual([{ type: "text", text: droid }, { type: "text", text: prompt.replace("You are powered by the model named", "Current model name:").replace("The exact model ID is", "Model ID:") }])
})
