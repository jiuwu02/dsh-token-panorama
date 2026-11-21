/**
 * A faithful mirror of the platform's stored-log format rules, for tests.
 *
 * Every event this plugin writes is replayed through these checks before the
 * suite finishes, so a write that would make the session refuse to load fails
 * the build instead of corrupting a real session. That is the exact bug class
 * of session-3509f8b6: a delete tombstone stamped with stale turn/step and
 * appended after `turn/end`, which the format validator then rejected.
 *
 * Mirrored sources (Desktop install, app.asar):
 * - `@deepseek-ai/dsh-session-format-v3-to-v4/src/relationships.ts`
 *   (`accept`, `requireTurn`, `requireStep`, `foldSurface`, `tool`, `compact`,
 *   `span`, `closeTools`, turn/step sequencing).
 * - `@deepseek-ai/dsh-session-format-v3-to-v4/src/system-message.ts`
 *   (`assertV4SystemMessageFields`: positive turn/step, system role, ids).
 * - `@deepseek-ai/dsh-session/src/surface.ts`
 *   (`surfaceOpOf`: surface-eligible types require a marker;
 *   `validateSurfaceMetadata`: replace ranges name earlier events;
 *   `assertSourceEventReferences`: non-empty, duplicate-free, earlier,
 *   covering every shadowed node; assistant/message carries none).
 *
 * Deliberately not mirrored: message-source catalogs, fork results, title
 * sources, PTC dispatch chains, retry attempt scheduling, developer tool
 * additions and command/done provenance. The plugin writes none of those, and
 * its fixtures model only the lifecycle its own writes must fit into.
 */

const SURFACE_TYPES = new Set([
  "system/message",
  "user/message",
  "developer/message",
  "assistant/message",
  "tool/result",
]);
const STEP_EVENT_TYPES = new Set([
  "system/message",
  "developer/message",
  "assistant/attempt",
]);
const RELATIONSHIP_TYPES = new Set([
  ...SURFACE_TYPES,
  ...STEP_EVENT_TYPES,
  "turn/start",
  "turn/end",
  "step/start",
  "step/end",
  "tool/call",
  "request/header",
  "request/context",
  "tool/ptc-dispatch-start",
  "tool/ptc-dispatch",
  "llm/retry",
  "llm/retry-started",
  "session/title",
  "session/title-llm-request",
  "command/run",
  "command/done",
  "compaction/start",
  "compaction/summary",
  "compaction/end",
  "compaction/prune",
  "session/end-seed",
]);

const fail = (message) => {
  throw new Error(`session format: ${message}`);
};
const isRecord = (value) =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const count = (value, subject) => {
  if (!Number.isSafeInteger(value) || value < 0) fail(`${subject} must be a safe integer`);
  return value;
};

/**
 * Validate one complete stored log the way the platform's loader does.
 * @param events - every committed event, in contiguous seq order.
 * @throws when any event would make the session refuse to load.
 */
export function validateStoredLog(events) {
  const state = {
    turn: null,
    step: null,
    nextTurn: 1,
    nextStep: 1,
    tools: new Map(),
    surface: [],
    protectedHead: undefined,
    compaction: undefined,
  };
  for (const [index, event] of events.entries()) {
    if (event.seq !== index) fail(`event ${index} is not dense; seq is ${event.seq}`);
    if (!RELATIONSHIP_TYPES.has(event.type)) continue;
    validateEnvelope(event);
    if (STEP_EVENT_TYPES.has(event.type)) requireStep(state, event);
    if (
      event.type.startsWith("turn/") &&
      state.compaction !== undefined
    )
      fail(`${event.type} crosses an open compaction`);
    foldSurface(state, event);
    switch (event.type) {
      case "turn/start":
        if (state.turn !== null || event.data.turn !== state.nextTurn)
          fail("turn/start does not open the expected turn");
        state.turn = state.nextTurn;
        state.nextStep = 1;
        state.tools.clear();
        break;
      case "turn/end":
        if (
          state.turn === null ||
          event.data.turn !== state.turn ||
          state.step !== null
        )
          fail("turn/end does not match the open turn with no open step");
        closeTools(state, "turn/end");
        state.turn = null;
        state.nextTurn += 1;
        break;
      case "step/start":
        if (
          state.turn === null ||
          event.data.turn !== state.turn ||
          state.step !== null ||
          event.data.step !== state.nextStep
        )
          fail("step/start does not match the open turn and next step");
        state.step = state.nextStep;
        break;
      case "step/end":
        requireStep(state, event);
        closeTools(state, "step/end");
        state.step = null;
        state.nextStep += 1;
        break;
      case "assistant/message":
      case "tool/call":
      case "tool/result":
        toolRules(state, event);
        break;
      case "request/header":
      case "request/context":
        requireTurn(state, event);
        break;
      case "llm/retry":
        // relationships.ts `retry`: coordinates only; attempt chains are the
        // engine's business and the plugin never writes them.
        if (
          state.turn === null ||
          event.data.turn !== state.turn ||
          event.data.step !== (state.step ?? state.nextStep - 1)
        )
          fail("llm/retry does not match the current turn and step");
        break;
      case "compaction/start":
      case "compaction/summary":
      case "compaction/end":
      case "compaction/prune":
        compactionRules(state, event);
        break;
      case "user/message": {
        const source = event.data.source;
        if (!isRecord(source)) fail("user message source requires an object");
        if (event.surfaceOp !== "append" && source.kind === "compact-checkpoint")
          compactionOwner(state, source, "compaction checkpoint");
        break;
      }
      case "session/end-seed":
        state.compaction = undefined;
        break;
      default:
        break;
    }
  }
}

