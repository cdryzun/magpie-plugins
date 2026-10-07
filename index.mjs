import { ZCodeAuthPlugin } from "./packages/zcode/index.mjs"

// This fork's entry spends GLM-5.3-Flash on ZCode's Start Plan first, and
// replays a refused or unreachable Start turn once on the GLM Coding Plan.
// Explicit Trial entries keep the community plugin's gift-only routing.
export default function ZCodeAuthPluginEntry(context) {
  return ZCodeAuthPlugin(context, { startFlashFirst: true })
}
