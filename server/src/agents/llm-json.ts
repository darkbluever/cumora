/**
 * Parse the model's JSON answer out of the model's own packaging.
 *
 * Every classifier in here asks for `text: { format: { type: 'json_object' } }`
 * and every one of them USED to hand `r.output_text` straight to `JSON.parse`.
 * That works exactly as long as the endpoint honors `json_object` — a cloud
 * guarantee. Behind an OpenAI-compatible shim (a self-hosted gateway, a local
 * model, a proxy) it is advisory at best, and the answer comes back fenced:
 *
 *     ```json
 *     {"actionable": false, …}
 *     ```
 *
 * which throws `Unexpected token '`'`. Every call site catches, so nothing
 * crashes — the classifier just silently never votes, and its fail-closed
 * branch becomes the only branch. That is the worst failure shape available:
 * you pay for the LLM call and get the outage behavior.
 *
 * `triage-core.ts` already had this function, private. It lives here now so
 * that "which of our JSON parses tolerate a fence" has ONE answer instead of
 * one per call site.
 *
 * Scope: this recovers PACKAGING only. Junk with no object in it stays
 * unparseable on purpose — a caller that treats a throw as "classifier
 * unavailable" must keep doing so, and returning `{}` here would quietly
 * promote an outage into a real verdict.
 */

/** Pull the JSON object out of a model's raw text: tolerate ```json fences and
 *  any chatter before/after the object (a small local model is chattier than a
 *  json_object-constrained cloud call). Also survives a fence that never
 *  closed, which is what a `max_output_tokens` cutoff looks like. Returns a
 *  string for `JSON.parse` — deliberately NOT a parsed value, so each caller
 *  keeps its own error handling. */
export function extractJsonObject(raw: string): string {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)
  // No closing fence (truncated answer)? Drop the opening one and keep going.
  const body = fenced ? fenced[1] : raw.replace(/^\s*```(?:json)?[ \t]*\r?\n?/i, '')
  const start = body.indexOf('{')
  const end = body.lastIndexOf('}')
  return start >= 0 && end > start ? body.slice(start, end + 1) : body.trim()
}
