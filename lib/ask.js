/**
 * Answering an `ask_user_question` batch on the user's behalf.
 *
 * The platform asks its user through a cordis waterfall: every listener on
 * `user-questions/request` may answer, and the first one that returns a batch
 * wins. This module is such a listener. It is registered with `prepend`, so it
 * sees the request before the Client's own answerer does — otherwise the human
 * card would already be on screen and the automatic answer could never land.
 *
 * Three rules shape everything below.
 *
 * Fail open. Any reason not to answer — the switch is off, the batch asks for
 * something this must never decide, the model returned nothing usable, the call
 * failed or ran out of time — returns *no batch* rather than an answer. The
 * caller then continues down the waterfall and the human still gets the card.
 * A wrong automatic answer to a real question is worse than a slower one.
 *
 * One request, one user message. Like the compaction summarizer this is a
 * direct `llm.stream` call, not a subagent: there is no child session, no tool
 * set and no permission preset, so the only thing this call can produce is
 * text. No tools are passed, because a model holding a tool list will use it.
 *
 * Attribution travels in `custom`. The question service copies only
 * `{id, selected, custom}` out of an answer batch, so an extra field carrying
 * provenance would be dropped before the card renders. The client draws
 * `custom` after the selected labels, which is exactly where "answered by
 * <provider>/<model>" belongs.
 */

import { appendLedger, usageFromChunk } from "./ledger.js";
import { translatorFor } from "./i18n.js";
import { instructionMessage, resolveRoute } from "./contextops.js";
import { DEFAULT_ASK_PROMPT } from "./prompts.js";

// The question-answerer tests (and any external consumer) still read the
// shipped instruction from this module. The cycle that used to make a bare
// import of this file throw is gone, so this is now a plain re-export.
export { DEFAULT_ASK_PROMPT };



/**
 * Wording that puts a batch out of bounds for automatic answering.
 *
 * Deliberately blunt and deliberately over-eager: a false positive costs the
 * user one card they have to read, while a false negative has a model deciding
 * a permission prompt, a credential question or a deletion. The patterns are
 * matched against the question text, its header, its detail and every option
 * label and description, because a batch can hide the risky part in an option.
 */
const FORBIDDEN_PATTERNS = [
  /权限|审批|批准|授权|放行|提权|管理员|沙箱/iu,
  /\b(?:permission|approv\w*|authori[sz]\w*|escalat\w*|sandbox|admin|sudo|root access)\b/iu,
  /密钥|凭据|凭证|令牌|密码|口令|私钥|验证码|二次验证|双因素/iu,
  /\b(?:api[-_ ]?key|access[-_ ]?key|secret|credential\w*|password|passphrase|private key|otp|2fa|two[- ]factor)\b/iu,
  /删除|清除所有|销毁|抹除|格式化|不可逆|无法恢复|不可撤销/iu,
  /\b(?:delete|remove|destroy|wipe|erase|drop (?:table|database)|format (?:the )?disk|rm -rf|irreversible|unrecoverable)\b/iu,
  /付费|支付|购买|付款|订阅|充值|退款|发票|钱包/iu,
  /\b(?:purchase|payment|pay for|subscri\w*|refund|invoice|wallet|credit card)\b/iu,
  /发布到|上线|生产环境|推送到主干|正式发布/iu,
  /\b(?:publish|release to|deploy(?:ment)? to|production|go live)\b/iu,
];

/**
 * Whether a batch must be left to the human.
 *
 * Two independent reasons: the batch declares an `intent` (approval and
 * plan-review batches are the platform's way of asking for authorisation, which
 * is never this plugin's to give), or the wording lands in a forbidden zone.
 * @param request - the `user-questions/request` payload.
 * @returns whether the batch must not be answered automatically.
 */
export function shouldDefer(request) {
  const questions = Array.isArray(request?.questions) ? request.questions : [];
  if (questions.length === 0) return true;
  for (const question of questions) {
    if (question?.intent !== undefined) return true;
    const parts = [
      question?.question,
      question?.header,
      question?.detail,
      ...(Array.isArray(question?.options)
        ? question.options.flatMap((option) => [option?.label, option?.description])
        : []),
    ];
    const text = parts
      .filter((part) => typeof part === "string")
      .join("\n");
    if (text === "") continue;
    if (FORBIDDEN_PATTERNS.some((pattern) => pattern.test(text))) return true;
  }
  return false;
}

/** Strip a code fence a model wrapped its whole answer in. */
function stripFence(text) {
  return text
    .replace(/^\s*`{3}(?:json|JSON)?\s*/u, "")
    .replace(/\s*`{3}\s*$/u, "");
}

/**
 * Turn the model's answer text into the batch the question service accepts.
 *
 * Validation is strict on purpose, and a partially usable batch is rejected
 * whole: the service requires one answer per question, and an answer batch that
 * silently dropped a question would leave the agent waiting for one it thinks
 * the user answered. A label the model invented is not "close enough" — it is
 * an option the question never offered, so the batch is refused rather than
 * trimmed into something that looks right.
 * @param text - the model's answer.
 * @param questions - the batch that was asked.
 * @param attribution - the note naming the model that answered.
 * @returns the answer batch, or null when it must be left to the user.
 */
