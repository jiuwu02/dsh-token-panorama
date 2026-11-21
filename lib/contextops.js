/**
 * Clearing, compacting and deleting on a session's context.
 *
 * All three operations write a replacement node placed by a `replace` surface
 * operation. Compaction's replacement is one checkpoint `user/message` carrying
 * a `compact-checkpoint` source, the shape the platform's own chat reads, so
 * the "context was compacted" marker, its disclosure and its token count all
 * light up without any Client work. A delete instead replaces its run with an
 * empty `system/message`, which projects to no wire message at all and renders
 * no Chat row — the run is gone from the model's context and from the view,
 * while the durable log keeps the shadowed events.
 *
 * They differ in span and in when they may run. Clearing replaces the *whole*
 * surface and therefore needs an idle session — a step appending during the
 * rewrite would be dropped with the history it belongs to. Compacting replaces
 * only the span it selected *before* summarizing, which ends at the last cut
 * that does not split a tool-call/result pair. Deleting replaces the smallest
 * run that contains the targeted rows and splits no pair either. Everything
 * the conversation writes while a summarizer runs lands after that cut and is
 * replayed verbatim behind the checkpoint, so compacting works mid-turn.
 *
 * The events are written directly rather than through `ctx.compaction`:
 * `compactRegion` only runs while a turn is open and insists the whole surface
 * is unchanged across the model call, which is the pause this exists to avoid;
 * `compactNow` always keeps the newest node and requires an idle agent.
 */

import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";

import { translatorFor } from "./i18n.js";
import { appendLedger, usageFromChunk } from "./ledger.js";
import { TaskLocks } from "./lock.js";
import {
  DEFAULT_COMPACT_PROMPT,
  DEFAULT_OPTIMIZER_PROMPT,
} from "./prompts.js";

// Kept as re-exports: the settings tests and any external consumer still read
// the shipped instructions from this module, even though the strings now live
// in one dependency-free file. Keeping the names here costs one binding each
// and preserves the public surface.
export { DEFAULT_COMPACT_PROMPT, DEFAULT_OPTIMIZER_PROMPT };

const SUMMARY_OPEN_TAG = "<compacted-summary>";
const SUMMARY_CLOSE_TAG = "</compacted-summary>";

/**
 * The `source.kind` every checkpoint this module writes carries.
 *
 * The platform recognizes a checkpoint by this value plus a `compactionId`,
 * so it has to stay exactly this string: the chat UI's compaction marker, the
 * counts it shows and the expandable summary all key off it. What differs
 * between the two operations is `source.origin`, below.
 */
const COMPACT_KIND = "compact-checkpoint";

/**
 * Which operation wrote a checkpoint: `compact` summarized the history,
 * `clear` discarded it.
 *
 * This distinction is what makes clearing after compacting work at all. Both
 * operations leave exactly one surface node, so "already a single checkpoint"
 * cannot by itself mean "nothing to clear" — that reading would treat the
 * summary a compaction just wrote as an empty conversation and refuse to
 * clear it. Only a checkpoint `clear` wrote is nothing-to-clear.
 */
const CLEAR_ORIGIN = "clear";

/**
 * Which operation wrote a checkpoint: `delete` discarded one run of rows.
 *
 * A delete replaces its run with an empty `system/message` rather than with a
 * checkpoint, so this marker only lives on the operation input; no event
 * carries it. It exists so {@link replaceSurface} can tell the two replacement
 * shapes apart without threading a second flag through every caller.
 */
const DELETE_ORIGIN = "delete";

/**
 * The placeholder text a cleared session keeps.
 *
 * Also the marker that identifies a checkpoint as a clear: sessions cleared
 * before `source.origin` existed carry no such field, and their placeholder is
 * this exact sentence, so matching on it keeps "clear twice" a no-op for old
 * logs too.
 */
const CLEAR_PLACEHOLDER =
  "The user cleared this session's context. Nothing before the messages that follow is retained; continue from them alone.";

/**
 * The framing the platform puts around every checkpoint.
 *
 * Reusing it verbatim keeps a checkpoint written here indistinguishable from
 * one the built-in engine writes, which is what lets the same rendering and
 * the same "do not acknowledge this" instruction hold.
 */
const CHECKPOINT_PREAMBLE =
  "This is an automatically generated checkpoint condensing an earlier span of the conversation to free up context. Treat the captured context as established background and build on it without restating it. Continue the task directly from the messages that follow, without acknowledging this checkpoint.";





/**
 * Scan backwards for the compaction lock, the open turn, the open step and the
 * last seed.
 *
 * A `compaction/start` with no later `compaction/end` means a compaction is
 * in flight; a later `session/end-seed` supersedes it. Copied from the
 * platform's own entry-state walk so the two agree on what "busy" means. The
 * open step is the one a delete's tombstone must name: `system/message` events
 * are step-scoped in the stored format, so one may only be written while a
 * step is open.
 * @param session - the session to inspect.
 * @returns the open turn event, the unmatched start event, the seed seq, and
 *   the open step's coordinates (or null when no step is open).
 */
export function inspectEntryState(session) {
  let openTurn = null;
  let openTurnKnown = false;
  let unmatched;
  let compactionKnown = false;
  let latestEndSeed;
  let openStep = null;
  let openStepKnown = false;
  for (let seq = session.seq - 1; seq >= 0; seq -= 1) {
    const event = session.eventAt(seq);
    if (latestEndSeed === undefined && event.type === "session/end-seed")
      latestEndSeed = event.seq;
    if (!compactionKnown) {
      if (event.type === "compaction/start") {
        unmatched = event;
        compactionKnown = true;
      } else if (event.type === "compaction/end") compactionKnown = true;
    }
    if (!openTurnKnown) {
      if (event.type === "turn/start") {
        openTurn = event.data.turn;
        openTurnKnown = true;
      } else if (event.type === "turn/end") openTurnKnown = true;
    }
    if (!openStepKnown) {
      if (event.type === "step/start") {
        const data = event.data;
        if (
          Number.isSafeInteger(data?.turn) &&
          Number.isSafeInteger(data?.step)
        )
          openStep = { turn: data.turn, step: data.step };
        openStepKnown = true;
      } else if (event.type === "step/end") openStepKnown = true;
    }
    if (
      openTurnKnown &&
      compactionKnown &&
      latestEndSeed !== undefined &&
      openStepKnown
    )
      break;
  }
  return { openTurn, unmatched, latestEndSeed, openStep };
}

/**
 * Resolve the live agent behind a session id.
 *
 * The dock buttons only know the session they were rendered for, and an agent
 * is keyed by that same id for roots as well as children.
 * @param ctx - the Host context.
 * @param sessionId - the session the buttons were rendered for.
 * @returns the live agent, or undefined when the session has none.
 */
export function agentForSession(ctx, sessionId) {
  if (typeof sessionId !== "string" || sessionId === "") return undefined;
  const agents = ctx.get("agents");
  const direct = agents?.get?.(sessionId);
  if (direct !== undefined && direct !== null) return direct;
  for (const agent of agents?.list?.() ?? []) {
    if (agent?.session?.id === sessionId) return agent;
  }
  return undefined;
}

/**
 * The task locks one Host context owns, one instance per plugin lifetime.
 *
 * Keyed on the context so a rebuilt plugin fiber takes a fresh lock identity
 * while the lock file it writes stays shared — that file is what a second
 * window sees, and what the status route reports.
 */
const locksByCtx = new WeakMap();

/**
 * The shared task-lock registry for one Host context.
 * @param ctx - the Host context.
 * @returns this context's `TaskLocks`.
 */
export function taskLocksFor(ctx) {
  let locks = locksByCtx.get(ctx);
  if (locks === undefined) {
    locks = new TaskLocks(ctx);
    locksByCtx.set(ctx, locks);
  }
  return locks;
}

/**
 * Run one context operation under the session's task lock.
 *
 * The log-level compaction lock already refuses a second compaction; this is
 * the guard the log cannot give — across *different* operations and across
 * processes. A clear that lands while a compaction is summarizing would
 * rewrite the surface the checkpoint is about to replace, and an optimizer
 * reading a surface mid-rewrite returns a rewrite of the wrong text. The lock
 * is held for the whole operation and expires on its own if the process dies.
 * @param ctx - the Host context.
 * @param agent - the agent whose session is being rewritten.
 * @param job - the guarded work.
 * @returns whatever the job returned.
 */
async function withSessionLock(ctx, agent, job) {
  const t = translatorFor(ctx);
  const locks = taskLocksFor(ctx);
  const key = `context:${agent.session.id}`;
  const taken = await locks.acquire(key);
  if (!taken) throw new Error(t("error.taskBusy"));
  try {
    return await job();
  } finally {
    await locks.release(key);
  }
}

/**
 * Run `job` while the agent is guaranteed idle.
 *
 * Clearing holds this guard because it replaces the *whole* surface: a step
 * that appends while the rewrite runs would be dropped along with the history
 * it belongs to, and there is nothing left to replay it after. Compacting does
 * not take it — it replaces a span behind the running step, which is what lets
 * it run mid-conversation. In maintenance the agent looks idle to the UI and a
 * prompt arriving meanwhile is queued rather than raced.
 * @param agent - the agent to guard.
 * @param job - the work; receives the maintenance abort signal.
 * @param t - translator for the one refusal this guard can report.
 * @returns whatever the job returned.
 */
