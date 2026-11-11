/**
 * The billing key a usage event is attributed to.
 *
 * A session log records the assistant message's source as
 * `{ kind: "model", provider, model }`. Several providers can route the same
 * model id at different prices, so the price sheet keys on both parts joined
 * by `/`; an event with no provider keeps the bare model id, which is exactly
 * how older logs (and the plugin's own tool ledger before it named a provider)
 * were keyed. Keeping the join in one place means the fold, the price lookup
 * and the settings window can never disagree about what a row means.
 */

/**
 * One usage event's provider and model, read tolerantly.
 *
 * The source shape is the platform's, not ours: a missing provider or model is
 * a perfectly possible older log, and neither should turn into the literal
 * string "undefined" in a price key.
 * @param event - an assistant message event.
 * @returns the provider and model names, each "" when absent.
 */
export function sourceOf(event) {
  const source = event?.data?.message?.source;
  const provider =
    typeof source?.provider === "string" ? source.provider.trim() : "";
  const model = typeof source?.model === "string" ? source.model.trim() : "";
  return { provider, model };
}

/**
 * The key the price sheet and every usage aggregate use for one event.
 * @param event - an assistant message event.
 * @returns `provider/model`, or the bare model when no provider is recorded.
 */
export function billingKeyOf(event) {
  const { provider, model } = sourceOf(event);
  return billingKey(provider, model);
}

/**
 * Join a provider and a model into the one key the price sheet uses.
 * @param provider - provider id, or "" when unknown.
 * @param model - model id, or "" when unknown.
 * @returns `provider/model`, the bare model, or "unknown".
 */
export function billingKey(provider, model) {
  const name = typeof model === "string" && model !== "" ? model : "unknown";
  const owner = typeof provider === "string" ? provider.trim() : "";
  return owner === "" ? name : `${owner}/${name}`;
}