/** Envelope + surface marker rules (surface.ts `surfaceOpOf`, `validateSurfaceMetadata`). */
function validateEnvelope(event) {
  const eligible = SURFACE_TYPES.has(event.type);
  if (!eligible) {
    if (event.surfaceOp !== undefined)
      fail(`"${event.type}" is not surface-eligible and cannot carry surfaceOp`);
    if (event.sourceEventSeqs !== undefined)
      fail(`"${event.type}" is not surface-eligible and cannot carry sourceEventSeqs`);
    return;
  }
  const op = event.surfaceOp;
  if (op === undefined) fail(`"${event.type}" is surface-eligible and requires a surfaceOp marker`);
  if (op === "append") return;
  if (!isRecord(op) || op.op !== "replace")
    fail(`"${event.type}" carries an invalid replace surfaceOp`);
  count(op.startSeq, "replacement start");
  count(op.endSeq, "replacement end");
  if (op.startSeq >= event.seq || op.endSeq >= event.seq)
    fail("surface replace at seq " + event.seq + ": startSeq and endSeq must reference earlier events");
  // assertSourceEventReferences
  if (event.type === "assistant/message" && event.sourceEventSeqs !== undefined)
    fail("assistant/message embeds its source stream and cannot carry sourceEventSeqs");
  const raw = event.sourceEventSeqs;
  if (raw !== undefined) {
    if (!Array.isArray(raw)) fail("sourceEventSeqs must be an array when present");
    if (raw.length === 0) fail("sourceEventSeqs must not be empty");
    const sources = new Set();
    for (const source of raw) {
      count(source, "sourceEventSeqs entry");
      sources.add(source);
      if (source >= event.seq)
        fail(`sourceEventSeqs must reference earlier events: ${source} >= ${event.seq}`);
    }
    if (sources.size !== raw.length) fail("sourceEventSeqs must not contain duplicates");
  }
  if (event.type === "system/message") assertSystemMessageFields(event);
}

/** system-message.ts `assertV4SystemMessageFields`, essentials only. */
function assertSystemMessageFields(event) {
  const data = event.data;
  if (!isRecord(data)) fail("system/message data requires an object");
  if (count(data.turn, "system/message turn") === 0) fail("system/message turn must be positive");
  if (count(data.step, "system/message step") === 0) fail("system/message step must be positive");
  const message = data.message;
  if (!isRecord(message)) fail("system message requires an object");
  if (typeof message.id !== "string" || message.id.length === 0)
    fail("system message id requires a string with content");
  if (message.role !== "system") fail("system message requires system role");
  if (!Array.isArray(message.content)) fail("system message requires content array");
}

function requireTurn(state, event) {
  if (state.turn === null) fail(`${event.type} is outside an open turn`);
}

function requireStep(state, event) {
  if (
    state.turn === null ||
    state.step === null ||
    event.data.turn !== state.turn ||
    event.data.step !== state.step
  )
    fail(`${event.type} does not match an open turn and step`);
}

function closeTools(state, type) {
  if (state.tools.size !== 0)
    fail(`${type} leaves unresolved tool call ${String(state.tools.keys().next().value)}`);
}

