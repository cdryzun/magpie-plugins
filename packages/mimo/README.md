# @magpie-community/opencode-mimo-auth

Signs in to **Xiaomi MiMo** with a Xiaomi account, the way the MiMo desktop
app does, and makes its model requests. Provider id: `mimo-app`.

## Sign-in

One way, **Xiaomi account**. The plugin opens Xiaomi's sign-in page
(account.xiaomi.com's long-poll ticket). Sign in there, or scan its QR code
with the Xiaomi phone app. The plugin waits on the ticket until Xiaomi says
the account is in, so there's nothing to paste back.

Xiaomi's passToken then signs the account on at the MiMo server. The server
sends the browser through account.xiaomi.com and back through its `/sts`,
which sets the session cookies (`serviceToken`, `userId`, `cUserId`). An
account from Russia or India is moved to that region's server
(`mimo-server-ru` / `mimo-server-in`). Everyone else stays on
`mimo-server-sgp`.

## Requests

Chat completions go to `https://mimo-server-<region>.xiaomimimo.com/api/route/chat/completions`
(`@ai-sdk/openai-compatible`). Each request carries:

- the session cookies, with no `Authorization` header
- `X-Mimo-Source: mimocode-cli-free`
- `X-Client-Version: 26.929.292248`
- the app's User-Agent

`mimo-auto`, the app's default model, is requested as `mimo-pro`.

The session is renewed with the passToken a day after it was issued.
magpie (0.1.684 and later) does it ahead of time through `auth.refresh`, ten
minutes before that day is out (`refreshLead`), once for the account and
before its requests, models and usage ask for it; a passToken Xiaomi no
longer takes marks the account for a new sign-in. The check before each
request stays for OpenCode, which doesn't call `auth.refresh`, and one
sign-on at a time serves both. A model
request the server turns away (a 401) is answered as the server answered it,
as magpie's built-in MiMo account did; reading usage renews the session once
when the server turns it away. If the passToken no longer works, sign in
again.

## Where the sign-in is kept

In OpenCode's `auth.json`, or magpie's `plugin-auth.json`, as an OAuth sign-in:

- `refresh`: the Xiaomi account as JSON (`userId`, `cUserId`, `passToken`, `deviceId`, `region`, `base`)
- `access`: the session cookies as JSON
- `expires`: when the session is renewed
- `accountId`: the Xiaomi user id

## Models

| Model | Name | Context | Output | Input |
|---|---|---|---|---|
| `mimo-pro` | MiMo Pro | 1,000,000 | 128,000 | text, image |
| `mimo-flash` | MiMo Flash | 1,000,000 | 128,000 | text, image |
