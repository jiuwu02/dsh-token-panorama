/**
 * Session-verification tests: every event this plugin writes is replayed
 * through a faithful mirror of the platform's stored-log format rules.
 *
 * This is the regression suite for the session-3509f8b6 bug class: a delete
 * tombstone stamped with stale turn/step and written after `turn/end`, which
 * made the whole session refuse to load. The rules mirrored in
 * `./session-format.mjs` are the platform's own (`relationships.ts`,
 * `system-message.ts`, `surface.ts` — every rule cited there), so a write
 * that would corrupt a real session fails these tests instead.
 *
 * The fixtures are full-fidelity: turn/step lifecycle around every write,
 * tool-call advertisement before results, and the system head as the first
 * surface node. The plugin's own writes are validated at append time by the
 * fake session, so a violation fails at the exact operation that caused it.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

process.env.DSH_LANG = "en";
const scratch = (() => {
  try {
    return mkdtempSync(join(tmpdir(), "dsh-token-panorama-verify-"));
  } catch {
    const local = join(
      dirname(dirname(fileURLToPath(import.meta.url))),
      ".tmp-test",
    );
    mkdirSync(local, { recursive: true });
    return mkdtempSync(join(local, "verify-"));
  }
})();
process.env.DSH_HOME = scratch;
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const load = (relative) => import(pathToFileURL(join(root, relative)).href);
const {
  deleteChatNode,
  deleteChatNodes,
  clearThroughNode,
  undoDelete,
  flushPendingTombstones,
  hiddenRowKeysForSession,
  rowInfo,
  turnRows,
  nodeMarkdown,
  nodeEvents,
} = await load("lib/contextops.js");
const { validateStoredLog } = await load("test/session-format.mjs");

// --- fixtures: full-fidelity events in valid stored shape -------------------

const key = (kind, id) => `${kind.length}:${kind}${id}`;

const turnStart = (turn) => ({ type: "turn/start", data: { turn }, logOnly: true });
const turnEnd = (turn) => ({ type: "turn/end", data: { turn }, logOnly: true });
const stepStart = (turn, step) => ({
  type: "step/start",
  data: { turn, step },
  logOnly: true,
});
const stepEnd = (turn, step) => ({
  type: "step/end",
  data: { turn, step },
  logOnly: true,
});
const sysHead = () => ({
  type: "system/message",
  data: {
    turn: 1,
    step: 1,
    message: {
      id: "sys",
      role: "system",
      content: [{ type: "text", text: "prompt" }],
      source: { kind: "system-prompt" },
    },
  },
});
const userMsg = (id, text = "hi") => ({
  type: "user/message",
  data: {
    id,
    role: "user",
    content: [{ type: "text", text }],
    source: { kind: "user" },
  },
});
const toolBlock = (id) => ({ type: "tool-call", id, name: "bash", arguments: "{}" });
const assistantMsg = (turn, step, blocks) => ({
  type: "assistant/message",
  data: {
    turn,
    step,
    message: {
      id: `a-${turn}-${step}`,
      role: "assistant",
      content: blocks,
      source: { kind: "model", provider: "p", model: "m" },
    },
    stream: [],
  },
});
const toolCall = (id, turn, step) => ({
  type: "tool/call",
  data: { turn, step, callId: id, name: "bash", arguments: "{}" },
  logOnly: true,
});
const toolResult = (id, turn, step) => ({
  type: "tool/result",
  data: {
    turn,
    step,
    message: {
      id: `r-${id}`,
      role: "tool",
      content: [{ type: "text", text: "ok" }],
      source: { kind: "tool", callId: id },
      toolCallId: id,
    },
  },
});
const retryReceipt = (turn, step, retryId) => ({
  type: "llm/retry",
  data: { turn, step, retryId, retry: 1, provider: "p", policyKey: "policy" },
  logOnly: true,
});

/**
 * A fake session that validates its own log at append time: whatever the
 * plugin writes is immediately replayed through the platform's format
 * rules, so a violation fails at the operation that caused it.
 */