export function parseAnswerBatch(text, questions, attribution) {
  if (typeof text !== "string" || text.trim() === "") return null;
  let value;
  try {
    value = JSON.parse(stripFence(text).trim());
  } catch {
    return null;
  }
  const raw = Array.isArray(value)
    ? value
    : Array.isArray(value?.answers)
      ? value.answers
      : null;
  if (raw === null || raw.length !== questions.length) return null;
  const byId = new Map();
  for (const entry of raw) {
    if (entry === null || typeof entry !== "object") return null;
    if (typeof entry.id !== "string") return null;
    byId.set(entry.id, entry);
  }

  const answers = [];
  for (const question of questions) {
    const entry = byId.get(question.id);
    if (entry === undefined) return null;
    const offered = new Set(
      (Array.isArray(question.options) ? question.options : [])
        .map((option) => option?.label)
        .filter((label) => typeof label === "string"),
    );
    const picked = [];
    for (const label of Array.isArray(entry.selected) ? entry.selected : []) {
      if (typeof label !== "string") continue;
      if (!offered.has(label)) return null;
      if (!picked.includes(label)) picked.push(label);
    }
    if (question.multiSelect !== true && picked.length > 1) return null;
    const custom = typeof entry.custom === "string" ? entry.custom.trim() : "";
    if (picked.length === 0 && custom === "") return null;
    const answer = { id: question.id, selected: picked };
    const note = attribution === "" ? custom : custom === "" ? attribution : `${custom} ${attribution}`;
    if (note !== "") answer.custom = note;
    answers.push(answer);
  }
  return { answers };
}

/**
 * Ask the answering model one batch and return its answer batch.
 *
 * Every failure mode returns null instead of throwing: the caller's only sane
 * reaction to any of them is to let the human answer, and a question that
 * vanished because a model call failed would stall the agent forever.
 * @param ctx - the Host context.
 * @param request - the `user-questions/request` payload.
 * @param options - the answer prompt, route override and wait budget.
 * @returns `{answers}`, or null when the batch stays with the user.
 */
export async function answerQuestions(ctx, request, options) {
  const t = translatorFor(ctx);
  const llm = ctx.get("llm");
  const agent = request?.agent;
  if (llm === undefined || agent === undefined) return null;
  const questions = Array.isArray(request.questions) ? request.questions : [];
  if (questions.length === 0) return null;

  const route = await resolveRoute(
    ctx,
    agent,
    typeof options?.provider === "string" ? options.provider : "",
    typeof options?.model === "string" ? options.model : "",
  );
  if (route.provider === "" || route.model === "") return null;

  const prompt =
    typeof options?.prompt === "string" && options.prompt.trim() !== ""
      ? options.prompt
      : DEFAULT_ASK_PROMPT;
  const payload = questions.map((question) => ({
    id: question.id,
    ...(typeof question.header === "string" ? { header: question.header } : {}),
    question: question.question,
    ...(typeof question.detail === "string" ? { detail: question.detail } : {}),
    ...(typeof question.multiSelect === "boolean"
      ? { multiSelect: question.multiSelect }
      : {}),
    ...(Array.isArray(question.options)
      ? {
          options: question.options.map((option) => ({
            label: option?.label,
            ...(typeof option?.description === "string"
              ? { description: option.description }
              : {}),
          })),
        }
      : {}),
  }));
  const body = [
    prompt,
    "## Questions",
    JSON.stringify(payload, null, 2),
  ].join("\n\n");

  // The wait budget is this plugin's own: the platform's timed tool already
  // carries a deadline of its own, and whichever comes first must hand the
  // batch back to the human rather than leave the agent waiting on a model.
  const seconds = Number.isInteger(options?.timeout) ? options.timeout : 120;
  const deadline =
    seconds === -1 ? undefined : AbortSignal.timeout(seconds * 1_000);
  const signal =
    deadline === undefined
      ? request.signal
      : request.signal === undefined
        ? deadline
        : AbortSignal.any([request.signal, deadline]);

  let text = "";
  let usage = null;
  const stream = llm.stream({
    provider: route.provider,
    model: route.model,
    messages: [instructionMessage(body)],
    sessionId: agent.session.id,
    purpose: "ask-answer",
    ...(signal === undefined ? {} : { signal }),
  });
  try {
    for await (const chunk of stream) {
      if (chunk.type === "text-delta") text += chunk.text;
      else if (chunk.type === "usage") usage = usageFromChunk(chunk);
    }
  } catch (error) {
    // A timeout or an aborted turn is the ordinary way this ends early; the
    // remaining possibility is an adapter failure. Both hand the batch back.
    return null;
  } finally {
    // The spend is real whichever way the stream ended, and this call's tokens
    // never reach a session log, so the ledger is the only place they appear.
    await appendLedger(ctx, {
      kind: "usage",
      purpose: "ask-answer",
      provider: route.provider,
      model: route.model,
      sessionId: agent.session.id,
      ...(usage ?? {
        input: Math.ceil(JSON.stringify(body).length / 4),
        output: Math.ceil(text.length / 4),
        cacheRead: 0,
        cacheWrite: 0,
      }),
      estimated: usage === null,
      chars: text.length,
    });
  }

  const attribution = t("ask.attribution", {
    route: `${route.provider}/${route.model}`,
  });
  return parseAnswerBatch(text, questions, attribution);
}
