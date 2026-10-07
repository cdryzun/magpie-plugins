# @magpie-community/opencode-commandcode-auth

Signs in to a [Command Code](https://commandcode.ai) plan (Pro, GOAT, Max,
Ultra, Go, Teams Pro) and makes its requests, in OpenCode and in magpie.
Provider id: `commandcode-plan`.

## Signing in

An account is a Command Code API key. There are three ways to get one:

- **Command Code (browser)**: the CLI's own sign-in. Studio asks you to
  approve a key for this machine, then posts it to a callback on
  `127.0.0.1`. The plugin checks the key with `/alpha/whoami` and reads the
  plan.
- **Command Code CLI's sign-in**: takes the account `commandcode login`
  signed in to, from `~/.commandcode/auth.json`. The file is only read,
  never changed.
- **API key**: paste a key from
  [commandcode.ai/settings/keys](https://commandcode.ai/settings/keys).

The key is kept where OpenCode keeps sign-ins (`auth.json`; in magpie,
`plugin-auth.json`) as `{ "type": "api", "key", "metadata": { "email": <user>, "plan" } }`.
Keys don't expire, so there is nothing to refresh.

## Requests

- **Every plan but Go** uses the Provider API at
  `https://api.commandcode.ai/provider/v1`. Every request carries the key
  as both `Authorization: Bearer` and `x-api-key`.
  - Claude models speak Anthropic's Messages API.
  - The other models speak chat completions.
- **Go** has no Provider API access. Its key is only accepted where the CLI
  asks, `POST /alpha/generate`, in the CLI's own format (command-code
  1.72.2 and its headers). The plugin's `fetch` handles this:
  - It turns OpenCode's chat completion into that format.
  - It turns the line-by-line reply back into a chat completion, streamed
    or not.
  - Failures keep their statuses: a model the plan lacks is a 403, running
    out of credits is a 402, and a usage-window limit is a 429.

The plan is read from `/alpha/billing/subscriptions`. It is cached for 10
minutes; after a failed read, the plugin tries again after 1 minute.
When the plan isn't known yet and the Provider API refuses the key with
"Your Go plan doesn't include API access", the key is taken as Go's from
then on (and saved so with it), and a chat completion is sent again to
`/alpha/generate`.

## Models

The `config` hook declares the default list:

| Model | Context window |
|---|---|
| Claude Sonnet 5 | 1M |
| Claude Opus 5.5 | 1M |
| GPT-6 Sol | 1.05M |
| DeepSeek V4 Pro | 1M |
| DeepSeek V4 Flash | 1M |
| Kimi K3 | 1M |
| GLM-5.3 | 1M |
| MiniMax M3 | 1M |

Once signed in, the `provider.models` hook replaces the default list with
the account's own:

- **Every plan but Go**: the Provider API's `/models` list. Each model's
  `supported_endpoints` picks the API it speaks.
- **Go**: the same `/models` list, asked without the key (it answers
  without one, and Go's key has no Provider API), less the models the
  CLI's table (command-code 1.73.0) refuses Go: the premium ones (Claude,
  GPT-6 Sol, GPT-5.6 Terra, …) and those it blocks for Go (GPT-5.6 Sol,
  Claude Sonnet 5.5, Grok 4.6 and 4.7, …). That is 56 models as of
  2026-10-01. When the list can't be had, the CLI's own Go table (57
  models) stands in.

  The Go models carry their reasoning levels, and a requested level is
  fitted to the nearest one the model has.

The `/models` list doesn't say which models take images. A model is marked
as taking them when it is a Claude model, or when the default list or the
CLI's table says so. For any other model the plugin says nothing either
way, and magpie answers from models.dev, as its built-in did.

## Not included

- Usage and quota (`/alpha/billing/credits`, the 5-hour and weekly windows).
- Switching between several accounts. OpenCode keeps one sign-in per
  provider.