async function whileIdle(agent, job, t) {
  let outcome;
  try {
    await agent.runMaintenance(async (agentSignal) => {
      outcome = await job(agentSignal);
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("already has active work"))
      throw new Error(t("error.busy"));
    throw error instanceof Error ? error : new Error(message);
  }
  return outcome;
}

/**
 * Whether each cut right after a surface node leaves no tool call unanswered.
 *
 * A compaction may only end on such a cut. Replacing a span that splits a
 * tool-call/result pair would leave the replayed request holding a result with
 * no preceding call, which the provider rejects. The platform folds the same
 * rule over the same surface before it compacts; this plugin writes its own
 * events, so it has to fold the rule itself instead of inheriting it.
 * @param session - the session whose surface is measured.
 * @param seqs - current surface nodes, in order.
 * @returns one boolean per node: true when the cut after it is balanced.
 */
function pairingCuts(session, seqs) {
  const cuts = new Map();
  let open = 0;
  for (const seq of seqs) {
    const event = session.eventAt(seq);
    if (event?.type === "assistant/message") {
      const content = Array.isArray(event.data?.message?.content)
        ? event.data.message.content
        : [];
      open += content.filter((block) => block?.type === "tool-call").length;
    } else if (event?.type === "tool/result") open -= 1;
    cuts.set(seq, open === 0);
  }
  return cuts;
}

/**
 * The span a compaction replaces, measured at the moment it is asked for.
 *
 * The end is the surface tail at this instant, not the tail the summary
 * eventually lands on: everything the session appends while the summarizer
 * runs is newer than this cut, so it stays outside the replacement and is
 * replayed after the checkpoint exactly as it was written. That is what lets a
 * compaction run without stopping the conversation.
 *
 * The span never reaches past the last `turn/end` in a way that matters: the
 * summarizer reads replayed messages rather than a forked child, so a span that
 * runs into the open turn is summarized from the messages themselves.
 * @param session - the session being compacted.
 * @returns the span, or null when nothing qualifies.
 */
function selectCompactSpan(session) {
  const nodes = session.surface.nodes;
  if (nodes.length === 0) return null;
  const firstIdx = session.eventAt(nodes[0])?.type === "system/message" ? 1 : 0;
  if (firstIdx >= nodes.length) return null;
  const cuts = pairingCuts(session, nodes);
  let endIdx = nodes.length - 1;
  while (endIdx >= firstIdx && cuts.get(nodes[endIdx]) !== true) endIdx -= 1;
  if (endIdx < firstIdx) return null;
  const shadowedSeqs = nodes.slice(firstIdx, endIdx + 1);
  return {
    start: shadowedSeqs[0],
    end: shadowedSeqs[shadowedSeqs.length - 1],
    shadowedSeqs,
  };
}

/**
 * The span a "compact to here" replaces: everything above one surface node.
 *
 * The chat's right-click action names the row the gesture landed on and means
 * "this message and everything below stays verbatim". The span therefore ends
 * at the last balanced cut strictly before that node: a cut that split a
 * tool-call/result pair could not be replaced without orphaning the answer,
 * so the walk-back keeps the few extra rows needed to close every open call.
 * @param session - the session being compacted.
 * @param beforeSeq - the first seq that must survive untouched.
 * @returns the span, or null when nothing balanced sits above the node.
 */
export function selectSpanBefore(session, beforeSeq) {
  const nodes = session.surface.nodes;
  const index = nodes.indexOf(beforeSeq);
  if (index <= 0) return null;
  const firstIdx = session.eventAt(nodes[0])?.type === "system/message" ? 1 : 0;
  const cuts = pairingCuts(session, nodes);
  let endIdx = index - 1;
  while (endIdx >= firstIdx && cuts.get(nodes[endIdx]) !== true) endIdx -= 1;
  if (endIdx < firstIdx) return null;
  return {
    start: nodes[firstIdx],
    end: nodes[endIdx],
    shadowedSeqs: nodes.slice(firstIdx, endIdx + 1),
  };
}

/**
 * Split one Chat row key into the Definition kind and its business id.
 *
 * The conversation engine keys every node `${kind.length}:${kind}${id}` — the
 * length prefix is what keeps an id containing colons from being re-split. The
 * id is Definition-owned: a message id for input messages, `turn:step` for an
 * assistant step, a call id for a tool row, the literal seq for the
 * unknown-surface fallback. The chat view publishes the whole key as the
 * row's `data-chat-node-key`, which is how a right-click reaches the log.
 * @param key - the `data-chat-node-key` attribute value.
 * @returns the parsed kind and id, or null when the key is not one.
 */
export function parseChatNodeKey(key) {
  if (typeof key !== "string") return null;
  const colon = key.indexOf(":");
  if (colon <= 0) return null;
  const length = Number(key.slice(0, colon));
  if (!Number.isSafeInteger(length) || length <= 0) return null;
  const start = colon + 1;
  const kind = key.slice(start, start + length);
  if (kind.length !== length) return null;
  return { kind, id: key.slice(start + length) };
}

/**
 * The tool call one `tool/result` event answers, read tolerantly.
 * @param event - a tool result event.
 * @returns the call id, or "" when the event carries none.
 */
function toolCallIdOf(event) {
  const message = event?.data?.message;
  if (typeof message?.toolCallId === "string" && message.toolCallId !== "")
    return message.toolCallId;
  if (typeof message?.source?.callId === "string" && message.source.callId !== "")
    return message.source.callId;
  const fallback = event?.data?.toolCallId;
  return typeof fallback === "string" ? fallback : "";
}

/**
 * The current surface nodes one Chat row stands for.
 *
 * The mapping is the mirror of the chat's own Definition matchers: the same
 * business id, derived from the same event fields. Rows whose events are
 * log-only — command receipts, retry rows, turn errors — stand for no surface
 * node at all and answer null, which is what keeps the right-click menu off
 * them: there is nothing in the model's context to remove.
 * @param session - the session the row was rendered from.
 * @param nodeKey - the row's `data-chat-node-key`.
 * @returns the surface seqs, or null when the row maps to none.
 */
export function resolveChatNodeSeqs(session, nodeKey) {
  const parsed = parseChatNodeKey(nodeKey);
  if (parsed === null) return null;
  const { kind, id } = parsed;
  const nodes = session.surface.nodes;
  const found = [];
  for (const seq of nodes) {
    const event = session.eventAt(seq);
    let matched = false;
    switch (kind) {
      // User, steering, injected-context and turn-trigger rows all come from
      // the one input-message Definition, keyed by the message id.
      case "input-message":
        matched = event?.type === "user/message" && String(event.data?.id) === id;
        break;
      case "developer-message":
        matched =
          event?.type === "developer/message" &&
          String(event.data?.message?.id) === id;
        break;
      // One assistant step can settle several messages (retries); the row is
      // keyed by `turn:step` and stands for all of them.
      case "assistant-step":
        matched =
          event?.type === "assistant/message" &&
          `${String(event.data?.turn)}:${String(event.data?.step)}` === id;
        break;
      // A tool row spans the call block inside its assistant message and the
      // result that answers it; both cite the same call id.
      case "tool-call":
        matched =
          (event?.type === "tool/result" && toolCallIdOf(event) === id) ||
          (event?.type === "assistant/message" &&
            Array.isArray(event.data?.message?.content) &&
            event.data.message.content.some(
              (block) => block?.type === "tool-call" && String(block.id) === id,
            ));
        break;
      // The unknown-surface fallback keys its row by the literal seq.
      case "unknown-surface":
        matched = Number(id) === seq;
        break;
      // A compaction card is keyed by its compaction id, and the checkpoint it
      // discloses is the transaction's only surface node.
      case "compaction":
        matched =
          event?.type === "user/message" &&
          event.data?.source?.kind === COMPACT_KIND &&
          String(event.data.source.compactionId) === id;
        break;
      // The merged "manual compaction" card folds a checkpoint into its
      // command row and is keyed by the command id the checkpoint cites.
      case "command":
        matched =
          event?.type === "user/message" &&
          event.data?.source?.kind === COMPACT_KIND &&
          event.data.source.sourceCommandId !== undefined &&
          String(event.data.source.sourceCommandId) === id;
        break;
      default:
        return null;
    }
    if (matched) found.push(seq);
  }
  return found.length === 0 ? null : found;
}

/**
 * Grow a set of surface nodes to the smallest contiguous run that splits no
 * tool-call/result pair.
 *
 * Deleting a run is only sound when what remains is sound: a run ending on an
 * unanswered call would leave the replayed request holding a call with no
 * result, and one starting inside a pair would orphan the answer. Both edges
 * therefore walk to their nearest balanced cut — which is also what makes one
 * tool row delete its whole assistant message, since a message that calls
 * tools cannot survive their results. Node 0 is never swallowed: a system
 * prompt pairs nothing, so the walk-back stops before it.
 * @param session - the session whose surface is measured.
 * @param seqs - the targeted surface nodes.
 * @returns the run, or null when no balanced run contains the targets.
 */
export function expandDeleteRun(session, seqs) {
  const nodes = session.surface.nodes;
  const positions = [];
  for (const seq of seqs) {
    const index = nodes.indexOf(seq);
    if (index === -1) return null;
    positions.push(index);
  }
  if (positions.length === 0) return null;
  const firstIdx = session.eventAt(nodes[0])?.type === "system/message" ? 1 : 0;
  const cuts = pairingCuts(session, nodes);
  let startIdx = Math.min(...positions);
  let endIdx = Math.max(...positions);
  while (endIdx < nodes.length - 1 && cuts.get(nodes[endIdx]) !== true)
    endIdx += 1;
  if (cuts.get(nodes[endIdx]) !== true) return null;
  while (startIdx > firstIdx && cuts.get(nodes[startIdx - 1]) !== true)
    startIdx -= 1;
  if (startIdx < firstIdx) startIdx = firstIdx;
  return {
    start: nodes[startIdx],
    end: nodes[endIdx],
    shadowedSeqs: nodes.slice(startIdx, endIdx + 1),
  };
}

/**
 * The empty `system/message` a delete replaces its run with.
 *
 * The platform projects an empty system node to no wire message — the same
 * mechanism its own prompt clearing uses — and the chat renders a replacement
 * event no visible row, so this one shape removes the run from the model's
 * context and from the view at once. The message identity is fresh and the
 * source is the required `system-prompt` producer. The turn and step are the
 * ones the
 * tombstone lands in: a stored `system/message` must match an open turn and
 * step at its own position in the log, so only the open step's coordinates
 * pass the format check on the next load.
 * @param coords - the open turn and step the tombstone is written into.
 * @returns the tombstone event data.
 */
function tombstoneFor(coords) {
  return {
    turn: coords.turn,
    step: coords.step,
    message: tombstoneMessage(),
  };
}

/**
 * The message body {@link tombstoneFor} wraps: empty content under the
 * `system-prompt` producer, recognised as a delete by its `origin`.
 * @returns a fresh tombstone message.
 */
function tombstoneMessage() {
  return {
    id: randomUUID(),
    role: "system",
    content: [],
    source: { kind: "system-prompt", origin: DELETE_ORIGIN },
  };
}

/**
 * Deletes waiting for a step to open, by session id, oldest first.
 *
 * A `system/message` is step-scoped in the stored format and the platform mints
 * turn and step numbers itself, so a delete made while no step is open cannot
 * be recorded immediately — a tombstone naming any other coordinates fails the
 * format check on the next load. The run is remembered here instead and lands
 * at the next `step/start`, before that step builds its request; until then the
 * rows stay hidden by the keys the delete answered with. The queue is
 * process-local: a delete made while idle and never followed by another turn
 * reverts on restart.
 * @type {Map<string, Array<{start: number, end: number, shadowedSeqs: number[]}>>}
 */
const pendingDeletes = new Map();

/**
 * The delete runs queued for one session.
 * @param session - the session to read.
 * @returns the queued runs, oldest first.
 */
export function pendingDeleteRunsFor(session) {
  return pendingDeletes.get(session.id) ?? [];
}

/**
 * Whether a queued run still names an exact current surface span.
 *
 * A later replacement — a checkpoint, or an earlier queued run that has since
 * landed — can take some of the run off the surface; its tombstone would then
 * name seqs the surface fold can no longer find and the stored log would
 * refuse to load. Such a run is already gone from the context, so it is
 * dropped instead.
 * @param nodes - the current surface nodes.
 * @param run - one queued run.
 * @returns whether the run can still be replaced.
 */
function runStillExact(nodes, run) {
  const at = nodes.indexOf(run.start);
  return (
    at >= 0 &&
    nodes[at + run.shadowedSeqs.length - 1] === run.end &&
    run.shadowedSeqs.every((seq, index) => nodes[at + index] === seq)
  );
}

/**
 * Write one delete's tombstone into the open step it must name.
 * @param session - the session being rewritten.
 * @param coords - the open turn and step.
 * @param run - the surface span being replaced.
 */
function appendDeleteTombstone(session, coords, run) {
  session.append("system/message", tombstoneFor(coords), {
    surfaceOp: { op: "replace", startSeq: run.start, endSeq: run.end },
    sourceEventSeqs: [...run.shadowedSeqs],
  });
}

/**
 * Land every queued delete tombstone while a step is open.
 *
 * Called from the plugin's `session/event` listener the moment the engine
 * appends a `step/start`, and before any delete recorded mid-step. A run whose
 * rows a later replacement already removed is dropped; a tombstone that fails
 * to append stays queued for a later step.
 * @param ctx - the Host context, for the post-land flush.
 * @param session - the session to drain.
 * @returns whether any tombstone landed.
 */
export function flushPendingTombstones(ctx, session) {
  const runs = pendingDeletes.get(session.id);
  if (runs === undefined || runs.length === 0) return false;
  const { openStep } = inspectEntryState(session);
  if (openStep === null) return false;
  const remaining = [];
  let landedAny = false;
  for (const run of runs) {
    if (!runStillExact(session.surface.nodes, run)) continue;
    try {
      appendDeleteTombstone(session, openStep, run);
      landedAny = true;
    } catch {
      remaining.push(run);
    }
  }
  if (remaining.length === 0) pendingDeletes.delete(session.id);
  else pendingDeletes.set(session.id, remaining);
  if (landedAny) {
    const sessions = ctx?.get?.("sessions");
    if (typeof sessions?.flush === "function")
      Promise.resolve(sessions.flush(session)).catch(() => {});
  }
  return landedAny;
}

/**
 * The `data-chat-node-key` value the chat gives one row.
 *
 * The conversation engine keys every node `${kind.length}:${kind}${id}` — the
 * same spelling {@link parseChatNodeKey} reads back. The client hides deleted
 * rows by this attribute, so every producer of a hide key goes through here.
 * @param kind - the node Definition kind.
 * @param id - the Definition-owned business id.
 * @returns the row key.
 */
function chatNodeKey(kind, id) {
  return `${kind.length}:${kind}${id}`;
}

/**
 * The Chat row keys one event is rendered under.
 *
 * Mirrors the chat's own Definition ids: input messages key by message id,
 * assistant steps by `turn:step`, tool rows by call id, compaction cards by
 * compaction (and folded command) id, unclaimed append-surface rows by their
 * literal seq. A row whose event renders nothing — a replacement checkpoint of
 * any other origin, a system prompt — contributes no key.
 * @param event - one log event.
 * @returns the row keys this event can hide under; empty when it renders none.
 */
function rowKeysForEvent(event) {
  if (event === undefined || event === null) return [];
  const keys = [];
  switch (event.type) {
    case "user/message": {
      if (event.surfaceOp === "append") {
        const id = event.data?.id;
        if (id !== undefined && String(id) !== "") keys.push(chatNodeKey("input-message", String(id)));
      }
      // A shadowed compaction checkpoint owns its marker card (and, when a
      // command asked for the compaction, the folded command card).
      const source = event.data?.source;
      if (source?.kind === COMPACT_KIND) {
        if (source.compactionId !== undefined)
          keys.push(chatNodeKey("compaction", String(source.compactionId)));
        if (source.sourceCommandId !== undefined)
          keys.push(chatNodeKey("command", String(source.sourceCommandId)));
      }
      break;
    }
    case "developer/message": {
      const id = event.data?.message?.id;
      if (id !== undefined && String(id) !== "")
        keys.push(chatNodeKey("developer-message", String(id)));
      break;
    }
    case "assistant/message": {
      keys.push(chatNodeKey("assistant-step", `${String(event.data?.turn)}:${String(event.data?.step)}`));
      const content = Array.isArray(event.data?.message?.content)
        ? event.data.message.content
        : [];
      for (const block of content) {
        if (block?.type === "tool-call" && block.id !== undefined)
          keys.push(chatNodeKey("tool-call", String(block.id)));
      }
      break;
    }
    case "tool/result": {
      const callId = toolCallIdOf(event);
      if (callId !== "") keys.push(chatNodeKey("tool-call", callId));
      break;
    }
    case "system/message": {
      // The system-prompt card's own key. Most such rows render hidden, but a
      // prompt card with introduced text is visible and hides with its node.
      keys.push(chatNodeKey("system-message", String(event.seq)));
      break;
    }
    default: {
      // Unclaimed append-surface rows are keyed by their literal seq; other
      // event kinds render no row of their own and need no key.
      if (event.surfaceOp === "append")
        keys.push(chatNodeKey("unknown-surface", String(event.seq)));
      break;
    }
  }
  return keys;
}

/**
 * The Chat row keys one delete hides from the transcript.
 *
 * The transcript keeps every replaced row — a compaction marker reports where
 * the model stopped seeing history, it does not remove it — so a delete hides
 * its rows on the view side. The keys cover the shadowed events themselves and
 * the log-only siblings their rows are built from: a deleted step takes the
 * retry receipts of the same `turn:step` with it, because those render their
 * own rows and no surface event names them.
 * @param events - the session's committed events, in log order.
 * @param shadowedSeqs - the run the tombstone replaced.
 * @returns the deduplicated row keys to hide.
 */
function hiddenKeysForRun(events, shadowedSeqs) {
  const keys = new Set();
  const bySeq = new Map();
  for (const event of events) {
    if (Number.isSafeInteger(event?.seq)) bySeq.set(event.seq, event);
  }
  const steps = new Set();
  for (const seq of shadowedSeqs) {
    for (const key of rowKeysForEvent(bySeq.get(seq))) keys.add(key);
    const event = bySeq.get(seq);
    if (event?.type === "assistant/message")
      steps.add(`${String(event.data?.turn)}:${String(event.data?.step)}`);
  }
  if (steps.size > 0) {
    for (const event of events) {
      if (event?.type !== "llm/retry") continue;
      const step = `${String(event.data?.turn)}:${String(event.data?.step)}`;
      if (!steps.has(step)) continue;
      const retryId = event.data?.retryId;
      if (retryId !== undefined && String(retryId) !== "")
        keys.add(chatNodeKey("model-retry", String(retryId)));
    }
  }
  return [...keys];
}

/**
 * Whether one event renders a content row (a message or a marker card).
 * @param event - one log event.
 * @returns true for the surface events that produce visible message rows.
 */
function isContentRowEvent(event) {
  return (
    event?.type === "user/message" ||
    event?.type === "developer/message" ||
    event?.type === "assistant/message" ||
    event?.type === "tool/result"
  );
}

/**
 * Every Chat row key this session's deletes hide.
 *
 * Tombstones are found by their `source.origin`: a delete's tombstone is the
 * only empty `system/message` replacement this module writes, and compaction
 * checkpoints deliberately hide nothing — the platform's own transcript keeps
 * replaced rows visible by design.
 *
 * Beyond the deleted rows themselves, a turn whose every content row is gone
 * takes its furniture with it: the turn tail (usage and actions) and the
 * process control would otherwise outlive the conversation they describe. A
 * turn is located by the `turn/start`..`turn/end` span its events fall in,
 * because user messages carry no turn of their own.
 * @param events - the session's committed events, in log order.
 * @param pendingRuns - shadowed seqs of queued deletes whose tombstones have
 *   not landed yet.
 * @returns the deduplicated row keys to hide.
 */
export function hiddenRowKeys(events, pendingRuns = []) {
  const keys = new Set();
  const deleted = new Set();
  for (const event of events) {
    if (event?.type !== "system/message") continue;
    if (event.data?.message?.source?.origin !== DELETE_ORIGIN) continue;
    const shadowed = Array.isArray(event.sourceEventSeqs)
      ? event.sourceEventSeqs
      : [];
    for (const seq of shadowed) deleted.add(seq);
    for (const key of hiddenKeysForRun(events, shadowed)) keys.add(key);
  }
  // A queued delete hides its rows before its tombstone exists: the answer the
  // delete returned must match what a reload derives once the tombstone lands.
  for (const shadowed of pendingRuns) {
    for (const seq of shadowed) deleted.add(seq);
    for (const key of hiddenKeysForRun(events, shadowed)) keys.add(key);
  }
  const turns = new Map();
  let openTurn = null;
  for (const event of events) {
    if (event?.type === "turn/start") {
      openTurn = Number.isSafeInteger(event.data?.turn)
        ? event.data.turn
        : null;
      continue;
    }
    if (event?.type === "turn/end") {
      openTurn = null;
      continue;
    }
    if (!isContentRowEvent(event)) continue;
    const turn = Number.isSafeInteger(event.data?.turn)
      ? event.data.turn
      : openTurn;
    if (!Number.isSafeInteger(turn)) continue;
    const count = turns.get(turn) ?? { total: 0, visible: 0 };
    count.total += 1;
    if (!deleted.has(event.seq)) count.visible += 1;
    turns.set(turn, count);
  }
  for (const [turn, count] of turns) {
    if (count.visible > 0) continue;
    for (const kind of [
      "turn-tail",
      "turn-process",
      "turn-error",
      "turn-max-tokens",
    ])
      keys.add(chatNodeKey(kind, String(turn)));
  }
  return [...keys];
}

/**
 * {@link hiddenRowKeys} over one live session's in-memory log.
 * @param session - the session to read.
 * @returns the deduplicated row keys to hide.
 */
export function hiddenRowKeysForSession(session) {
  const events = [];
  for (let seq = 0; seq < session.seq; seq += 1)
    events.push(session.eventAt(seq));
  return hiddenRowKeys(
    events,
    pendingDeleteRunsFor(session).map((run) => run.shadowedSeqs),
  );
}

/**
 * Open the compaction lock and keep what closing it again needs.
 *
 * Written before the summarizer is asked for anything, so the durable marker
 * is the lock while the model runs: a second request is then refused with
 * "already in flight" instead of summarizing the same history twice, and the
 * platform's own engine backs off instead of racing this one. `turn` names the
 * turn that was open when the compaction started, because a compaction begun
 * mid-turn belongs to that turn; it is null when the session was idle.
 * @param session - the session being compacted.
 * @param turn - the open turn at the time of the call, or null.
 * @param sourceCommandId - the command that asked, when one did. Carried on
 *   every lifecycle event, it is what lets the chat fold the whole
 *   transaction — start, summary, checkpoint, end and the command card — into
 *   the one "manual compaction" view the platform's own /compact renders.
 * @returns the id, the lifecycle both closing events share, and the opener.
 */
function openCompaction(session, turn, sourceCommandId) {
  const compactionId = randomUUID();
  const lifecycle = {
    compactionId,
    turn: turn ?? null,
    ...(sourceCommandId === undefined ? {} : { sourceCommandId }),
  };
  return {
    compactionId,
    lifecycle,
    closed: false,
    start: session.append("compaction/start", lifecycle),
  };
}

/**
 * Release an opened compaction lock after a failure.
 *
 * Two callers can reach a failure — the summarizer and the rewrite — and only
 * one of them should close the pair. `closed` makes that safe instead of
 * requiring each caller to know how far the other got: a start left unmatched
 * would block every later compaction on the session, a second end would be a
 * stray event. It deliberately swallows its own error; the failure that got
 * here is the one worth reporting.
 * @param session - the session holding the lock.
 * @param opened - the result of {@link openCompaction}.
 * @param error - what went wrong.
 */
function closeCompaction(session, opened, error) {
  if (opened.closed) return;
  opened.closed = true;
  try {
    session.append("compaction/end", {
      ...opened.lifecycle,
      error: error instanceof Error ? error.message : String(error),
    });
  } catch {
    /* the original error is the one worth reporting */
  }
}

/**
 * Format the quantified line the disclosure shows above the summary.
 * @param stats - the measured counts.
 * @returns a compact, language-neutral statistics line.
 */
function statsLine(stats) {
  const group = (value) => value.toLocaleString("en-US");
  return [
    `${group(stats.beforeTokens)} → ${group(stats.afterTokens)} tokens`,
    `${group(stats.chars)} chars`,
    `${group(stats.items)} items`,
  ].join(" · ");
}

/**
 * Whether a checkpoint is a placeholder `clear` wrote rather than a summary
 * `compact` wrote.
 *
 * Two ways to know, because the field is younger than the plugin: checkpoints
 * written since it was added carry `source.origin`, and older ones are
 * recognized by their placeholder text. Both are needed for a session cleared
 * before the update — without the second check, clearing it again would try to
 * rewrite one placeholder with an identical one and fail the size test.
 * @param data - the checkpoint's `data`.
 * @returns true when the checkpoint holds no history worth clearing.
 */
function isClearCheckpoint(data) {
  if (data?.source?.origin === CLEAR_ORIGIN) return true;
  const parts = Array.isArray(data?.content) ? data.content : [];
  return parts.some(
    (part) => part?.type === "text" && part.text === CLEAR_PLACEHOLDER,
  );
}

/**
 * Require a previously selected span to still be the same replacement target.
 *
 * The conversation keeps running while the summarizer works, so the surface
 * has moved on. What must not have moved is the span itself: the same nodes,
 * in the same order, still contiguous. Nodes appended after it are the point
 * of the feature, not a reason to fail.
 * @param session - the session whose surface is checked.
 * @param span - the selected span.
 * @param t - translator for the refusal.
 */
function assertSpanStable(session, span, t) {
  const nodes = session.surface.nodes;
  const startIdx = nodes.indexOf(span.start);
  const endIdx = nodes.indexOf(span.end);
  const guarded =
    startIdx !== -1 &&
    endIdx !== -1 &&
    startIdx <= endIdx &&
    endIdx - startIdx + 1 === span.shadowedSeqs.length &&
    span.shadowedSeqs.every((seq, offset) => nodes[startIdx + offset] === seq);
  if (!guarded) throw new Error(t("error.changed"));
}

/**
 * Replace a span of a session's surface with one replacement node.
 *
 * Three callers, three spans. Clearing names no span and takes the whole
 * surface, which is only safe on an idle session. Compacting passes the span it
 * selected before summarizing, and everything the conversation wrote in the
 * meantime stays on the surface after the checkpoint — that is what makes it
 * possible to compact without stopping the conversation. Deleting passes the
 * smallest balanced run its rows cover and replaces that run with an empty
 * `system/message` tombstone instead of a checkpoint.
 *
 * @param ctx - the Host context.
 * @param agent - the agent owning the session.
 * @param input - `origin`, the summary blocks when checkpointing, their
 *   provenance, and the optional span.
 * @returns the applied counts, or null when there was nothing to replace.
 */
async function replaceSurface(ctx, agent, input) {
  const t = translatorFor(ctx);
  const session = agent.session;
  // Set as soon as a pair exists that has not landed yet. Every failure below
  // releases it: a start left unmatched would block every later compaction on
  // the session, and the caller that opened it cannot know how far this got.
  let active = input.opened;
  let landed = false;
  try {
    const nodes = session.surface.nodes;
    if (nodes.length === 0) return null;
    const firstIdx =
      session.eventAt(nodes[0])?.type === "system/message" ? 1 : 0;
    if (firstIdx >= nodes.length) return null;

    const state = inspectEntryState(session);
    // The caller may already hold the lock — compacting opens it before the
    // model call — and that opener is the `unmatched` start this would find.
    // Only a *different* unmatched start means someone else is compacting.
    const foreign =
      state.unmatched !== undefined &&
      state.unmatched.seq !== input.opened?.start.seq;
    if (
      foreign &&
      !(
        state.latestEndSeed !== undefined &&
        state.latestEndSeed > state.unmatched.seq
      )
    )
      throw new Error(t("error.inFlight"));

    // Only clearing insists on an idle session. Compacting a span that ends at
    // a completed step is safe mid-turn: the span sits behind the running step
    // and the replacement leaves everything after it untouched.
    const span = input.span ?? {
      start: nodes[firstIdx],
      end: nodes[nodes.length - 1],
      shadowedSeqs: nodes.slice(firstIdx),
    };
    if (input.span === undefined && state.openTurn !== null)
      throw new Error(t("error.busy"));
    // A span selected before the summarizer ran is rechecked here, because the
    // conversation kept going in the meantime.
    if (input.span !== undefined) assertSpanStable(session, span, t);

    const { start, end, shadowedSeqs } = span;

    // Already cleared: rewriting one placeholder with another identical one
    // would only trip the "must be smaller" check below, and nothing to do is a
    // success rather than an error. A checkpoint left by `compact` is *not*
    // this case — it holds a summary, and clearing it after compacting is a
    // real request that must go through. A delete goes through too: the
    // tombstone applies no size test, so removing the placeholder itself is a
    // legitimate request with no failure mode to guard against.
    if (input.origin !== DELETE_ORIGIN && shadowedSeqs.length === 1) {
      const only = session.eventAt(shadowedSeqs[0]);
      if (
        only?.type === "user/message" &&
        only.data?.source?.kind === COMPACT_KIND &&
        isClearCheckpoint(only.data)
      )
        return null;
    }

    const measurement = ctx.tokenMeter.measure(session);
    const priced = new Map(measurement.nodes.map((node) => [node.seq, node]));
    let beforeTokens = 0;
    let routeTokens = 0;
    let aligned = true;
    for (const seq of shadowedSeqs) {
      const node = priced.get(seq);
      if (node === undefined) {
        aligned = false;
        continue;
      }
      beforeTokens += node.heuristicTokens;
      routeTokens += node.tokens;
    }

    // A delete replaces its run with an empty `system/message`, not with a
    // checkpoint: the platform projects an empty system node to no wire
    // message, and the chat renders a replacement event no visible row, so the
    // run leaves the model's context and the view at once. It opens no
    // compaction lock — there is no summarizer in flight to protect — and
    // writes no ledger row: there is no summarizer spend to recoup, and
    // counting a deletion as a compaction would poison the ROI the panorama
    // page reports. The size test is skipped for the same reason clearing
    // skips it: an empty node legitimately measures larger than nothing.
    //
    // The tombstone is step-scoped in the stored format and the platform mints
    // turn and step numbers itself, so it can only land inside an open step.
    // Mid-step deletes are recorded immediately with that step's coordinates;
    // while no step is open the run waits in `pendingDeletes` and lands at the
    // next `step/start` — before that step builds its request, so the model
    // never sees the run. The view hides the rows at once either way, from the
    // keys answered here (which include pending runs) and re-derived after any
    // reload.
    if (input.origin === DELETE_ORIGIN) {
      const afterTokens = ctx.tokenMeter.estimateMessage(tombstoneMessage());
      // Older waits land first: two queued runs can touch the same rows, and
      // the fold must see them in the order they were deleted.
      flushPendingTombstones(ctx, session);
      const run = { start, end, shadowedSeqs: [...shadowedSeqs] };
      let queuedRunIds = [];
      let undoGroup;
      if (state.openStep !== null) {
        appendDeleteTombstone(session, state.openStep, run);
      } else {
        // A queued run is still undoable: no event has been written yet, so
        // dropping the entry restores the rows exactly. `id` names the entry
        // for an exact undo and `group` ties the entries of one menu action
        // (a batch delete queues several runs) into one undo step.
        const entry = {
          ...run,
          id: randomUUID(),
          group: input.undoGroup ?? randomUUID(),
        };
        undoGroup = entry.group;
        queuedRunIds = [entry.id];
        pendingDeletes.set(session.id, [
          ...pendingDeleteRunsFor(session),
          entry,
        ]);
      }
      landed = true;
      // Same flush the checkpoint path performs: without it an open view keeps
      // the surface it had and never re-reads the tombstone.
      const sessions = ctx.get?.("sessions");
      if (typeof sessions?.flush === "function") await sessions.flush(session);
      return {
        items: shadowedSeqs.length,
        beforeTokens,
        afterTokens,
        chars: 0,
        queuedRunIds,
        ...(undoGroup === undefined ? {} : { undoGroup }),
        stats: statsLine({
          beforeTokens,
          afterTokens,
          chars: 0,
          items: shadowedSeqs.length,
        }),
      };
    }

    // The lock exists before the id is minted, and it is the only source of
    // that id. A caller that already opened it (compactContext, before the
    // summarizer ran) hands its opener over; a caller that did not
    // (clearContext) opens it here. Minting first and opening afterwards
    // produced two ids: summary and checkpoint carried one, start and end
    // carried the other, and the stored log then refused to load.
    active =
      active ?? openCompaction(session, state.openTurn, input.sourceCommandId);
    const compactionId = active.compactionId;
    // `sourceCommandId` only travels when a command asked for the compaction.
    // The chat UI folds a checkpoint that names its command into that command's
    // Definition, and renders the merged "manual compaction" card — marker,
    // counts and expandable summary in one row — when the command is literally
    // named "compact". A checkpoint without a command lands in the automatic
    // compaction Definition instead, which renders the marker on its own.
    const source = {
      kind: COMPACT_KIND,
      compactionId,
      ...(input.sourceCommandId === undefined
        ? {}
        : { sourceCommandId: input.sourceCommandId }),
    };
    // Round-trips through the log, so only the two values this module writes
    // are accepted; an older checkpoint written before this field existed has
    // no `origin` and is therefore treated as a compaction, which is right for
    // every log this plugin ever produced.
    if (input.origin === CLEAR_ORIGIN) source.origin = CLEAR_ORIGIN;
    const checkpoint = {
      id: randomUUID(),
      role: "user",
      content: [
        { type: "text", text: `${CHECKPOINT_PREAMBLE}\n\n${SUMMARY_OPEN_TAG}` },
        ...input.summary,
        { type: "text", text: SUMMARY_CLOSE_TAG },
      ],
      source,
    };
    const afterTokens = ctx.tokenMeter.estimateMessage(checkpoint);
    // A compaction must leave the session smaller — that is its whole purpose,
    // and the platform refuses a checkpoint that is not. Clearing is a
    // different promise: it discards the history and leaves one line saying so,
    // and that line can legitimately measure larger than a checkpoint that is
    // already a short summary. Refusing the clear there would leave the user
    // unable to throw away a summary they no longer want, so the size test
    // applies to compact only. A misaligned measurement still cannot prove
    // anything and is skipped either way.
    const shrinking = input.origin !== CLEAR_ORIGIN;
    if (shrinking && aligned && afterTokens >= routeTokens)
      throw new Error(
        t("error.notSmaller", {
          after: afterTokens,
          before: routeTokens,
        }),
      );
    const summaryEvent = session.append("compaction/summary", {
      compactionId,
      summary: input.summary,
      shadowedRange: { start, end },
      shadowedSeqs: [...shadowedSeqs],
      shadowedTokenCount: beforeTokens,
      ...(input.sourceCommandId === undefined
        ? {}
        : { sourceCommandId: input.sourceCommandId }),
      ...(input.provider === undefined ? {} : { provider: input.provider }),
      ...(input.model === undefined ? {} : { model: input.model }),
    });
    session.append("user/message", checkpoint, {
      surfaceOp: { op: "replace", startSeq: start, endSeq: end },
      sourceEventSeqs: [active.start.seq, summaryEvent.seq, ...shadowedSeqs],
    });
    // `landed` flips only once the pair is really closed: an `end` that failed
    // to append must still be retried by the catch below, or the lock would
    // outlive the failure and block every later compaction.
    session.append("compaction/end", active.lifecycle);
    landed = true;
    active.closed = true;
    // The platform's own manual compaction flushes after the pair closes, and
    // without it the client keeps the surface it had: the events are on disk
    // but nothing tells the open view to re-read them.
    const sessions = ctx.get?.("sessions");
    if (typeof sessions?.flush === "function") await sessions.flush(session);

    const chars = input.summary.reduce(
      (total, block) =>
        total + (typeof block.text === "string" ? block.text.length : 0),
      0,
    );
    // The savings line of the ledger: what the rewrite removed is what the
    // summarizer's own spend will be compared against on the panorama page.
    void appendLedger(ctx, {
      kind: "surface",
      op: input.origin === CLEAR_ORIGIN ? "clear" : "compact",
      sessionId: agent.session.id,
      items: shadowedSeqs.length,
      beforeTokens,
      afterTokens,
    });
    return {
      items: shadowedSeqs.length,
      beforeTokens,
      afterTokens,
      chars,
      stats: statsLine({
        beforeTokens,
        afterTokens,
        chars,
        items: shadowedSeqs.length,
      }),
    };
  } catch (error) {
    if (!landed && active !== undefined)
      closeCompaction(session, active, error);
    throw error;
  }
}

/**
 * Replace a session's whole surface with a minimal placeholder.
 *
 * The placeholder is deliberately tiny: the "not smaller" check would reject
 * a clear on a session whose history is already shorter than the framing.
 * @param ctx - the Host context.
 * @param agent - the agent owning the session.
 * @param input - provenance for the checkpoint.
 * @returns the applied counts, or null when there was nothing to clear.
 */
export async function clearContext(ctx, agent, input = {}) {
  return withSessionLock(ctx, agent, () =>
    whileIdle(
      agent,
      async () =>
        replaceSurface(ctx, agent, {
          ...input,
          origin: CLEAR_ORIGIN,
          summary: [{ type: "text", text: CLEAR_PLACEHOLDER }],
        }),
      translatorFor(ctx),
    ),
  );
}

/**
 * Share of the summarizer's context window the inherited history may fill.
 *
 * Not the whole window: the instruction, the tool schemas and the model's own
 * answer share the same budget, so a history that exactly fills it leaves no
 * room to write a summary about it.
 */
const SUMMARY_SHARE = 2 / 3;

/** Characters per token, the density the platform's own meter estimates at. */
const CHARS_PER_TOKEN = 4;

/** Per-block structural overhead: the same figure the platform's meter adds. */
const BLOCK_OVERHEAD = 4;

/** Share of the excerpt budget reserved for the oldest messages. */
const HEAD_SHARE = 0.4;

/** Smallest rendered request worth sending; below this the summary is not a summary. */
const MIN_EXCERPT_BYTES = 4_000;

/**
 * Hard ceiling on one rendered summarizer request's UTF-8 core text (bytes).
 *
 * The model's declared context window bounds what the model accepts; it is not
 * a size a single request should aim for. The same body also carries the
 * instruction, the prompt, and the room the answer needs, and a window
 * describing a million tokens is routinely one whose adapter or gateway still
 * refuses a multi-megabyte payload outright. Sizing a segment from
 * `contextWindow * SUMMARY_SHARE` alone, measured in UTF-16 code units,
 * produced a single ~2.8 MB message that failed before any model saw it.
 *
 * 600,000 UTF-8 bytes is ~150,000 tokens at this module's own
 * 4-bytes-per-token estimate: inside a 200,000-token window with the
 * instruction and prompt added, and still inside a denser tokenizer's count. It
 * is a ceiling on what may be *sent*, never a target —
 * {@link renderBudgetBytes} only reaches it when the model's own figure is
 * larger.
 */
export const MAX_SEGMENT_BYTES = 600_000;

/**
 * Ceiling on the output budget one summarizer attempt may ask for.
 *
 * A summary that hits `max-tokens` is retried with more room, and this is where
 * that climb stops. 64,000 tokens is what the platform itself reserves for
 * output when it sizes a compaction window, so asking for more than this would
 * be asking for a reply the platform already assumes no model produces.
 */
export const MAX_OUTPUT_TOKENS = 64_000;

/**
 * How many times one summarizer call is attempted before giving up.
 *
 * The first attempt asks for exactly what the session already sends, so a
 * configuration that works today keeps its behaviour. Each retry doubles the
 * output budget, which is the one figure that fixes a truncated summary without
 * touching the history, the prompt or the model. Three attempts is the point
 * where the ladder has reached {@link MAX_OUTPUT_TOKENS} from any realistic
 * starting figure and a further retry would only re-bill the same failure.
 */
export const OUTPUT_RETRY_ATTEMPTS = 3;

/** UTF-8 byte length of a string (the unit every layer below measures a body in). */
function utf8Bytes(text) {
  return Buffer.byteLength(text, "utf8");
}

/**
 * Byte ceiling for one rendered summarizer request, in UTF-8 bytes.
 *
 * Honours a small declared model window when there is one, but never lets the
 * model's optimistic size push a single request past the module's ceiling.
 * @param limitTokens - the summarizer's history budget in tokens, or null.
 * @returns the largest core-text byte count one request may carry.
 */
export function renderBudgetBytes(limitTokens) {
  const modelBytes =
    limitTokens === null ||
    limitTokens === undefined ||
    !Number.isFinite(limitTokens)
      ? MAX_SEGMENT_BYTES
      : Math.floor(limitTokens * CHARS_PER_TOKEN);
  return Math.max(MIN_EXCERPT_BYTES, Math.min(modelBytes, MAX_SEGMENT_BYTES));
}

/**
 * Split one record that is itself larger than a whole request at code-point
 * boundaries, so no segment ever cuts through a multi-byte UTF-8 sequence or a
 * surrogate pair.
 * @param text - the record text.
 * @param budgetBytes - the largest UTF-8 size of one slice.
 * @returns the slices, in order.
 */
function splitTextByBytes(text, budgetBytes) {
  const slices = [];
  let sliceStart = 0;
  let sliceBytes = 0;
  let cursor = 0;
  for (const char of text) {
    const bytes = utf8Bytes(char);
    if (sliceBytes + bytes > budgetBytes && cursor > sliceStart) {
      slices.push(text.slice(sliceStart, cursor));
      sliceStart = cursor;
      sliceBytes = 0;
    }
    sliceBytes += bytes;
    cursor += char.length;
  }
  if (cursor > sliceStart) slices.push(text.slice(sliceStart, cursor));
  return slices;
}

/**
 * Token budget for the context excerpt the optimizer may attach when the
 * include-context toggle is on and the route does not publish a window.
 */
const OPTIMIZER_CONTEXT_TOKENS = 32_000;

/**
 * Render one message as the plain text a summarizer reads.
 *
 * Reasoning is dropped on purpose: it is the largest and least useful part of
 * a long history, and a summary that spends its budget on what the model was
 * thinking about re-reads worse than one built from what was actually said.
 * @param message - the message derived from a surface event.
 * @returns its textual form; empty when nothing worth reading remains.
 */
function renderMessage(message) {
  const content = Array.isArray(message?.content) ? message.content : [];
  const parts = [];
  for (const block of content) {
    if (block?.type === "text" && typeof block.text === "string")
      parts.push(block.text);
    else if (block?.type === "tool-call")
      parts.push(`[call ${typeof block.name === "string" ? block.name : ""}]`);
    else if (block?.type === "image") parts.push("[image]");
  }
  return parts.join("\n").trim();
}
/**
 * Price the tool schemas on the last request envelope.
 *
 * A local copy of the platform's estimator, and deliberately so: the `tokenMeter`
 * service exposes only `measure`, `estimateMessage` and the fold internals —
 * `estimateToolsTokens` stays a module-private function there and is never
 * re-exported, so it cannot be reached from a plugin at all. An earlier version
 * of this function called `meter.estimateToolsTokens(...)` behind a `typeof`
 * guard; the guard was always false, the second of the three parts priced at
 * zero, and the total came out low with no error to show for it. Keeping the
 * formula here, identical to the platform's, is what makes that part real.
 * @param header - the canonical request envelope, or undefined before any request.
 * @returns heuristic tool-schema tokens; 0 when the envelope declares none.
 */
function estimateToolsTokens(header) {
  const tools = header?.tools;
  if (!Array.isArray(tools) || tools.length === 0) return 0;
  return (
    Math.ceil(JSON.stringify(tools).length / CHARS_PER_TOKEN) + BLOCK_OVERHEAD
  );
}

/**
 * The real size of the request this session would send next.
 *
 * Three parts, added the way a model's window is really spent: the current
 * system prompt, the tool schemas on the last request envelope, and every
 * message on the surface. This is deliberately not
 * `tokenMeter.measure().totalTokens`. That figure anchors on the provider's
 * own `usage` and adds a surface delta measured against it, so a session whose
 * cached prefix keeps being re-read can report 112K while the same request
 * really carries 2.3M. The two numbers answer different questions, and the one
 * that predicts a context-overflow failure is this one.
 *
 * The system prompt is a snapshot, not an accumulation: the platform replaces
 * it with a fresh one whenever it changes, so only the last non-empty system
 * node is counted. Everything else on the surface — user messages, assistant
 * turns, tool results — accumulates.
 * @param ctx - the Host context.
 * @param session - the session to measure.
 * @returns the three parts, their total, and the provider-anchored total for
 *   comparison; null when no token meter is mounted.
 */
export function measureContext(ctx, session) {
  const meter = ctx.get("tokenMeter");
  if (meter === undefined || typeof meter.measure !== "function") return null;
  let measurement;
  try {
    measurement = meter.measure(session);
  } catch {
    // An unpriced route or a half-written log is not a reason to fail the
    // caller: both the panel and the automatic trigger treat null as "unknown"
    // and leave the next step alone.
    return null;
  }
  const nodes = Array.isArray(measurement?.nodes) ? measurement.nodes : [];
  let systemTokens = 0;
  let messageTokens = 0;
  for (const node of nodes) {
    const tokens = typeof node?.tokens === "number" ? node.tokens : 0;
    const event = session.eventAt?.(node.seq);
    if (event?.type === "system/message") {
      if (tokens > 0) systemTokens = tokens;
      continue;
    }
    messageTokens += tokens;
  }
  let toolsTokens = 0;
  try {
    toolsTokens = estimateToolsTokens(session.requestHeader?.());
  } catch {
    // A header this module cannot read is one the next request would not send
    // either; pricing it at zero keeps the total usable.
    toolsTokens = 0;
  }
  return {
    systemTokens,
    toolsTokens,
    messageTokens,
    totalTokens: systemTokens + toolsTokens + messageTokens,
    // Not added into the total above: the provider already counted these
    // tokens when it produced them, and the cached prefix means the next
    // request mostly re-reads them rather than re-sending them. Kept for the
    // panel so the two figures can be compared side by side.
    usageTokens:
      typeof measurement?.totalTokens === "number"
        ? measurement.totalTokens
        : 0,
  };
}

/**
 * Render a span of the surface as the text a summarizer reads.
 * @param session - the session the span belongs to.
 * @param seqs - the surface nodes to render, in order.
 * @returns the non-empty renderings, in surface order.
 */
function renderSpanTexts(session, seqs) {
  const blocks = [];
  for (const seq of seqs ?? session.surface.nodes) {
    const event = session.eventAt?.(seq);
    if (event === undefined) continue;
    const text = renderMessage(session.deriveEventMessage(event));
    if (text !== "") blocks.push(text);
  }
  return blocks;
}
/**
 * Build an excerpt of the span that fits the summarizer's budget.
 *
 * Two shapes, because the two failure modes want opposite things. The default
 * keeps a head and a tail: the head holds the goal and the constraints stated
 * at the start, the tail holds whatever is still in progress, and the middle
 * is what a checkpoint needs least. With `tailOnly` the head is dropped
 * entirely — that is the "give up the earliest history" mode, where the point
 * is to keep exactly the most recent records that fit rather than to pretend
 * the beginning matters most.
 * @param ctx - the Host context.
 * @param agent - the agent whose history is being excerpted.
 * @param limitTokens - the token budget the excerpt must fit.
 * @param t - translator for the omission marker.
 * @param only - the surface nodes to render, in order; the whole surface when
 *   omitted. A compaction passes its own span so the excerpt matches the span
 *   the checkpoint will replace.
 * @param tailOnly - keep only the newest records that fit, dropping the head.
 * @returns the excerpt and how many records it kept or omitted; null when the
 *   history renders to nothing.
 */
export function buildExcerpt(ctx, agent, limitTokens, t, only, tailOnly = false) {
  const session = agent.session;
  const blocks = renderSpanTexts(session, only);
  if (blocks.length === 0) return null;

  const budget = renderBudgetBytes(limitTokens);
  const head = [];
  let used = 0;
  const headBudget = tailOnly ? 0 : Math.floor(budget * HEAD_SHARE);
  if (headBudget > 0)
    for (const text of blocks) {
      const bytes = utf8Bytes(text);
      if (used + bytes > headBudget) break;
      head.push(text);
      used += bytes;
    }
  const tail = [];
  for (let index = blocks.length - 1; index >= head.length; index -= 1) {
    const text = blocks[index];
    const bytes = utf8Bytes(text);
    if (used + bytes > budget) break;
    tail.unshift(text);
    used += bytes;
  }
  if (head.length === 0 && tail.length === 0) return null;
  const omitted = blocks.length - head.length - tail.length;
  return {
    kept: head.length + tail.length,
    omitted,
    text: [
      ...head,
      ...(omitted <= 0
        ? []
        : [
            t("prompt.excerptGap", {
              items: omitted,
              tokens: Math.floor(budget / CHARS_PER_TOKEN),
            }),
          ]),
      ...tail,
    ].join("\n\n"),
  };
}

/**
 * Cut rendered history into pieces that each fit one request, measured in
 * UTF-8 bytes rather than characters: a body is measured in bytes at every
 * layer below this one, and counting UTF-16 code units let a Chinese-heavy
 * segment grow to roughly 1.09x the byte count it had been sized against.
 *
 * A piece is never split across an arbitrary character when it can be avoided:
 * the boundary falls between whole records, so a segment reads as a run of
 * conversation rather than a sentence cut in half. Only a single record that
 * is itself over budget gets hard-split (by bytes, at code-point boundaries),
 * and it becomes its own segment — keeping it with its neighbours would push
 * them over the limit with it.
 * @param blocks - the rendered records, in surface order.
 * @param budgetBytes - the largest UTF-8 byte count one segment may hold.
 * @returns the segment bodies, in order.
 */
export function splitSegments(blocks, budgetBytes) {
  const segments = [];
  let current = [];
  let used = 0;
  const separator = "\n\n";
  const separatorBytes = utf8Bytes(separator);
  const flush = () => {
    if (current.length === 0) return;
    segments.push(current.join(separator));
    current = [];
    used = 0;
  };
  for (const block of blocks) {
    const bytes = utf8Bytes(block);
    if (bytes >= budgetBytes) {
      // One record larger than a whole segment: it goes alone, cut to fit.
      flush();
      for (const slice of splitTextByBytes(block, budgetBytes))
        segments.push(slice);
      continue;
    }
    if (current.length > 0 && used + separatorBytes + bytes > budgetBytes)
      flush();
    current.push(block);
    used += (current.length > 1 ? separatorBytes : 0) + bytes;
  }
  flush();
  return segments;
}
/**
 * The route the summarizer is going to run on.
 *
 * The configured compaction target wins over the session's own route, because
 * that is the model whose window the settings slider measures against and the
 * one the user picked for this job.
 * @param ctx - the Host context.
 * @param agent - the agent being compacted.
 * @param provider - the configured provider, or an empty string.
 * @param model - the configured model, or an empty string.
 * @returns the route plus its context window; null when unresolvable.
 */
export async function resolveRoute(ctx, agent, provider, model) {
  const requested = agent.session.requestHeader?.()?.config;
  const routeProvider =
    provider === "" ? (requested?.provider ?? "") : provider;
  const routeModel = model === "" ? (requested?.model ?? "") : model;
  const llm = ctx.get("llm");
  if (llm === undefined || routeProvider === "" || routeModel === "")
    return { provider: routeProvider, model: routeModel, contextWindow: null, maxOutput: null };
  try {
    const info = await llm.resolveModelInfo(routeProvider, routeModel);
    const window = info?.context?.contextWindow;
    const output = info?.defaultMaxTokens;
    return {
      provider: routeProvider,
      model: routeModel,
      contextWindow: Number.isInteger(window) && window > 0 ? window : null,
      // The adapter's own output default, when it declares one. The summarizer
      // uses it as the starting rung of its retry ladder and as the point it
      // must not fall below, so a model that says nothing simply has no figure
      // here and the ladder starts from whatever the session already sends.
      maxOutput: Number.isInteger(output) && output > 0 ? output : null,
    };
  } catch {
    // An adapter that cannot describe the route must not turn into a failed
    // compaction: an unknown window is what this plugin handled before the
    // probe existed, and it is still the right answer when the adapter simply
    // cannot say.
    return {
      provider: routeProvider,
      model: routeModel,
      contextWindow: null,
      maxOutput: null,
    };
  }
}
/**
 * The output budget one retry rung asks for.
 *
 * The ladder starts at whatever the session already sends, or at the adapter's
 * own default when the session sends nothing, and doubles per attempt. It is
 * capped at {@link MAX_OUTPUT_TOKENS} and never goes below the figure the first
 * rung used: a retry must always offer strictly more room than the attempt that
 * was cut off, or it would reproduce the same failure and bill for it.
 * @param route - the resolved route, carrying the adapter's output default.
 * @param requested - the session's own `maxTokens`, when it set one.
 * @param attempt - zero-based rung; values above 0 ask for more than rung 0.
 * @returns the output token budget, or undefined to leave the call untouched.
 */
export function outputBudgetFor(route, requested, attempt) {
  const base =
    Number.isInteger(requested) && requested > 0
      ? requested
      : Number.isInteger(route?.maxOutput) && route.maxOutput > 0
        ? route.maxOutput
        : 4_096;
  if (base >= MAX_OUTPUT_TOKENS) return MAX_OUTPUT_TOKENS;
  return Math.min(MAX_OUTPUT_TOKENS, base * 2 ** attempt);
}
/**
 * Strip the code fence a model sometimes wraps its whole answer in.
 *
 * Kept as the tolerant form for summaries: a compaction checkpoint may itself
 * quote fenced code, and removing only the outer pair would otherwise truncate
 * a valid summary at its first inner fence.
 * @param text - the raw answer.
 * @returns the answer without a leading or trailing fence.
 */
function stripFence(text) {
  return text.replace(/^`{3}(?:markdown)?\s*/i, "").replace(/\s*`{3}$/, "");
}

/**
 * Extract only the body of the FIRST fenced block when an answer opens with
 * one, discarding anything the model wrote outside it.
 *
 * This is the strict form used exclusively for the prompt optimizer, whose
 * output is pasted straight into the composer: a model that disobeys the
 * "no code block, no advice outside it" instruction would otherwise leave the
 * closing fence and its trailing tips in the draft that is about to be sent.
 * A summary must never go through here — it legitimately contains code blocks.
 *
 * Returns null when the answer does not open with a fence, so the caller can
 * fall back to the tolerant strip instead of guessing.
 * @param text - the raw answer, already trimmed.
 * @returns the fenced body, or null when there is no leading fence.
 */
export function extractFencedBody(text) {
  if (typeof text !== "string" || text === "") return null;
  const match = /^`{3}[^\n]*\n([\s\S]*?)\n?`{3}[ \t]*(?:\n[\s\S]*)?$/.exec(text);
  if (match === null) return null;
  return match[1].trim();
}

/**
 * Clean one model answer for its consumer.
 * @param text - the raw answer, already trimmed.
 * @param strict - true only for the optimizer, whose output becomes a draft.
 * @returns the cleaned text.
 */
function cleanAnswer(text, strict) {
  if (strict) {
    const body = extractFencedBody(text);
    if (body !== null) return body;
  }
  return stripFence(text);
}

/**
 * One user message carrying text this module composed.
 *
 * Built here rather than imported: the harness message constructors live in
 * `@deepseek-ai/dsh-llm`, and a locally linked plugin cannot resolve that
 * package from disk — only the Host's own resolver makes it importable, and a
 * plugin that hard-requires it fails to load anywhere else. A user message is
 * also small enough to write out: `role`, `content`, frozen. The platform's own
 * compaction appends its instruction exactly this way.
 * @param text - the message text.
 * @returns a frozen user message.
 */
export function instructionMessage(text) {
  const block = Object.freeze({ type: "text", text });
  return Object.freeze({ role: "user", content: Object.freeze([block]) });
}

/**
 * Whether a replayed span refers to tools.
 *
 * Tool schemas are only sent when the history actually mentions a tool call or
 * a tool result. A rendered-text request is one user message and must not carry
 * schemas: a model holding a tool list will use it, and a summarizer that
 * decides to run a command is the exact failure this module exists to avoid.
 * @param messages - the messages about to be sent.
 * @returns whether the request needs the session's tool definitions.
 */
function referencesTools(messages) {
  return messages.some(
    (message) =>
      message?.role === "tool" ||
      (Array.isArray(message?.content) &&
        message.content.some((block) => block?.type === "tool-call")),
  );
}

/**
 * Replay a span as the messages it really holds.
 *
 * This is what makes a summarization request a genuine prefix of the
 * conversation: the same system head, the same messages, the same tool
 * definitions. The provider's prefix cache then covers the history, so the
 * summarizer reads it at cache-hit prices instead of paying for it a second
 * time as re-serialized text.
 * @param session - the session the span belongs to.
 * @param seqs - the surface nodes being replaced, in order.
 * @returns the messages to send, or null when the span holds none.
 */
function replayMessages(session, seqs) {
  const nodes = session.surface.nodes;
  const headSeq = nodes.length === 0 ? undefined : nodes[0];
  const head = headSeq === undefined ? undefined : session.eventAt?.(headSeq);
  const system =
    head?.type === "system/message" ? session.deriveEventMessage(head) : null;
  const region = [];
  for (const seq of seqs ?? []) {
    const event = session.eventAt?.(seq);
    if (event === undefined) continue;
    const message = session.deriveEventMessage(event);
    if (message !== null && message !== undefined) region.push(message);
  }
  const messages = system === null ? region : [system, ...region];
  return messages.length === 0 ? null : messages;
}

/**
 * Run one summarization request and return the text it produced.
 *
 * A direct LLM call, not a subagent. That distinction is the whole point: an
 * activation hands the summarizer a child session with the parent's full tool
 * set and permission preset, so it can read, write and spawn — and a child that
 * reads a long history last reads it as work in progress, not as material to
 * condense. Here there is no child, no session, and no tools unless the replayed
 * history itself refers to them, so the only thing this call can produce is
 * text.
 * @param ctx - the Host context.
 * @param agent - the agent whose session is being compacted.
 * @param route - the resolved provider and model to call.
 * @param messages - the conversation to condense, instruction included last.
 * @param signal - optional cancellation forwarded to the adapter.
 * @returns the summary text.
 */
export async function runSummarizer(
  ctx,
  agent,
  route,
  messages,
  signal,
  purpose = "compaction",
) {
  // A summary cut off by the output limit is not a failure of the request: the
  // model was asked a question it answered at the wrong length. Raising the
  // ceiling is the one correction that keeps the history, the prompt and the
  // model as they were, so it is tried before the compaction is given up — a
  // retry that bills a second time is still cheaper than a history that stays
  // uncompressed. Every other terminal reason is thrown straight through; only
  // `max-tokens` is retryable.
  let lastError = null;
  for (let attempt = 0; attempt < OUTPUT_RETRY_ATTEMPTS; attempt += 1) {
    try {
      return await summarizeOnce(
        ctx,
        agent,
        route,
        messages,
        signal,
        purpose,
        attempt,
      );
    } catch (error) {
      if (error?.code !== "max-tokens") throw error;
      lastError = error;
    }
  }
  throw lastError ?? new Error(translatorFor(ctx)("error.truncated"));
}

/**
 * One summarizer attempt at a given rung of the output ladder.
 *
 * The first rung asks for exactly what the session already sends, so a profile
 * whose configuration works today is not quietly changed by this feature. Each
 * later rung doubles the output budget towards {@link MAX_OUTPUT_TOKENS}: the
 * window is untouched, only the room reserved for the answer grows.
 * @param ctx - the Host context.
 * @param agent - the agent whose session is being compacted.
 * @param route - the resolved provider and model to call.
 * @param messages - the conversation to condense, instruction included last.
 * @param signal - optional cancellation forwarded to the adapter.
 * @param purpose - the ledger purpose this call bills under.
 * @param attempt - zero-based rung; 0 keeps the session's own request settings.
 * @returns the summary text.
 */
async function summarizeOnce(
  ctx,
  agent,
  route,
  messages,
  signal,
  purpose,
  attempt,
) {
  const t = translatorFor(ctx);
  const llm = ctx.get("llm");
  if (llm === undefined) throw new Error(t("error.noLlm"));
  if (route.provider === "" || route.model === "")
    throw new Error(t("error.noRoute"));
  const header = agent.session.requestHeader?.();
  const requested = header?.config?.maxTokens;
  const maxTokens = attempt === 0 ? requested : outputBudgetFor(route, requested, attempt);
  const tools = referencesTools(messages)
    ? Array.isArray(header?.tools) && header.tools.length > 0
      ? [...header.tools]
      : undefined
    : undefined;
  const toolHistory =
    tools === undefined ? undefined : agent.session.toolHistory?.();

  let text = "";
  let finish = { kind: "stop" };
  const stream = llm.stream({
    provider: route.provider,
    model: route.model,
    messages,
    // Schemas only travel with the history that refers to them: an assistant
    // tool-call the adapter cannot match to a declaration is invalid input, and
    // a tool list a request does not need is an invitation to use it.
    ...(tools === undefined ? {} : { tools }),
    ...(toolHistory === undefined ? {} : { toolHistory }),
    ...(Number.isInteger(maxTokens) && maxTokens > 0 ? { maxTokens } : {}),
    // The session id and purpose reach the provider as request metadata, so a
    // compaction (or optimizer) call is attributable in the same place the
    // session's own calls are — and the adapter marks it accordingly.
    sessionId: agent.session.id,
    purpose,
    ...(signal === undefined ? {} : { signal }),
  });
  // The spend is real the moment the call starts, so the ledger is written
  // whichever way the stream ends: a stream that dies mid-answer still cost
  // the tokens it carried. `usage` is the adapter's own count when the chunk
  // protocol supplied one; without it the record falls back to a char-based
  // estimate and is labelled as one, so the panorama's tool line stays honest
  // across SDK versions instead of reporting a confident zero.
  let usage = null;
  const recordSpend = () =>
    appendLedger(ctx, {
      kind: "usage",
      purpose,
      provider: route.provider,
      model: route.model,
      sessionId: agent.session.id,
      ...(usage ?? {
        input: Math.ceil(JSON.stringify(messages).length / CHARS_PER_TOKEN),
        output: Math.ceil(text.length / CHARS_PER_TOKEN),
        cacheRead: 0,
        cacheWrite: 0,
      }),
      estimated: usage === null,
      chars: text.length,
    });
  try {
    for await (const chunk of stream) {
      if (chunk.type === "text-delta") text += chunk.text;
      else if (chunk.type === "usage") usage = usageFromChunk(chunk);
      else if (chunk.type === "finish") finish = chunk.reason;
    }
  } catch (error) {
    await recordSpend();
    throw error;
  }
  await recordSpend();

  // Fail closed on every terminal reason that is not a complete answer. A
  // truncated checkpoint is worse than no compaction: it replaces real history
  // with a summary that silently stops in the middle of a sentence.
  if (finish.kind === "error" || finish.kind === "aborted") {
    const message = finish.failure?.message ?? String(finish.kind);
    const error = new Error(message);
    if (typeof finish.failure?.code === "string")
      error.code = finish.failure.code;
    throw error;
  }
  if (finish.kind === "max-tokens") {
    // Tagged so the ladder in `runSummarizer` can tell a length problem from
    // every other way a call can end, and rethrow only what a bigger budget
    // cannot fix.
    const error = new Error(t("error.truncated"));
    error.code = "max-tokens";
    throw error;
  }

  const trimmed = text.trim();
  if (trimmed === "") throw new Error(t("error.noSummary"));
  // The optimizer's output is pasted straight into the composer, so a fenced
  // block plus advice outside it must be reduced to the block's body. A
  // compaction summary keeps the tolerant strip: it may legitimately quote
  // fenced code from the history it is condensing.
  return cleanAnswer(trimmed, purpose === "prompt-optimizer");
}

/**
 * Summarize a session's whole surface through direct LLM calls.
 *
 * Three paths, chosen by how the history compares to the summarizer's window.
 *
 * Fits: the span is replayed as the messages it really holds, with the
 * instruction appended as the final user message. The provider sees a prefix of
 * the very conversation being replaced, so its cache covers the history.
 *
 * Does not fit, segmenting off: the oldest history is dropped rather than
 * compressed, and the newest records that do fit are summarized. That is the
 * "give up the earliest part" mode, and it is honest about what it lost — the
 * excerpt carries a marker naming how many records were dropped. It goes as
 * rendered text, because an excerpt is not a prefix of anything.
 *
 * Does not fit, segmenting on: the span is cut into segments that each fit one
 * request, each segment is summarized in parallel, and a final call merges those
 * summaries into the one that replaces the span. Nothing is dropped, and no
 * single request exceeds the window — which is exactly the request that used to
 * hang or come back empty.
 *
 * The replayed path carries one risk the rendered paths do not: the messages are
 * real, so a model that ignores the final instruction could answer them as if
 * the conversation were still going. That is a prompt problem, not a plumbing
 * problem — the request has no tools and no session — and it is the reason the
 * default instruction is written as a closing constraint rather than an opening
 * request.
 * @param ctx - the Host context.
 * @param agent - the parent agent.
 * @param input - instruction, route override, abort signal, and whether
 *   segmenting is enabled.
 * @returns the summary text.
 */
async function summarizeSpan(ctx, agent, input) {
  const t = translatorFor(ctx);
  const model = typeof input.model === "string" ? input.model.trim() : "";
  const provider =
    typeof input.provider === "string" ? input.provider.trim() : "";
  const route = await resolveRoute(ctx, agent, provider, model);
  const limit =
    route.contextWindow === null
      ? null
      : Math.floor(route.contextWindow * SUMMARY_SHARE);
  // Measured on the real request shape rather than on `measure().totalTokens`:
  // the usage-anchored number reported 112K for a request really carrying 2.3M,
  // so every threshold derived from it was off by an order of magnitude.
  const measured = measureContext(ctx, agent.session);
  const inherited = measured?.totalTokens ?? 0;
  const overBudget = limit !== null && inherited > limit;
  const span = input.span;
  const nodes = span?.shadowedSeqs ?? agent.session.surface.nodes;

  if (!overBudget) {
    // The instruction goes last, after the history it applies to. A model that
    // reads the constraint first and forty thousand tokens of transcript
    // afterwards answers the transcript, not the constraint.
    const replayed = replayMessages(agent.session, nodes);
    if (replayed === null)
      throw new Error(t("error.tooLarge", { tokens: inherited, limit }));
    return runSummarizer(
      ctx,
      agent,
      route,
      [...replayed, instructionMessage(input.prompt)],
      input.signal,
    );
  }

  // From here the span is rendered as text: an excerpt or a segment is not a
  // prefix of the conversation, so there is no cache to reuse and no reason to
  // send it as messages.
  const blocks = renderSpanTexts(agent.session, nodes);
  if (blocks.length === 0)
    throw new Error(t("error.tooLarge", { tokens: inherited, limit }));

  const budgetBytes = renderBudgetBytes(limit ?? inherited);

  if (input.split !== true) {
    // Discard-the-earliest mode: keep the newest records that fit, and say how
    // many were dropped so the summary cannot pretend to cover them.
    const excerpt = buildExcerpt(
      ctx,
      agent,
      limit ?? inherited,
      t,
      nodes,
      true,
    );
    if (excerpt === null)
      throw new Error(t("error.tooLarge", { tokens: inherited, limit }));
    return runSummarizer(
      ctx,
      agent,
      route,
      [instructionMessage(excerpt.text + "\n\n" + input.prompt)],
      input.signal,
    );
  }

  const segments = splitSegments(blocks, budgetBytes);
  if (segments.length <= 1)
    return runSummarizer(
      ctx,
      agent,
      route,
      [
        instructionMessage(
          (segments[0] ?? blocks.join("\n\n")) + "\n\n" + input.prompt,
        ),
      ],
      input.signal,
    );

  // Parallel on purpose: the segments are independent, each request is inside
  // the window, and serializing them would make the wall-clock cost grow with
  // the number of segments — the pause this whole feature exists to shorten.
  const parts = await Promise.all(
    segments.map((body, index) =>
      runSummarizer(
        ctx,
        agent,
        route,
        [
          instructionMessage(
            [
              t("prompt.segment", { index: index + 1, total: segments.length }),
              body,
              input.prompt,
            ].join("\n\n"),
          ),
        ],
        input.signal,
      ),
    ),
  );
  return runSummarizer(
    ctx,
    agent,
    route,
    [
      instructionMessage(
        [
          t("prompt.merge", { count: parts.length }),
          ...parts.map((text, index) => "## " + (index + 1) + "\n" + text),
          input.prompt,
        ].join("\n\n"),
      ),
    ],
    input.signal,
  );
}

/**
 * Replace the completed part of a session's surface with a model summary.
 *
 * Works while the conversation is running, which is the whole point: the span
 * is fixed before the summarizer starts, so every step the conversation takes
 * during that call lands after the cut and is replayed verbatim behind the
 * checkpoint. Nothing is stopped to make room for it.
 *
 * Three things are deliberately not locked. The agent is not held in
 * maintenance, because that is exactly the pause this avoids. The span stops
 * at the last balanced cut rather than at the tail, because a span ending on an
 * open tool call could not be replaced without splitting the pair. And the
 * compaction lock is taken before the model is called, so the session refuses a
 * second compaction instead of paying for the same summary twice.
 * @param ctx - the Host context.
 * @param agent - the agent owning the session.
 * @param input - the instruction, model override and provenance; `beforeSeq`
 *   narrows the span to the balanced history above one surface node ("compact
 *   to here") instead of the whole completed history.
 * @returns the applied counts, or null when there was nothing to replace.
 */
export async function compactContext(ctx, agent, input = {}) {
  return withSessionLock(ctx, agent, () =>
    compactContextLocked(ctx, agent, input),
  );
}

/** The compaction body, already under the session's task lock. */
async function compactContextLocked(ctx, agent, input = {}) {
  const t = translatorFor(ctx);
  const session = agent.session;
  const state = inspectEntryState(session);
  if (
    state.unmatched !== undefined &&
    !(
      state.latestEndSeed !== undefined &&
      state.latestEndSeed > state.unmatched.seq
    )
  )
    throw new Error(t("error.inFlight"));
  const span =
    input.beforeSeq === undefined
      ? selectCompactSpan(session)
      : selectSpanBefore(session, input.beforeSeq);
  if (span === null) return null;

  const prompt =
    typeof input.prompt === "string" && input.prompt.trim() !== ""
      ? input.prompt
      : DEFAULT_COMPACT_PROMPT;
  // Taken before the summarizer runs, and released by replaceSurface on every
  // failure path, so a concurrent request is refused rather than duplicated.
  const opened = openCompaction(session, state.openTurn, input.sourceCommandId);
  let landed = false;
  try {
    // The span goes to the summarizer so it replays exactly the messages the
    // checkpoint is about to replace, not whatever the surface looks like when
    // the request is finally built.
    const text = await summarizeSpan(ctx, agent, {
      ...input,
      prompt,
      span,
    });
    const result = await replaceSurface(ctx, agent, {
      ...input,
      span,
      opened,
      summary: [{ type: "text", text }],
    });
    landed = true;
    return result;
  } catch (error) {
    if (!landed) closeCompaction(session, opened, error);
    throw error;
  }
}

/**
 * Delete one Chat row's content from the surface, and therefore the context.
 *
 * The right-click menu knows only the row the gesture landed on; everything
 * else is decided here. The row key is resolved to the surface nodes it stands
 * for, those are grown to the smallest run that splits no tool-call/result
 * pair, and the run is replaced with an empty `system/message` tombstone: the
 * platform projects it to no wire message and the chat draws no row for it, so
 * the content is gone from both the model's context and the view while the
 * durable log keeps the shadowed events inspectable.
 *
 * Safe mid-turn for the same reason compaction is: the run ends at a balanced
 * cut behind whatever the running step is still appending.
 * @param ctx - the Host context.
 * @param agent - the agent owning the session.
 * @param input - `nodeKey`, the clicked row's `data-chat-node-key`.
 * @returns the applied counts, or null when there was nothing to delete.
 */
export async function deleteChatNode(ctx, agent, input = {}) {
  const t = translatorFor(ctx);
  const session = agent.session;
  const seqs = resolveChatNodeSeqs(session, input.nodeKey);
  if (seqs === null) throw new Error(t("error.noTarget"));
  const run = expandDeleteRun(session, seqs);
  if (run === null) throw new Error(t("error.inProgress"));
  return withSessionLock(ctx, agent, async () => {
    const result = await replaceSurface(ctx, agent, {
      origin: DELETE_ORIGIN,
      span: run,
      undoGroup: randomUUID(),
    });
    if (result === null) return null;
    // The rows the transcript now hides, answered with the result so the
    // Client can clear them the moment the response lands instead of waiting
    // for the event stream to circle back. The whole log is walked — a deleted
    // step's retry receipts sit before its settled message, and an emptied
    // turn's furniture depends on what survived everywhere else.
    result.hiddenKeys = hiddenRowKeysForSession(session);
    return result;
  });
}

/**
 * Compact the balanced history above one Chat row ("compact to here").
 *
 * The clicked message and everything below it stay verbatim: `beforeSeq` is
 * the first node of the clicked content, and the compaction span ends at the
 * last balanced cut strictly above it. Everything else matches an ordinary
 * compaction — the same summarizer, the same checkpoint card, the same
 * mid-turn safety.
 * @param ctx - the Host context.
 * @param agent - the agent owning the session.
 * @param input - `nodeKey`, the clicked row's `data-chat-node-key`; any other
 *   {@link compactContext} input passes through.
 * @returns the applied counts, or null when nothing sits above the row.
 */
export async function compactThroughNode(ctx, agent, input = {}) {
  const t = translatorFor(ctx);
  const session = agent.session;
  const seqs = resolveChatNodeSeqs(session, input.nodeKey);
  if (seqs === null) throw new Error(t("error.noTarget"));
  const beforeSeq = Math.min(...seqs);
  return compactContext(ctx, agent, { ...input, beforeSeq });
}

/**
 * The committed events of one live session, in log order.
 * @param session - the session to read.
 * @returns the events from seq 0 to the current tail.
 */
function eventsOf(session) {
  const events = [];
  for (let seq = 0; seq < session.seq; seq += 1)
    events.push(session.eventAt(seq));
  return events;
}

/**
 * Clear everything above one Chat row, without a summary ("clear to here").
 *
 * The delete machinery with the compaction cut: the span is the balanced
 * history `selectSpanBefore` finds above the clicked row, and it is replaced
 * by the same empty tombstone a delete writes — the rows leave the context and
 * the view, no checkpoint card appears, and the same queue discipline applies
 * while no step is open. Unlike `compactThroughNode` there is no summarizer
 * call and no ledger row: nothing is summarized, so nothing is spent.
 * @param ctx - the Host context.
 * @param agent - the agent owning the session.
 * @param input - `nodeKey`, the clicked row's `data-chat-node-key`.
 * @returns the applied counts, or null when nothing balanced sits above.
 */
export async function clearThroughNode(ctx, agent, input = {}) {
  const t = translatorFor(ctx);
  const session = agent.session;
  const seqs = resolveChatNodeSeqs(session, input.nodeKey);
  if (seqs === null) throw new Error(t("error.noTarget"));
  const span = selectSpanBefore(session, Math.min(...seqs));
  if (span === null) return null;
  return withSessionLock(ctx, agent, async () => {
    const result = await replaceSurface(ctx, agent, {
      origin: DELETE_ORIGIN,
      span,
      undoGroup: randomUUID(),
    });
    if (result === null) return null;
    result.hiddenKeys = hiddenRowKeysForSession(session);
    return result;
  });
}

/**
 * Delete several Chat rows in one action (multi-select batch delete).
 *
 * Every row grows its own balanced run first — the same pairing-safe
 * expansion a single delete uses — and runs that overlap (two rows of one
 * reply expanding to the same run) merge into one. Runs that merely sit next
 * to each other stay separate: the rows between two selections were not
 * selected and must survive. One undo group covers the whole batch.
 * @param ctx - the Host context.
 * @param agent - the agent owning the session.
 * @param input - `nodeKeys`, the selected rows' `data-chat-node-key` values.
 * @returns the summed counts plus the batch's hidden keys, or null when no
 *   selected row still maps to the context.
 */
export async function deleteChatNodes(ctx, agent, input = {}) {
  const t = translatorFor(ctx);
  const session = agent.session;
  const nodeKeys = Array.isArray(input.nodeKeys) ? input.nodeKeys : [];
  const nodes = session.surface.nodes;
  const spans = [];
  for (const nodeKey of nodeKeys) {
    const seqs = resolveChatNodeSeqs(session, nodeKey);
    if (seqs === null) continue;
    const run = expandDeleteRun(session, seqs);
    if (run === null) throw new Error(t("error.inProgress"));
    spans.push({
      startIdx: nodes.indexOf(run.start),
      endIdx: nodes.indexOf(run.end),
    });
  }
  if (spans.length === 0) throw new Error(t("error.noTarget"));
  spans.sort((left, right) => left.startIdx - right.startIdx);
  const merged = [];
  for (const span of spans) {
    const last = merged[merged.length - 1];
    if (last !== undefined && span.startIdx <= last.endIdx) {
      if (span.endIdx > last.endIdx) last.endIdx = span.endIdx;
      continue;
    }
    merged.push({ ...span });
  }
  return withSessionLock(ctx, agent, async () => {
    const undoGroup = randomUUID();
    const result = {
      items: 0,
      beforeTokens: 0,
      afterTokens: 0,
      runs: merged.length,
      queuedRunIds: [],
      undoGroup,
    };
    for (const span of merged) {
      const part = await replaceSurface(ctx, agent, {
        origin: DELETE_ORIGIN,
        span: {
          start: nodes[span.startIdx],
          end: nodes[span.endIdx],
          shadowedSeqs: nodes.slice(span.startIdx, span.endIdx + 1),
        },
        undoGroup,
      });
      if (part === null) continue;
      result.items += part.items;
      result.beforeTokens += part.beforeTokens;
      result.afterTokens += part.afterTokens;
      result.queuedRunIds.push(...part.queuedRunIds);
    }
    if (result.items === 0) return null;
    result.hiddenKeys = hiddenRowKeysForSession(session);
    return result;
  });
}

/**
 * Undo deletes that have not taken effect yet ("undo delete").
 *
 * Only a queued delete is undoable, and that is deliberate: until the next
 * `step/start` the run exists nowhere but `pendingDeletes`, so dropping the
 * entry restores the rows exactly — no log write, no rewrite, no residue. A
 * delete whose tombstone already landed is out of reach on purpose: the
 * stored format cannot restore a tool result over a tombstone (a
 * `tool/result` replacement must target a current tool/result) and a
 * replacement inserts exactly one node, so a multi-row run has no sound way
 * back in place. Such a delete answers with the "nothing to undo" refusal
 * instead of a restore that would corrupt the log or move rows around.
 * @param ctx - the Host context.
 * @param agent - the agent owning the session.
 * @param input - optional `runIds` to drop exactly; otherwise the runs of the
 *   most recent delete group.
 * @returns how many runs were dropped and the remaining hidden keys.
 */
export async function undoDelete(ctx, agent, input = {}) {
  const t = translatorFor(ctx);
  const session = agent.session;
  return withSessionLock(ctx, agent, async () => {
    const runs = pendingDeleteRunsFor(session);
    if (runs.length === 0) throw new Error(t("error.nothingToUndo"));
    const wanted =
      Array.isArray(input.runIds) && input.runIds.length > 0
        ? new Set(input.runIds)
        : null;
    let undone;
    let kept;
    if (wanted !== null) {
      undone = runs.filter((run) => wanted.has(run.id));
      kept = runs.filter((run) => !wanted.has(run.id));
    } else {
      const group = runs[runs.length - 1].group;
      undone = runs.filter((run) => run.group === group);
      kept = runs.filter((run) => run.group !== group);
    }
    if (undone.length === 0) throw new Error(t("error.nothingToUndo"));
    if (kept.length === 0) pendingDeletes.delete(session.id);
    else pendingDeletes.set(session.id, kept);
    return {
      undone: undone.length,
      items: undone.reduce((total, run) => total + run.shadowedSeqs.length, 0),
      hiddenKeys: hiddenRowKeysForSession(session),
    };
  });
}

/**
 * The Chat row keys of one whole turn, for folding the turn to one row.
 *
 * The turn is located the way {@link hiddenRowKeys} locates it: a turn's
 * events fall between its `turn/start` and `turn/end`, because user messages
 * carry no turn of their own. The keys cover the turn's content rows and
 * their log-only siblings (retry receipts) plus the turn furniture — usage
 * tail, process control, error and max-tokens rows. `keepCandidates` lists
 * the turn's own content keys in display order so the Client can pick a
 * representative row that survives the fold; the fold itself is view-side.
 * @param session - the session the row was rendered from.
 * @param nodeKey - the clicked row's `data-chat-node-key`.
 * @returns the turn, its row keys and candidate representatives, or null
 *   when the row belongs to no turn.
 */
export function turnRows(session, nodeKey) {
  const seqs = resolveChatNodeSeqs(session, nodeKey);
  if (seqs === null) return null;
  const events = eventsOf(session);
  const turnOf = new Map();
  let openTurn = null;
  for (const event of events) {
    if (event.type === "turn/start") {
      openTurn = Number.isSafeInteger(event.data?.turn)
        ? event.data.turn
        : null;
      continue;
    }
    if (event.type === "turn/end") {
      openTurn = null;
      continue;
    }
    if (!isContentRowEvent(event)) continue;
    const turn = Number.isSafeInteger(event.data?.turn)
      ? event.data.turn
      : openTurn;
    if (Number.isSafeInteger(turn)) turnOf.set(event.seq, turn);
  }
  let turn = null;
  for (const seq of seqs) {
    if (turnOf.has(seq)) {
      turn = turnOf.get(seq);
      break;
    }
  }
  if (turn === null) return null;
  const keys = new Set();
  const keepCandidates = [];
  for (const event of events) {
    if (event.type === "llm/retry") {
      if (event.data?.turn !== turn) continue;
      const retryId = event.data?.retryId;
      if (retryId !== undefined && String(retryId) !== "")
        keys.add(chatNodeKey("model-retry", String(retryId)));
      continue;
    }
    if (!isContentRowEvent(event) || turnOf.get(event.seq) !== turn) continue;
    for (const key of rowKeysForEvent(event)) {
      keys.add(key);
      keepCandidates.push(key);
    }
  }
  for (const kind of [
    "turn-tail",
    "turn-process",
    "turn-error",
    "turn-max-tokens",
  ])
    keys.add(chatNodeKey(kind, String(turn)));
  return { turn, keys: [...keys], keepCandidates };
}

/**
 * What the row menu shows before its actions: the row's own token weight, the
 * context accumulated through it, and which actions have anything to act on.
 *
 * The numbers come from the same meter the panorama page uses, counted over
 * the current surface: `rowTokens` is the row's own nodes, `uptoTokens` runs
 * from the surface head through the row in surface order (the order the
 * model reads, which replacement nodes can shuffle relative to raw seqs),
 * and `totalTokens` is the whole surface. A row that stands for nothing
 * answers null and the menu does not open.
 * @param ctx - the Host context, for the token meter.
 * @param session - the session the row was rendered from.
 * @param nodeKey - the row's `data-chat-node-key`.
 * @returns the counts and action availability, or null when the row maps to
 *   no surface node.
 */
export function rowInfo(ctx, session, nodeKey) {
  const seqs = resolveChatNodeSeqs(session, nodeKey);
  if (seqs === null) return null;
  const nodes = session.surface.nodes;
  const indexes = seqs
    .map((seq) => nodes.indexOf(seq))
    .filter((index) => index >= 0);
  if (indexes.length === 0) return null;
  const meter = ctx.tokenMeter ?? ctx.get?.("tokenMeter");
  const priced = new Map();
  if (typeof meter?.measure === "function") {
    try {
      const measurement = meter.measure(session);
      for (const node of measurement?.nodes ?? []) priced.set(node.seq, node);
    } catch {
      // An unpriced route is "unknown", not a failure: the menu shows what
      // it can and leaves the actions alone.
    }
  }
  const tokensOf = (seq) => {
    const node = priced.get(seq);
    if (typeof node?.tokens === "number") return node.tokens;
    if (typeof node?.heuristicTokens === "number") return node.heuristicTokens;
    return 0;
  };
  const rowTokens = seqs.reduce((total, seq) => total + tokensOf(seq), 0);
  const uptoTokens = nodes
    .slice(0, Math.max(...indexes) + 1)
    .reduce((total, seq) => total + tokensOf(seq), 0);
  const totalTokens = nodes.reduce((total, seq) => total + tokensOf(seq), 0);
  const rows = turnRows(session, nodeKey);
  return {
    rowTokens,
    uptoTokens,
    totalTokens,
    canClear: selectSpanBefore(session, Math.min(...seqs)) !== null,
    canCollapse: rows !== null && rows.keys.length > 0,
    canCompact: selectSpanBefore(session, Math.min(...seqs)) !== null,
    turn: rows?.turn ?? null,
  };
}

/**
 * One Chat row's events as portable Markdown ("copy as Markdown").
 *
 * The rendering is what the row shows, minus the streaming furniture:
 * message text under its role, tool calls as fenced argument blocks, tool
 * results as fenced output. Reasoning stays out of the copy — it is the
 * model's internal draft, not the reply the reader wants to paste.
 * @param session - the session the row was rendered from.
 * @param nodeKey - the row's `data-chat-node-key`.
 * @returns the Markdown text, or null when the row maps to no surface node.
 */
export function nodeMarkdown(session, nodeKey) {
  const seqs = resolveChatNodeSeqs(session, nodeKey);
  if (seqs === null) return null;
  const parts = [];
  for (const seq of seqs) {
    const event = session.eventAt(seq);
    const text = markdownForEvent(event);
    if (text !== "") parts.push(text);
  }
  return parts.length === 0 ? null : parts.join("\n\n");
}

/** The Markdown rendering of one surface event. */
function markdownForEvent(event) {
  if (event === undefined || event === null) return "";
  const message = event.data?.message ?? event.data;
  const content = Array.isArray(message?.content) ? message.content : [];
  const texts = content
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text);
  const calls = content.filter((block) => block?.type === "tool-call");
  const lines = [];
  switch (event.type) {
    case "user/message": {
      const checkpoint = event.data?.source?.kind === COMPACT_KIND;
      lines.push(checkpoint ? "**压缩摘要 / Compaction summary**" : "**用户 / User**");
      lines.push("", texts.join("\n\n"));
      break;
    }
    case "developer/message":
      lines.push("**开发者消息 / Developer message**", "", texts.join("\n\n"));
      break;
    case "assistant/message":
      lines.push("**助手 / Assistant**", "", texts.join("\n\n"));
      for (const block of calls) {
        lines.push(
          "",
          `**工具调用 / Tool call** \`${String(block.name)}\``,
          "",
          "```json",
          String(block.arguments ?? "{}"),
          "```",
        );
      }
      break;
    case "tool/result": {
      const callId = toolCallIdOf(event);
      lines.push(
        `**工具结果 / Tool result** \`${callId === "" ? "?" : callId}\``,
        "",
        "```text",
        texts.join("\n"),
        "```",
      );
      break;
    }
    case "system/message":
      lines.push("**系统 / System**", "", texts.join("\n\n"));
      break;
    default:
      return "";
  }
  return lines.join("\n").trim();
}

