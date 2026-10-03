# @magpie-community/opencode-qoder-auth

Your [Qoder](https://qoder.com) subscription in OpenCode and
[magpie](https://usemagpie.ai). The package serves Qoder's two sites, whose
accounts exist only on their own:

| Provider id | Site | Accounts | Plugin export |
|---|---|---|---|
| `qoder` | qoder.com (international) | Google, GitHub or email | `QoderAuthPlugin` |
| `qoder-cn` | qoder.cn ([Qoder CN](#qoder-cn)) | Alibaba Cloud or phone number | `QoderCNAuthPlugin` |

What follows is about `qoder`. Qoder CN works the same way on its own
hosts; [its section](#qoder-cn) says what differs.

## Sign-in

**Sign in with Qoder** is the sign-in Qoder's desktop client uses:

1. A PKCE device flow opens qoder.com's account page.
2. openapi.qoder.sh is polled every 2 s until you authorize, for at most
   15 minutes.
3. The device token is traded for a job token, and the account's email and
   name are read.

What is kept: the job token, its refresh token and expiry, the uid, the
device token and a machine id made for this sign-in. OpenCode keeps them in
`auth.json`; magpie keeps them in `plugin-auth.json`.

Refreshing:
- Qoder spends a refresh token once, so the plugin never sends one twice.
- magpie renews the job token 10 minutes before it runs out, through the
  plugin's `auth.refresh`, once for the account and before its requests,
  models and usage need it; magpie saves the new pair. OpenCode doesn't
  call that hook: there the job token is refreshed 5 minutes before it runs
  out, before a request, and the new pair is saved straight away.
- Only one refresh runs at a time. A request that reads the sign-in before
  magpie saved a renewal uses the renewed pair, and a renewal handed a pair
  a request already spent gives what that request got.
- The device token, which reads usage, has no end on record: it is rotated
  when Qoder refuses it. On a [Qoder CN](#qoder-cn) device-token account it
  is the chat token too, and is renewed as above.
- When Qoder refuses a refresh (401 or 403), the account needs signing in
  again. Any other failure is tried again later.

## Requests

Qoder serves its models on the API its client talks to:
`api3.qoder.sh/algo/api/v2/service/pro/sse/agent_chat_generation`. The
plugin's `fetch` takes the chat completion OpenCode sends and does the rest
itself.

**Writing the request**

- It writes the chat completion as Qoder's request:
  - Qoder's own system line comes before yours.
  - Messages become text and image blocks.
  - Tool calls and results become OpenAI tool turns. Images a tool returned
    follow in a user turn.
  - Your tools become Qoder's native function tools.
  - The model's own configuration from Qoder's list goes with it.
- It picks the reasoning effort from the model's own levels:
  - The nearest level to the one asked, the higher one on a tie.
  - The model's default when none is asked.
  - The lowest level for "none", when the model can't turn thinking off.
- It encodes the body with the client's codec and signs the call with the
  client's COSY envelope. The envelope carries:
  - the account, AES-encrypted, with the key wrapped by Qoder's RSA key;
  - an MD5 signature;
  - the machine id and the client's headers.

**Reading the reply**

- Qoder's SSE comes back as a chat completion, streamed or not, with
  reasoning and usage.
- Tool calls Qoder writes as XML or JSON in its text become tool calls.
  Tool calls it sends the OpenAI way keep Qoder's id.

**Errors**

| What Qoder says | What the request returns |
|---|---|
| A refused sign-in | 401 |
| A quota | 429 |
| A failure before the answer starts | Qoder's status |
| A failure after the answer has started | The stream ends with an error |

## Models

The `provider.models` hook reads the account's own list, as Qoder's client
asks for it (`/algo/api/v2/model/list`). It keeps the enabled chat models
and leaves out "auto" and "default", which route inside Qoder. It takes
each model's reasoning levels from its `thinking_config`.

The `config` hook declares the list as it was on 2026-09-30:

- Ultimate, Performance, Efficient
- Sonus, Cantus
- Qwen3.8-Max, Qwen3.8-Flash, Qwen3.7-Max, Qwen3.7-Plus
- Kimi-K3, Kimi-K2.8-Preview
- GLM-5.3, GLM-5.3-Flash
- DeepSeek-V4-Pro, DeepSeek-Flash
- MiniMax-M3

Every model speaks chat completions (`@ai-sdk/openai-compatible`).

## Qoder CN

`qoder-cn` is for accounts on [qoder.cn](https://qoder.cn), the China site.
Those accounts sign in with Alibaba Cloud or a phone number and can't sign
in through `qoder`. Qoder CN speaks the same protocol as qoder.com:

- the same device flow, poll, job token and refresh paths;
- the same COSY envelope and body codec;
- the same model list, chat and usage paths.

Only the hosts and the sign-in's client id differ. The plugin uses the ones
Qoder CN's own CLI builds in for its `cn` build (`@qodercn-ai/qoderclicn`
1.1.65):

| | `qoder` | `qoder-cn` |
|---|---|---|
| Sign-in page | qoder.com | qoder.cn |
| Accounts: poll, tokens, user info, usage | openapi.qoder.sh | openapi.qoder.com.cn |
| Models and chat | api3.qoder.sh | gateway.qoder.com.cn |
| Device-flow client id | Qoder's desktop client's | Qoder CN's CLI's (production) |
| `redirect_uri` on the sign-in page | `qoder-app://` | none, as the CLI sends |

Qoder CN's CLI chats with the device token itself and never makes a job
token. The plugin asks qoder.cn for a job token first, as it does on
qoder.com. If qoder.cn refuses it (a 4xx), the account works the way the
CLI does:

- the device token signs the model calls;
- it is renewed with `/api/v1/deviceToken/refresh`, the chat and account
  tokens being one pair;
- a refused renewal (401 or 403) means signing in again.

Until you sign in, the `config` hook declares the tiers Qoder CN's CLI names
(Ultimate, Performance, Efficient, Lite). Once you are signed in, the
account's own list from gateway.qoder.com.cn replaces them.

Neither magpie's built-in Qoder CN nor this plugin has been checked against
every kind of qoder.cn account. If a sign-in or a chat fails, please open
an issue with the error.

## Not here

- Qoder's usage and quota display.
- Several accounts at once.
- magpie's web-search stand-in.

## Credits

The protocol (endpoints, COSY envelope, body codec and device flow) comes
from [CLIProxyAPI](https://github.com/ufec/CLIProxyAPI)'s Qoder support, by
way of magpie. Its MIT license is in `LICENSE-CLIProxyAPI`.