function makeVerifiedSession(id, events) {
  const log = [];
  const nodes = [];
  const session = {
    id,
    seq: 0,
    surface: { nodes },
    eventAt: (seq) => log[seq],
    append(type, data, opts) {
      const op = opts?.surfaceOp;
      const event = {
        type,
        seq: log.length,
        time: 0,
        data,
        ...(op === undefined ? {} : { surfaceOp: op }),
        ...(opts?.sourceEventSeqs === undefined
          ? {}
          : { sourceEventSeqs: [...opts.sourceEventSeqs] }),
      };
      log.push(event);
      session.seq = log.length;
      if (op === "append") {
        nodes.push(event.seq);
      } else if (op !== undefined) {
        const start = nodes.indexOf(op.startSeq);
        const end = nodes.indexOf(op.endSeq);
        assert.ok(
          start !== -1 && end !== -1 && start <= end,
          "a replace must name a current surface range",
        );
        nodes.splice(start, end - start + 1, event.seq);
      }
      // The whole point of this file: a write that would make the stored
      // session unreadable must fail here, not in a user's log.
      validateStoredLog(log);
      return event;
    },
  };
  for (const event of events)
    session.append(event.type, event.data, {
      ...(event.logOnly === true
        ? {}
        : { surfaceOp: event.surfaceOp ?? "append" }),
    });
  return session;
}

let sessionCounter = 0;
const freshId = () => `s-verify-${(sessionCounter += 1)}`;

const fakeCtx = () => ({
  get: (name) => (name === "sessions" ? { flush: async () => {} } : undefined),
  logger: undefined,
  tokenMeter: {
    measure: (session) => ({
      nodes: session.surface.nodes.map((seq) => ({
        seq,
        heuristicTokens: 10,
        tokens: 10,
      })),
    }),
    estimateMessage: () => 1,
  },
});
const agentOf = (session) => ({ session });

/** Sorted copy, for key-set equality independent of order. */
const sorted = (keys) => [...keys].sort();

/**
 * Raw fixture events to stored events: surface-eligible types carry their
 * marker, log-only lifecycle rows carry none — exactly what the fake
 * session's append would have produced.
 */
const toEvents = (list) =>
  list.map((raw, seq) => ({
    seq,
    time: 0,
    ...raw,
    ...(raw.logOnly === true || raw.surfaceOp !== undefined
      ? {}
      : { surfaceOp: "append" }),
  }));

// --- 0. the harness proves it can catch the bug class itself ---------------
{
  // The exact session-3509f8b6 shape: a delete tombstone whose turn and step
  // name a turn that has already closed. The platform refused to load the
  // session; the harness must refuse this log.
  const bad = toEvents([
    { type: "turn/start", data: { turn: 1 }, logOnly: true },
    { type: "step/start", data: { turn: 1, step: 1 }, logOnly: true },
    { ...sysHead() },
    { ...userMsg("u1") },
    { type: "step/end", data: { turn: 1, step: 1 }, logOnly: true },
    { type: "turn/end", data: { turn: 1 }, logOnly: true },
    {
      type: "system/message",
      data: {
        turn: 1,
        step: 1,
        message: {
          id: "tomb",
          role: "system",
          content: [],
          source: { kind: "system-prompt", origin: "delete" },
        },
      },
      surfaceOp: { op: "replace", startSeq: 3, endSeq: 3 },
      sourceEventSeqs: [3],
    },
  ]);
  assert.throws(
    () => validateStoredLog(bad),
    /does not match an open turn and step/,
    "the harness must catch the stale-coordinates tombstone of session-3509f8b6",
  );
  // A zero turn/step is rejected too (assertV4SystemMessageFields).
  const zeroTurn = bad.map((event, index) =>
    index === 6 ? { ...event, data: { ...event.data, turn: 0, step: 0 } } : event,
  );
  assert.throws(() => validateStoredLog(zeroTurn), /must be positive/);
  // A replacement whose sources omit a shadowed node is rejected.
  const missingSource = bad.map((event, index) =>
    index === 6 ? { ...event, sourceEventSeqs: [] } : event,
  );
  assert.throws(() => validateStoredLog(missingSource), /sourceEventSeqs/);
  // A healthy compaction transaction passes: the mirror is not a blanket
  // rejecter and the plugin's checkpoint shape is proven valid here.
  const healthy = toEvents([
    { type: "turn/start", data: { turn: 1 }, logOnly: true },
    { type: "step/start", data: { turn: 1, step: 1 }, logOnly: true },
    { ...sysHead() },
    { ...userMsg("u1") },
    { ...assistantMsg(1, 1, [{ type: "text", text: "a" }]) },
    {
      type: "compaction/start",
      data: { compactionId: "k1", turn: 1 },
      logOnly: true,
    },
    {
      type: "compaction/summary",
      data: {
        compactionId: "k1",
        turn: 1,
        summary: [],
        shadowedRange: { start: 3, end: 4 },
        shadowedSeqs: [3, 4],
      },
      logOnly: true,
    },
    {
      type: "user/message",
      data: {
        id: "cp-k1",
        role: "user",
        content: [{ type: "text", text: "summary" }],
        source: { kind: "compact-checkpoint", compactionId: "k1" },
      },
      surfaceOp: { op: "replace", startSeq: 3, endSeq: 4 },
      sourceEventSeqs: [3, 4],
    },
    {
      type: "compaction/end",
      data: { compactionId: "k1", turn: 1 },
      logOnly: true,
    },
  ]);
  validateStoredLog(healthy);
}

