import { ZCodeAuthPlugin } from "./packages/zcode/index.mjs"

export default function ZCodeStartFirst(context) {
  return ZCodeAuthPlugin(context, { startFlashFirst: true })
}
