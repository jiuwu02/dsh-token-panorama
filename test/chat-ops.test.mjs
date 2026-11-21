/**
 * Chat row targeting: key parsing, surface mapping, delete-run expansion and
 * the "compact to here" cut (Q1–Q3 of the right-click menu).
 *
 * The session is a small in-memory fold with the same surface semantics the
 * platform's `replace` operation has: appends land at the tail and a replace
 * splices one node in for the range it names. Everything asserted here is the
 * contract the Host routes rely on — a change that breaks these cases breaks
 * the menu in the running GUI.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Plugin state (the task-lock file) redirects into a throwaway directory
// before any module computes its storage dir. The refusal messages asserted
// below are the English dictionary's, so the language is pinned: a zh-CN host
// would otherwise translate them.
process.env.DSH_LANG = "en";
const scratch = (() => {
  try {
    return mkdtempSync(join(tmpdir(), "dsh-token-panorama-chat-"));
  } catch {
    const local = join(
      dirname(dirname(fileURLToPath(import.meta.url))),
      ".tmp-test",
    );
    mkdirSync(local, { recursive: true });
    return mkdtempSync(join(local, "chat-"));
  }
})();
process.env.DSH_HOME = scratch;
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const load = (relative) => import(pathToFileURL(join(root, relative)).href);
const {
  parseChatNodeKey,
  resolveChatNodeSeqs,
  expandDeleteRun,
  selectSpanBefore,
  deleteChatNode,
  compactThroughNode,
  flushPendingTombstones,
  hiddenRowKeys,
} = await load("lib/contextops.js");

// --- fixtures ---------------------------------------------------------------

/** The platform's node key: `${kind.length}:${kind}${id}`. */
const key = (kind, id) => `${kind.length}:${kind}${id}`;