/** relationships.ts `foldSurface`: protected head, range membership, sources. */
function foldSurface(state, event) {
  if (!SURFACE_TYPES.has(event.type)) return;
  if (event.type === "system/message" && state.surface.length > 0 && state.protectedHead === undefined)
    fail("system/message requires a protected first surface head");
  if (event.surfaceOp === "append") {
    if (event.type === "system/message" && state.surface.length === 0)
      state.protectedHead = event.seq;
    state.surface.push(event.seq);
    return;
  }
  const first = state.surface.indexOf(event.surfaceOp.startSeq);
  const last = state.surface.indexOf(event.surfaceOp.endSeq);
  if (first < 0 || last < first) fail(`${event.type} replacement range is not on the current surface`);
  const removed = state.surface.slice(first, last + 1);
  const sources = new Set(event.sourceEventSeqs ?? []);
  if (removed.some((seq) => !sources.has(seq)))
    fail("replacement sourceEventSeqs omit a shadowed surface node");
  if (state.protectedHead !== undefined && removed.includes(state.protectedHead)) {
    if (event.type !== "system/message" || removed.length !== 1)
      fail("surface replacement cannot shadow the protected system head");
    state.protectedHead = event.seq;
  }
  state.surface.splice(first, removed.length, event.seq);
}

/** relationships.ts `tool`: advertisement, invocation, resolution. */
function toolRules(state, event) {
  // A rewritten tool/result only needs an open turn (compaction/prune shape).
  if (event.type === "tool/result" && event.surfaceOp !== "append") {
    requireTurn(state, event);
    return;
  }
  requireStep(state, event);
  if (event.type === "assistant/message") {
    for (const block of event.data.message?.content ?? []) {
      if (block?.type !== "tool-call") continue;
      if (state.tools.has(block.id))
        fail(`assistant/message repeats advertised tool call ${block.id}`);
      state.tools.set(block.id, {
        name: block.name,
        arguments: block.arguments,
        started: false,
      });
    }
    return;
  }
  const message = event.type === "tool/result" ? event.data.message : undefined;
  const id = message === undefined ? event.data.callId : message.toolCallId;
  const pending = state.tools.get(id);
  if (pending === undefined) fail(`${event.type} ${id} has no advertised tool lifecycle`);
  if (message === undefined) {
    if (
      pending.started ||
      pending.name !== event.data.name ||
      pending.arguments !== event.data.arguments
    )
      fail(`tool/call ${id} does not match one advertised tool call`);
    pending.started = true;
  } else {
    if (!pending.started) fail(`tool/result ${id} is not the exact TOOL_NOT_STARTED repair`);
    state.tools.delete(id);
  }
}

/** relationships.ts `compact` + `span`: the compaction transaction. */
function compactionRules(state, event) {
  if (event.type === "compaction/prune" || event.type === "compaction/summary")
    compactionSpan(state, event);
  if (event.type === "compaction/prune") return;
  if (event.type === "compaction/start") {
    if (state.compaction !== undefined) fail("compaction/start overlaps an open compaction");
    const owner = event.data.turn === null ? null : count(event.data.turn, "compaction turn");
    if (owner !== state.turn) fail("compaction/start does not match the open turn");
    state.compaction = {
      id: event.data.compactionId,
      command: event.data.sourceCommandId,
      turn: owner,
      seq: event.seq,
      summarized: false,
    };
    return;
  }
  const current = compactionOwner(state, event.data, event.type);
  if (current.turn !== state.turn) fail(`${event.type} does not match the open turn`);
  if (event.type === "compaction/summary") {
    if (current.summarized) fail("compaction/summary repeats");
    current.summarized = true;
  } else {
    if (event.data.turn !== current.turn) fail("compaction/end changes its owner turn");
    if (event.data.error === undefined && !current.summarized)
      fail("successful compaction/end requires one summary");
    state.compaction = undefined;
  }
}

function compactionOwner(state, data, subject) {
  if (
    state.compaction === undefined ||
    state.compaction.id !== data.compactionId ||
    state.compaction.command !== data.sourceCommandId
  )
    fail(`${subject} has no matching compaction/start`);
  return state.compaction;
}

function compactionSpan(state, event) {
  const range = event.data.shadowedRange;
  if (!isRecord(range)) fail(`${event.type} shadowedRange requires an object`);
  const start = state.surface.indexOf(range.start);
  const end = state.surface.indexOf(range.end);
  const seqs = event.data.shadowedSeqs;
  const exact =
    start >= 0 &&
    end >= start &&
    Array.isArray(seqs) &&
    state.surface.slice(start, end + 1).every((seq, index) => seq === seqs[index]) &&
    seqs.length === end - start + 1;
  if (!exact) fail(`${event.type} shadowedSeqs do not name an exact current surface span`);
  if (state.protectedHead !== undefined && seqs.includes(state.protectedHead))
    fail("compaction cannot shadow the protected system head");
}