// --- 1. a delete inside an open step lands immediately, validly ------------
{
  const session = makeVerifiedSession(freshId(), [
    turnStart(1),
    stepStart(1, 1),
    sysHead(),
    userMsg("u1"),
    assistantMsg(1, 1, [{ type: "text", text: "answer" }]),
  ]);
  const result = await deleteChatNode(
    fakeCtx(),
    agentOf(session),
    { nodeKey: key("input-message", "u1") },
  );
  assert.ok(result !== null);
  // The tombstone names the open step's coordinates, not a stale copy.
  const tombstone = session.eventAt(session.seq - 1);
  assert.equal(tombstone.type, "system/message");
  assert.equal(tombstone.data.turn, 1);
  assert.equal(tombstone.data.step, 1);
  assert.equal(tombstone.data.message.source.origin, "delete");
  // An immediate landing is not undoable: nothing is queued.
  assert.deepEqual(result.queuedRunIds, []);
  assert.ok(result.hiddenKeys.includes(key("input-message", "u1")));
  validateStoredLog(
    Array.from({ length: session.seq }, (_, seq) => session.eventAt(seq)),
  );
}

// --- 2. a delete while no step is open writes NOTHING (bug regression) -----
let queuedSession;
let queuedAnswer;
{
  const session = makeVerifiedSession(freshId(), [
    turnStart(1),
    stepStart(1, 1),
    sysHead(),
    userMsg("u1"),
    assistantMsg(1, 1, [{ type: "text", text: "answer" }]),
    stepEnd(1, 1),
    turnEnd(1),
  ]);
  const before = session.seq;
  const result = await deleteChatNode(
    fakeCtx(),
    agentOf(session),
    { nodeKey: key("input-message", "u1") },
  );
  assert.ok(result !== null);
  // The regression of session-3509f8b6: nothing may be appended while the
  // turn is closed — a tombstone here carried stale coordinates and made
  // the session unloadable.
  assert.equal(session.seq, before, "a delete outside an open step must not write");
  assert.equal(result.queuedRunIds.length, 1);
  assert.equal(typeof result.undoGroup, "string");
  // The view still hides the row at once, from the queued keys.
  assert.ok(result.hiddenKeys.includes(key("input-message", "u1")));
  queuedSession = session;
  queuedAnswer = result;
}

// --- 3. the queued tombstone lands at the next step, with fresh coordinates -
{
  const session = queuedSession;
  // The next turn opens, and its first step is where the run lands.
  session.append("turn/start", { turn: 2 }, {});
  session.append("step/start", { turn: 2, step: 1 }, {});
  flushPendingTombstones(fakeCtx(), session);
  const tombstone = session.eventAt(session.seq - 1);
  assert.equal(tombstone.type, "system/message");
  assert.equal(tombstone.data.turn, 2, "the tombstone must name the new turn");
  assert.equal(tombstone.data.step, 1);
  assert.equal(tombstone.data.message.source.origin, "delete");
  // What the delete answered while queued matches what a reload derives
  // once the tombstone has landed: the view never flickers.
  assert.deepEqual(
    sorted(queuedAnswer.hiddenKeys),
    sorted(hiddenRowKeysForSession(session)),
  );
  // And the landed delete cannot be undone.
  await assert.rejects(
    () => undoDelete(fakeCtx(), agentOf(session)),
    /no delete to undo/,
  );
}