/**
 * One Chat row's raw log events, for the "view raw events" dialog.
 *
 * The events are returned as they are stored — including the metadata the
 * transcript does not render (stream timings, source attribution, surface
 * markers) — so what the reader inspects is exactly what a reload replays.
 * @param session - the session the row was rendered from.
 * @param nodeKey - the row's `data-chat-node-key`.
 * @returns the raw events, or null when the row maps to no surface node.
 */
export function nodeEvents(session, nodeKey) {
  const seqs = resolveChatNodeSeqs(session, nodeKey);
  if (seqs === null) return null;
  const events = seqs
    .map((seq) => session.eventAt(seq))
    .filter((event) => event !== undefined);
  return events.length === 0 ? null : events;
}

/**
 * Rewrite one user prompt through a direct LLM call.
 *
 * The compaction machinery's shape, minus the log: no surface is touched, no
 * lock is taken and nothing is written to the session, because the draft in
 * the composer is not part of the model's context yet. The request is one
 * instruction message carrying the draft as material — the optimizer prompt's
 * closing constraint is what stops a model from "continuing" the prompt
 * instead of rewriting it — and the answer is the replacement text.
 *
 * With `useContext` the draft travels with a head-and-tail excerpt of the
 * session it was written in, so a prompt that says "this function" or "the
 * failing test" rewrites into one that names them. The excerpt is framed by
 * section labels — background to consult, not material to rewrite — so any
 * instruction, configured or default, still lands on the draft as the only
 * thing to rewrite. An empty surface simply omits the excerpt.
 *
 * The route resolves like the summarizer's: the configured optimizer model
 * wins, an empty override inherits the session's own, because that is the
 * model whose conventions the user is already writing prompts for.
 * @param ctx - the Host context.
 * @param agent - the agent whose session the draft belongs to.
 * @param input - draft text, optional instruction, route override, whether
 *   to attach the session context, signal.
 * @returns the rewritten prompt text.
 */