const systemMsg = () => ({
  type: "system/message",
  data: {
    turn: 0,
    step: 0,
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
const toolBlock = (id) => ({
  type: "tool-call",
  id,
  name: "bash",
  arguments: "{}",
});
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
const toolResult = (callId, turn, step) => ({
  type: "tool/result",
  data: {
    turn,
    step,
    message: {
      id: `r-${callId}`,
      role: "tool",
      content: [{ type: "text", text: "ok" }],
      source: { kind: "tool", callId },
      toolCallId: callId,
    },
  },
});
const checkpoint = (compactionId, sourceCommandId) => ({
  type: "user/message",
  data: {
    id: `cp-${compactionId}`,
    role: "user",
    content: [{ type: "text", text: "summary" }],
    source: {
      kind: "compact-checkpoint",
      compactionId,
      ...(sourceCommandId === undefined ? {} : { sourceCommandId }),
    },
  },
});

/**
 * The engine's open turn and step appended at the tail of a fixture: a stored
 * `system/message` must match one at its own log position, so a delete's
 * tombstone can only land inside it. Log-only, so surface indexes of the
 * content before them are unchanged.
 */
const openStep = () => [
  { type: "turn/start", data: { turn: 1 }, logOnly: true },
  { type: "step/start", data: { turn: 1, step: 1 }, logOnly: true },
];

/**
 * A minimal session with the platform's surface semantics: appends land at
 * the tail, a replace splices its range out and its own seq in, and an event
 * without `surfaceOp` stays log-only (no surface node), exactly as the
 * platform's append validation demands.
 * @param events - the event payloads to append in order; an entry carrying
 *   `logOnly` is recorded without entering the surface.
 * @returns the fake session.
 */
function makeSession(events) {
  const log = [];
  const nodes = [];
  const session = {
    id: "s-test",
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
        return event;
      }
      if (op === undefined) return event;
      const start = nodes.indexOf(op.startSeq);
      const end = nodes.indexOf(op.endSeq);
      assert.ok(
        start !== -1 && end !== -1 && start <= end,
        "a replace must name a current surface range",
      );
      nodes.splice(start, end - start + 1, event.seq);
      return event;
    },
  };
  for (const event of events)
    session.append(event.type, event.data, {
      ...(event.logOnly === true
        ? {}
        : { surfaceOp: event.surfaceOp ?? "append" }),
      ...(event.sourceEventSeqs === undefined
        ? {}
        : { sourceEventSeqs: event.sourceEventSeqs }),
    });
  return session;
}

/** The Host context the delete path needs: a lock dir, a meter and a flush. */
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

// --- 1. parseChatNodeKey reads the engine's length-prefixed keys ------------
assert.deepEqual(parseChatNodeKey(key("input-message", "u1")), {
  kind: "input-message",
  id: "u1",
});
// The id may contain colons: the length prefix is what keeps it whole.
assert.deepEqual(parseChatNodeKey(key("assistant-step", "12:3")), {
  kind: "assistant-step",
  id: "12:3",
});
assert.deepEqual(parseChatNodeKey(key("tool-call", "call-1")), {
  kind: "tool-call",
  id: "call-1",
});
assert.equal(parseChatNodeKey(""), null);
assert.equal(parseChatNodeKey("no-colon"), null);
assert.equal(parseChatNodeKey("0:x"), null);
// A length that overshoots the rest of the key is not a key of ours.
assert.equal(parseChatNodeKey("9:short"), null);

// --- 2. resolveChatNodeSeqs mirrors the chat's own node Definitions ---------
const session = makeSession([
  systemMsg(), // 0
  userMsg("u1"), // 1
  assistantMsg(1, 1, [{ type: "text", text: "answer" }]), // 2
  userMsg("u2"), // 3
  assistantMsg(1, 2, [toolBlock("c1")]), // 4
  toolResult("c1", 1, 2), // 5
  checkpoint("k1"), // 6
  checkpoint("k2", "cmd-9"), // 7
]);
assert.deepEqual(resolveChatNodeSeqs(session, key("input-message", "u1")), [1]);
assert.deepEqual(resolveChatNodeSeqs(session, key("input-message", "u2")), [3]);
assert.deepEqual(
  resolveChatNodeSeqs(session, key("assistant-step", "1:1")),
  [2],
);
// A tool row stands for the call block inside its message and its result.
assert.deepEqual(resolveChatNodeSeqs(session, key("tool-call", "c1")), [4, 5]);
// The unknown-surface fallback is keyed by the literal seq.
assert.deepEqual(resolveChatNodeSeqs(session, key("unknown-surface", "3")), [3]);
// Compaction cards are keyed by compaction id / the folded command id.
assert.deepEqual(resolveChatNodeSeqs(session, key("compaction", "k1")), [6]);
assert.deepEqual(resolveChatNodeSeqs(session, key("command", "cmd-9")), [7]);
// Log-only rows (here: any kind with no surface mapping) resolve to nothing.
assert.equal(resolveChatNodeSeqs(session, key("model-retry", "r1")), null);
assert.equal(resolveChatNodeSeqs(session, key("input-message", "gone")), null);
assert.equal(resolveChatNodeSeqs(session, "not-a-key"), null);

// --- 3. expandDeleteRun closes every tool-call/result pair it touches -------
// A lone user message is its own run.
assert.deepEqual(expandDeleteRun(session, [1]), {
  start: 1,
  end: 1,
  shadowedSeqs: [1],
});
// An assistant message that calls tools cannot outlive its result: deleting
// the call (or the result) takes the message and the result together.
assert.deepEqual(expandDeleteRun(session, [5]), {
  start: 4,
  end: 5,
  shadowedSeqs: [4, 5],
});
// A multi-call message expands to the whole call group from either edge.
const grouped = makeSession([
  systemMsg(), // 0
  assistantMsg(1, 1, [toolBlock("a"), toolBlock("b")]), // 1
  toolResult("a", 1, 1), // 2
  toolResult("b", 1, 1), // 3
  userMsg("u1"), // 4
]);
assert.deepEqual(expandDeleteRun(grouped, [3]), {
  start: 1,
  end: 3,
  shadowedSeqs: [1, 2, 3],
});
assert.deepEqual(expandDeleteRun(grouped, [2]), {
  start: 1,
  end: 3,
  shadowedSeqs: [1, 2, 3],
});
// Nothing sits above a system prompt, so the run can never swallow node 0.
assert.deepEqual(expandDeleteRun(grouped, [1]), {
  start: 1,
  end: 3,
  shadowedSeqs: [1, 2, 3],
});
// A result whose sibling has not landed yet belongs to a running call group:
// no balanced cut exists at or after it, so there is nothing safe to delete.
const running = makeSession([
  systemMsg(), // 0
  assistantMsg(1, 1, [toolBlock("a"), toolBlock("b")]), // 1
  toolResult("a", 1, 1), // 2
]);
assert.equal(expandDeleteRun(running, [2]), null);
// Targets no longer on the surface (a stale menu) simply do not resolve.
assert.equal(expandDeleteRun(grouped, [99]), null);

// --- 4. selectSpanBefore cuts at the last balanced cut above the row -------
// "Compact to here" on u2: everything above u2 (the first exchange) compacts,
// while u2 and what follows stay verbatim.
assert.deepEqual(selectSpanBefore(session, 3), {
  start: 1,
  end: 2,
  shadowedSeqs: [1, 2],
});
// On the tool result: the open call above it is pulled into the span so the
// cut never splits the pair.
assert.deepEqual(selectSpanBefore(session, 5), {
  start: 1,
  end: 3,
  shadowedSeqs: [1, 2, 3],
});
// On the first content node there is nothing above to compact.
assert.equal(selectSpanBefore(session, 1), null);
assert.equal(selectSpanBefore(session, 0), null);
assert.equal(selectSpanBefore(session, 99), null);

// --- 5. deleteChatNode rewrites the run to an empty system tombstone -------
{
  const target = makeSession([
    systemMsg(), // 0
    userMsg("u1"), // 1
    assistantMsg(1, 1, [{ type: "text", text: "answer" }]), // 2
    userMsg("u2"), // 3
    ...openStep(), // 4-5
  ]);
  const result = await deleteChatNode(fakeCtx(), { session: target }, {
    nodeKey: key("input-message", "u1"),
  });
  assert.equal(result.items, 1);
  assert.equal(result.beforeTokens, 10);
  // The run is gone and one tombstone stands in its place.
  assert.deepEqual(target.surface.nodes, [0, 6, 2, 3]);
  const tomb = target.eventAt(6);
  assert.equal(tomb.type, "system/message");
  assert.equal(tomb.data.message.role, "system");
  assert.deepEqual(tomb.data.message.content, []);
  assert.equal(tomb.data.message.source.kind, "system-prompt");
  // The origin marker is what later reads of the log recognise a delete by.
  assert.equal(tomb.data.message.source.origin, "delete");
  // An empty system node projects to no message: the delete is real.
  assert.equal(tomb.data.message.content.length, 0);
  assert.deepEqual(tomb.surfaceOp, { op: "replace", startSeq: 1, endSeq: 1 });
  assert.deepEqual(tomb.sourceEventSeqs, [1]);
  // Coordinates come from the step the tombstone lands in, never from the
  // shadowed row (which carries none): the stored format rejects a
  // `system/message` naming anything but the open turn and step.
  assert.equal(tomb.data.turn, 1);
  assert.equal(tomb.data.step, 1);
}
{
  // Deleting a tool call takes its message and result together, as one run.
  const target = makeSession([
    systemMsg(), // 0
    userMsg("u1"), // 1
    assistantMsg(1, 1, [toolBlock("c1")]), // 2
    toolResult("c1", 1, 1), // 3
    userMsg("u2"), // 4
    ...openStep(), // 5-6
  ]);
  const result = await deleteChatNode(fakeCtx(), { session: target }, {
    nodeKey: key("tool-call", "c1"),
  });
  assert.equal(result.items, 2);
  assert.deepEqual(target.surface.nodes, [0, 1, 7, 4]);
  assert.deepEqual(target.eventAt(7).sourceEventSeqs, [2, 3]);
}
{
  // A compaction card deletes to its checkpoint.
  const target = makeSession([
    systemMsg(), // 0
    checkpoint("k1"), // 1
    userMsg("u1"), // 2
    ...openStep(), // 3-4
  ]);
  const result = await deleteChatNode(fakeCtx(), { session: target }, {
    nodeKey: key("compaction", "k1"),
  });
  assert.equal(result.items, 1);
  assert.deepEqual(target.surface.nodes, [0, 5, 2]);
}

// --- 6. the two refusals the menu reports verbatim -------------------------
await assert.rejects(
  deleteChatNode(fakeCtx(), { session }, {
    nodeKey: key("input-message", "gone"),
  }),
  /no longer in the current context/,
  "an unmapped row must be refused with the stale-target message",
);
await assert.rejects(
  deleteChatNode(fakeCtx(), { session: running }, {
    nodeKey: key("tool-call", "a"),
  }),
  /still running/,
  "a run with no balanced cut must be refused as in-progress",
);
await assert.rejects(
  deleteChatNode(fakeCtx(), { session }, { nodeKey: "not-a-key" }),
  /no longer in the current context/,
);

// --- 7. compactThroughNode keeps the row and everything below it -----------
// Nothing above the first content node: a null result, and no summarizer call.
assert.equal(
  await compactThroughNode(fakeCtx(), { session }, {
    nodeKey: key("input-message", "u1"),
  }),
  null,
);
await assert.rejects(
  compactThroughNode(fakeCtx(), { session }, {
    nodeKey: key("input-message", "gone"),
  }),
  /no longer in the current context/,
);

// --- 8. deleted rows leave the view (hidden row keys) ---------------------
// The transcript keeps replaced rows by platform design, so a delete answers
// which `data-chat-node-key` values the Client must hide: the run's own rows
// plus the log-only siblings they are built from.
{
  const target = makeSession([
    systemMsg(), // 0
    userMsg("u-old"), // 1, shadowed by the checkpoint below
    {
      ...checkpoint("k1", "cmd-9"),
      surfaceOp: { op: "replace", startSeq: 1, endSeq: 1 },
      sourceEventSeqs: [1],
    }, // 2
    {
      type: "llm/retry",
      data: { turn: 1, step: 1, retryId: "rr1" },
      logOnly: true,
    }, // 3
    assistantMsg(1, 1, [toolBlock("c1")]), // 4
    toolResult("c1", 1, 1), // 5
    userMsg("u1"), // 6
    { type: "plugin:demo/note", data: { note: "x" } }, // 7, unclaimed row
    ...openStep(), // 8-9
  ]);
  // A tool row deletes its reply: the step row, the tool row and the retry
  // receipts of the same step all leave the view together — and because that
  // emptied turn 1, its tail and process control go with them.
  const call = await deleteChatNode(fakeCtx(), { session: target }, {
    nodeKey: key("tool-call", "c1"),
  });
  assert.deepEqual(
    [...call.hiddenKeys].sort(),
    [
      key("assistant-step", "1:1"),
      key("model-retry", "rr1"),
      key("tool-call", "c1"),
      key("turn-tail", "1"),
      key("turn-process", "1"),
      key("turn-error", "1"),
      key("turn-max-tokens", "1"),
    ].sort(),
  );
  // A compaction card hides its marker and the folded command card — and
  // nothing else: a replacement checkpoint renders no input-message row.
  // The answer is cumulative: every delete so far, not just this one.
  const card = await deleteChatNode(fakeCtx(), { session: target }, {
    nodeKey: key("compaction", "k1"),
  });
  for (const expected of [key("command", "cmd-9"), key("compaction", "k1")])
    assert.ok(card.hiddenKeys.includes(expected), `hiddenKeys lost ${expected}`);
  assert.ok(
    !card.hiddenKeys.includes(key("input-message", "cp-k1")),
    "a replacement checkpoint has no input-message row to hide",
  );
  // A user row hides exactly its own bubble.
  const user = await deleteChatNode(fakeCtx(), { session: target }, {
    nodeKey: key("input-message", "u1"),
  });
  assert.ok(user.hiddenKeys.includes(key("input-message", "u1")));
  // An unclaimed append-surface row is keyed by its literal seq.
  const unknown = await deleteChatNode(fakeCtx(), { session: target }, {
    nodeKey: key("unknown-surface", "7"),
  });
  assert.ok(unknown.hiddenKeys.includes(key("unknown-surface", "7")));
  // Reading the finished log reproduces the full set the last delete answered
  // with: this is what a page reload derives.
  const events = [...Array(target.seq)].map((_, seq) => target.eventAt(seq));
  assert.deepEqual(
    [...hiddenRowKeys(events)].sort(),
    [...unknown.hiddenKeys].sort(),
  );
}

// --- 9. a delete made while no step is open waits for one -------------------
// A stored `system/message` must name an open turn and step, and the platform
// mints those numbers itself: writing the tombstone while idle is exactly what
// corrupted stored logs before. The run waits instead, hides at once, and
// lands inside the next step the engine opens.
{
  const target = makeSession([
    systemMsg(), // 0
    userMsg("u1"), // 1
    assistantMsg(1, 1, [{ type: "text", text: "answer" }]), // 2
  ]);
  const result = await deleteChatNode(fakeCtx(), { session: target }, {
    nodeKey: key("input-message", "u1"),
  });
  assert.equal(result.items, 1);
  // Nothing is written while idle: the stored log keeps a loadable shape.
  assert.deepEqual(target.surface.nodes, [0, 1, 2]);
  // The view hides the row at once, from the keys answered with the delete.
  assert.ok(result.hiddenKeys.includes(key("input-message", "u1")));
  // A repeat of the same gesture queues a second run over the same rows.
  await deleteChatNode(fakeCtx(), { session: target }, {
    nodeKey: key("input-message", "u1"),
  });
  // The engine opens the next step: the tombstone lands inside it, with that
  // step's coordinates — and the superseded duplicate is dropped, because its
  // rows are no longer on the surface to replace.
  target.append("turn/start", { turn: 2 });
  target.append("step/start", { turn: 2, step: 1 });
  assert.equal(flushPendingTombstones(fakeCtx(), target), true);
  assert.deepEqual(target.surface.nodes, [0, 5, 2]);
  const tomb = target.eventAt(5);
  assert.equal(tomb.type, "system/message");
  assert.equal(tomb.data.turn, 2);
  assert.equal(tomb.data.step, 1);
  assert.deepEqual(tomb.surfaceOp, { op: "replace", startSeq: 1, endSeq: 1 });
  // A reload derives the same hidden set the deletes answered with.
  const events = [...Array(target.seq)].map((_, seq) => target.eventAt(seq));
  assert.deepEqual([...hiddenRowKeys(events)].sort(), [...result.hiddenKeys].sort());
  // Nothing left to flush.
  assert.equal(flushPendingTombstones(fakeCtx(), target), false);
}

console.log("chat-ops ok");
rmSync(process.env.DSH_HOME, { recursive: true, force: true });