// --- 4. undo before landing restores exactly ------------------------------
{
  const session = makeVerifiedSession(freshId(), [
    turnStart(1),
    stepStart(1, 1),
    sysHead(),
    userMsg("u1"),
    assistantMsg(1, 1, [{ type: "text", text: "answer" }]),
    stepEnd(1, 1),
    turnEnd(1),
  ]);
  const before = session.seq;
  await deleteChatNode(fakeCtx(), agentOf(session), {
    nodeKey: key("input-message", "u1"),
  });
  const undone = await undoDelete(fakeCtx(), agentOf(session));
  assert.equal(undone.undone, 1);
  assert.equal(undone.items, 1);
  // Nothing was ever written: the rows come back with no residue at all.
  assert.equal(session.seq, before);
  assert.deepEqual(undone.hiddenKeys, []);
  await assert.rejects(
    () => undoDelete(fakeCtx(), agentOf(session)),
    /no delete to undo/,
  );
}

// --- 5. undo drops only the latest group ---------------------------------
{
  const session = makeVerifiedSession(freshId(), [
    turnStart(1),
    stepStart(1, 1),
    sysHead(),
    userMsg("u1"),
    userMsg("u2"),
    assistantMsg(1, 1, [{ type: "text", text: "answer" }]),
    stepEnd(1, 1),
    turnEnd(1),
  ]);
  await deleteChatNode(fakeCtx(), agentOf(session), {
    nodeKey: key("input-message", "u1"),
  });
  await deleteChatNode(fakeCtx(), agentOf(session), {
    nodeKey: key("input-message", "u2"),
  });
  const undone = await undoDelete(fakeCtx(), agentOf(session));
  assert.equal(undone.undone, 1, "undo pops the latest delete only");
  assert.deepEqual(
    sorted(undone.hiddenKeys),
    [key("input-message", "u1")],
    "the earlier delete stays queued and hidden",
  );
  const rest = await undoDelete(fakeCtx(), agentOf(session));
  assert.equal(rest.undone, 1);
  assert.deepEqual(rest.hiddenKeys, []);
}

// --- 6. clear-through replaces everything above with one valid run --------
{
  const session = makeVerifiedSession(freshId(), [
    turnStart(1),
    stepStart(1, 1),
    sysHead(),
    userMsg("u1"),
    assistantMsg(1, 1, [{ type: "text", text: "first" }]),
    stepEnd(1, 1),
    stepStart(1, 2),
    userMsg("u2"),
    assistantMsg(1, 2, [{ type: "text", text: "second" }]),
  ]);
  const result = await clearThroughNode(fakeCtx(), agentOf(session), {
    nodeKey: key("input-message", "u2"),
  });
  assert.ok(result !== null);
  assert.equal(result.items, 2, "the balanced history above: u1 and its reply");
  // The step is open (step 2 never closed), so the tombstone lands at once.
  const tombstone = session.eventAt(session.seq - 1);
  assert.equal(tombstone.type, "system/message");
  assert.equal(tombstone.data.turn, 1);
  assert.equal(tombstone.data.step, 2);
  assert.deepEqual(
    sorted(result.hiddenKeys),
    sorted([key("assistant-step", "1:1"), key("input-message", "u1")]),
  );
  // u2 and its reply survive untouched.
  assert.ok(session.surface.nodes.includes(7));
  validateStoredLog(
    Array.from({ length: session.seq }, (_, seq) => session.eventAt(seq)),
  );
}