export async function optimizePrompt(ctx, agent, input = {}) {
  return withSessionLock(ctx, agent, () =>
    optimizePromptLocked(ctx, agent, input),
  );
}

/** The optimizer body, already under the session's task lock. */
async function optimizePromptLocked(ctx, agent, input = {}) {
  const t = translatorFor(ctx);
  const draft = typeof input.text === "string" ? input.text : "";
  if (draft.trim() === "") throw new Error(t("optimizer.empty"));
  const prompt =
    typeof input.prompt === "string" && input.prompt.trim() !== ""
      ? input.prompt
      : DEFAULT_OPTIMIZER_PROMPT;
  const route = await resolveRoute(
    ctx,
    agent,
    typeof input.provider === "string" ? input.provider : "",
    typeof input.model === "string" ? input.model : "",
  );
  let context = null;
  if (input.useContext === true) {
    // Same share the compaction summarizer keeps for its answer: the excerpt
    // must leave room for the instruction, the draft and the rewrite.
    const budget =
      route.contextWindow === null
        ? OPTIMIZER_CONTEXT_TOKENS
        : Math.floor(route.contextWindow * SUMMARY_SHARE);
    context = buildExcerpt(ctx, agent, budget, t, undefined);
  }
  const body =
    context === null
      ? [prompt, draft].join("\n\n----\n\n")
      : [
          prompt,
          t("optimizer.contextIntro"),
          context.text,
          t("optimizer.draftIntro"),
          draft,
        ].join("\n\n----\n\n");
  return runSummarizer(
    ctx,
    agent,
    route,
    [instructionMessage(body)],
    input.signal,
    "prompt-optimizer",
  );
}
