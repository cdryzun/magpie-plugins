// Qoder's stream gives the usage in a chunk of its own after the finish,
// with no choices (as a real qmodel reply did); read up to the finish only,
// every request was counted as 0 tokens.
import { expect, test } from "bun:test"
import { _internal } from "./index.mjs"

const line = (body) => `data:${JSON.stringify({ headers: {}, body: typeof body === "string" ? body : JSON.stringify(body), statusCodeValue: 200, statusCode: "OK" })}\n\n`

test("the usage after the finish is read", async () => {
  const sse =
    line({ choices: [{ delta: { content: "Hi", reasoning_content: "" }, index: 0 }], object: "chat.completion.chunk" }) +
    line({ choices: [{ delta: { content: "" }, finish_reason: "stop", index: 0 }], object: "chat.completion.chunk" }) +
    line({
      choices: [],
      object: "chat.completion.chunk",
      usage: { completion_tokens: 106, completion_tokens_details: { reasoning_tokens: 94 }, prompt_tokens: 40, prompt_tokens_details: { cached_tokens: 32 }, total_tokens: 146 },
    }) +
    line("[DONE]") +
    `data:${JSON.stringify({ firstTokenDuration: 821, totalDuration: 1982 })}\n\n`
  const out = []
  for await (const e of _internal.events(new Response(sse).body)) out.push(e)
  expect(out.map((e) => e.text).filter(Boolean).join("")).toBe("Hi")
  expect(out.at(-1)).toEqual({
    stop: "stop",
    usage: {
      prompt_tokens: 40,
      completion_tokens: 106,
      total_tokens: 146,
      prompt_tokens_details: { cached_tokens: 32 },
      completion_tokens_details: { reasoning_tokens: 94 },
    },
  })
})