// --- 7. batch delete merges overlapping runs and keeps gaps ---------------
{
  const session = makeVerifiedSession(freshId(), [
    turnStart(1),
    stepStart(1, 1),
    sysHead(), // 0
    userMsg("u1"), // 1
    assistantMsg(1, 1, [toolBlock("c1")]), // 2
    toolCall("c1", 1, 1), // log-only
    toolResult("c1", 1, 1), // 3
    stepEnd(1, 1),
    stepStart(1, 2),
    userMsg("u2"), // 4
    assistantMsg(1, 2, [{ type: "text", text: "second" }]), // 5
  ]);
  // The assistant step and its tool row expand to the same run: one run.
  const merged = await deleteChatNodes(fakeCtx(), agentOf(session), {
    nodeKeys: [key("assistant-step", "1:1"), key("tool-call", "c1")],
  });
  assert.equal(merged.runs, 1, "overlapping expansions merge into one run");
  assert.equal(merged.items, 2);
  // u1 is the run's neighbour, not its member: it must survive.
  assert.ok(session.surface.nodes.includes(3));
  assert.deepEqual(
    sorted(merged.hiddenKeys),
    sorted([key("assistant-step", "1:1"), key("tool-call", "c1")]),
  );
  validateStoredLog(
    Array.from({ length: session.seq }, (_, seq) => session.eventAt(seq)),
  );
}
{
  const session = makeVerifiedSession(freshId(), [
    turnStart(1),
    stepStart(1, 1),
    sysHead(), // 2
    userMsg("u1"), // 3
    assistantMsg(1, 1, [{ type: "text", text: "first" }]), // 4
    stepEnd(1, 1),
    stepStart(1, 2),
    userMsg("u2"), // 7
    assistantMsg(1, 2, [{ type: "text", text: "second" }]), // 8
    stepEnd(1, 2),
    turnEnd(1),
  ]);
  const before = session.seq;
  // Two disjoint selections with rows between them: two runs, one undo
  // group, and the rows in the middle untouched.
  const result = await deleteChatNodes(fakeCtx(), agentOf(session), {
    nodeKeys: [key("input-message", "u1"), key("input-message", "u2")],
  });
  assert.equal(result.runs, 2, "disjoint runs stay separate");
  assert.equal(result.items, 2);
  assert.equal(session.seq, before, "no step open: both runs stay queued");
  assert.equal(result.queuedRunIds.length, 2);
  assert.ok(
    session.surface.nodes.includes(4),
    "the reply between the two selections survives",
  );
  assert.ok(session.surface.nodes.includes(8), "the reply below survives");
  // One undo covers the whole batch.
  const undone = await undoDelete(fakeCtx(), agentOf(session));
  assert.equal(undone.undone, 2);
  assert.deepEqual(undone.hiddenKeys, []);
}

// --- 8. read-only row helpers stay within the format's own view ----------
{
  const session = makeVerifiedSession(freshId(), [
    turnStart(1),
    stepStart(1, 1),
    sysHead(), // 0
    userMsg("u1"), // 1
    assistantMsg(1, 1, [toolBlock("c1")]), // 2
    toolCall("c1", 1, 1),
    toolResult("c1", 1, 1), // 3
    retryReceipt(1, 1, "retry-1"),
    stepEnd(1, 1),
    turnEnd(1),
  ]);
  const ctx = fakeCtx();
  const info = rowInfo(ctx, session, key("input-message", "u1"));
  assert.equal(info.rowTokens, 10);
  assert.equal(info.uptoTokens, 20, "head + the row itself, in surface order");
  assert.equal(info.totalTokens, 40);
  assert.equal(info.canClear, false, "the first content row has nothing above");
  const toolInfo = rowInfo(ctx, session, key("tool-call", "c1"));
  assert.equal(toolInfo.rowTokens, 20, "the call block and its result");
  assert.equal(toolInfo.canClear, true);
  const rows = turnRows(session, key("input-message", "u1"));
  assert.equal(rows.turn, 1);
  assert.deepEqual(rows.keepCandidates, [
    key("input-message", "u1"),
    key("assistant-step", "1:1"),
    key("tool-call", "c1"),
    key("tool-call", "c1"),
  ]);
  assert.ok(rows.keys.includes(key("model-retry", "retry-1")));
  assert.ok(rows.keys.includes(key("turn-tail", "1")));
  assert.ok(rows.keys.includes(key("tool-call", "c1")));
  const markdown = nodeMarkdown(session, key("tool-call", "c1"));
  assert.ok(markdown.includes("Tool call"));
  assert.ok(markdown.includes("Tool result"));
  const events = nodeEvents(session, key("input-message", "u1"));
  assert.equal(events.length, 1);
  assert.equal(events[0].seq, 3);
  // A row that maps to nothing answers null rather than a broken menu.
  assert.equal(rowInfo(ctx, session, key("input-message", "gone")), null);
  assert.equal(turnRows(session, key("input-message", "gone")), null);
}

// --- 9. clear-through on the first row has nothing to do -----------------
{
  const session = makeVerifiedSession(freshId(), [
    turnStart(1),
    stepStart(1, 1),
    sysHead(),
    userMsg("u1"),
  ]);
  const result = await clearThroughNode(fakeCtx(), agentOf(session), {
    nodeKey: key("input-message", "u1"),
  });
  assert.equal(result, null, "nothing balanced sits above the first row");
}

rmSync(scratch, { recursive: true, force: true });
console.log("session-verify: all scenarios passed");
