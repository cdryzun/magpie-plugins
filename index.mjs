import { ZCodeAuthPlugin } from "./packages/zcode/index.mjs"

export default function ZCodeAuthPluginEntry(context) {
  return ZCodeAuthPlugin(context)
}
