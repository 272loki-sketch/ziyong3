/** Read-only adapter for native MVU's display protocol, not a card/panel name heuristic.
 * Native MVU appends this marker after parsing and saving message variables. The host
 * deliberately discards native `mes` edits to protect the canonical story. Reconstitute
 * only its display marker from the exact message's saved variables + processing receipt;
 * the enabled original card regex, including its depth limits, still owns the UI.
 * No parser/model/event replay, story write or variable fabrication is involved.
 */
import type { TavernPluginContext } from "./tavern-plugin-http.ts";
import type { TavernPluginState } from "./tavern-plugin-store.ts";

const MVU_DISPLAY_MARKER = "<StatusPlaceHolderImpl/>";
const record = (value: unknown): Record<string, unknown> | undefined =>
 value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

export function mvuDisplaySuffixes(context: TavernPluginContext, state: TavernPluginState, active: boolean): ReadonlyMap<string, string> {
 const result = new Map<string, string>();
 if (!active) return result;
 const visible = new Set(context.visibleEntryIds);
 const receipts = record(state.chatMetadata.__liyuanMvuProcessed);
 for (const message of context.chat) {
  const id = message.__liyuanEntryId;
  if (typeof id !== "string" || !visible.has(id) || message.is_user || message.is_system || message.__liyuanUnfinished) continue;
  const source = typeof message.__liyuanAuthorDelivery === "string" ? message.__liyuanAuthorDelivery : message.mes;
  if (typeof source !== "string" || !source.trim() || source.includes(MVU_DISPLAY_MARKER)) continue;
  const receipt = record(receipts?.[id]);
  if (!receipt || !["normal", "updated", "unchanged"].includes(String(receipt.status))) continue;
  const variables = state.messages[id]?.variables;
  const slot = Array.isArray(variables) ? variables[Number(message.swipe_id) || 0] : variables;
  const data = record(record(slot)?.stat_data);
  // Inherited/default data without a receipt is not proof of this message's processing.
  // Equally, a receipt without its exact saved data cannot display an invented state.
  if (!data || !Object.keys(data).length) continue;
  result.set(id, "\n\n" + MVU_DISPLAY_MARKER);
 }
 return result;
}
