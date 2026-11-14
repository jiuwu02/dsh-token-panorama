/**
 * Timed ask regression guard.
 *
 * The wait limit must govern the `ask_user_question` foreground wait, and an
 * expired call must leave the batch answerable (pending -> continued) rather
 * than become a generic tool timeout that removes the card.
 */
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const {
  buildTimedAskDefinition,
  installTimedAsk,
  PENDING_NOTICE,
  TIMED_ASK_NAME,
} = await import(pathToFileURL(join(root, "lib/timed-ask.js")).href);

const exec = {
  callId: "call-1",
  agent: { id: "agent-1" },
  signal: new AbortController().signal,
};
const questions = [
  { id: "q1", question: "Which file?", multi_select: false, options: [{ label: "a" }] },
];

// Mirrors the platform's isTimedAskUserQuestionSchema.
const isTimed = (tool) =>
  tool.name === TIMED_ASK_NAME &&
  "timeout" in (tool.parameters?.properties ?? {});

const make = (options, service, logger = { warn: () => {} }) =>
  buildTimedAskDefinition({
    getOptions: () => options,
    getUserQuestions: () => service,
    logger,
  });

// 1. The schema itself is what flips userQuestions.timed on.
{
  const def = make({ enabled: true, timeout: 600 }, {});
  assert.equal(isTimed(def), true, "parameters.properties.timeout must be present");
  assert.equal(def.parameters.required.includes("questions"), true);
  assert.equal(def.parameters.required.includes("timeout"), false, "timeout must stay optional");
  const branches = def.output.schema.oneOf;
  assert.equal(branches.length, 2, "output must allow pending and answers");
  assert.deepEqual(branches[0].required, ["pending", "callId", "message"]);
  assert.deepEqual(branches[1].required, ["answers"]);
  assert.equal(branches[0].properties.pending.enum[0], true);
}

// 2. Enabled + positive limit: askTimeout becomes the foreground wait.
{
  const calls = [];
  const def = make({ enabled: true, timeout: 600 }, {
    ask: async () => { throw new Error("ask must not run"); },
    askTimed: async (request, callId, ms) => {
      calls.push({ request, callId, ms });
      return { pending: true, callId };
    },
  });
  const value = await def.execute({ questions }, exec);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].ms, 600_000, "seconds must become platform milliseconds");
  assert.equal(calls[0].callId, "call-1");
  assert.equal(calls[0].request.agent, exec.agent);
  assert.equal(calls[0].request.wait, undefined, "askTimed adds wait itself");
  assert.equal(calls[0].request.questions[0].multiSelect, false);
  assert.equal(calls[0].request.questions[0].options[0].label, "a");
  assert.deepEqual(value, { pending: true, callId: "call-1", message: PENDING_NOTICE });

  // The projection's isPendingResult reads the rendered text back as JSON.
  const parsed = JSON.parse(def.output.render({ questions }, value)[0].text);
  assert.equal(parsed.pending, true, "a pending result must survive rendering");
  assert.equal(typeof parsed.callId, "string");
  assert.equal(typeof parsed.message, "string");
}

// 3. An answer inside the window still returns an ordinary answer batch.
{
  const def = make({ enabled: true, timeout: 600 }, {
    ask: async () => { throw new Error("ask must not run"); },
    askTimed: async () => ({ answers: [{ id: "q1", selected: ["a"], custom: "note" }] }),
  });
  assert.deepEqual(await def.execute({ questions }, exec), {
    answers: [{ id: "q1", selected: ["a"], custom: "note" }],
  });
}

// 4. -1 means no timed deadline: the untimed request must carry no wait field.
{
  const calls = [];
  const def = make({ enabled: true, timeout: -1 }, {
    ask: async (request) => { calls.push(request); return { answers: [] }; },
    askTimed: async () => { throw new Error("askTimed must not run with -1"); },
  });
  assert.deepEqual(await def.execute({ questions }, exec), { answers: [] });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].wait, undefined, "approval batches reject a request with wait");
}

// 5. Switch off: legacy behaviour even though the schema stays timed.
{
  const calls = [];
  const def = make({ enabled: false, timeout: 600 }, {
    ask: async (request) => { calls.push(request); return { answers: [] }; },
    askTimed: async () => { throw new Error("askTimed must not run with the switch off"); },
  });
  assert.deepEqual(await def.execute({ questions }, exec), { answers: [] });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].wait, undefined);
}

// 6. Fail open when the platform has no timed service.
{
  const def = make({ enabled: true, timeout: 600 }, {
    ask: async () => ({ answers: [] }),
  });
  assert.deepEqual(await def.execute({ questions }, exec), { answers: [] });
}

// 7. A model-supplied timeout is honoured only when it is a valid value.
{
  const calls = [];
  const def = make({ enabled: true, timeout: 600 }, {
    ask: async () => ({ answers: [] }),
    askTimed: async (_r, _c, ms) => { calls.push(ms); return { answers: [] }; },
  });
  await def.execute({ questions, timeout: 5 }, exec);
  await def.execute({ questions, timeout: 0 }, exec);
  assert.deepEqual(calls, [5_000, 600_000]);
}

// 8. Duplicate ids are rejected rather than producing an unanswerable card.
{
  const def = make({ enabled: true, timeout: 600 }, {
    ask: async () => ({ answers: [] }),
    askTimed: async () => ({ answers: [] }),
  });
  await assert.rejects(
    () => def.execute({ questions: [{ id: "x" }, { id: "x" }] }, exec),
    /unique within this call/,
  );
}

// 9. Installation covers existing agents and future ones, and is disposable.
{
  const listeners = {};
  const registrations = [];
  let disposed = 0;
  const newAgent = () => ({
    session: { header: { origin: "user" } },
    ctx: { tools: { register: (def) => { registrations.push(def); return () => { disposed += 1; }; } } },
  });
  const existing = newAgent();
  let cleanup;
  const ctx = {
    on: (name, cb) => { listeners[name] = cb; return () => {}; },
    get: () => undefined,
    agents: { list: () => [existing] },
    effect: (fn) => { cleanup = fn(); return () => cleanup?.(); },
    logger: { warn: () => {} },
  };
  assert.doesNotThrow(() => installTimedAsk(ctx, {
    getOptions: () => ({ enabled: true, timeout: 600 }),
    logger: ctx.logger,
  }));
  assert.equal(registrations.length, 1, "agents that already exist get the shadow");
  assert.equal(isTimed(registrations[0]), true);
  listeners["agent/created"]({ agent: newAgent() });
  assert.equal(registrations.length, 2, "future agents get the shadow");
  listeners["agent/created"]({ agent: existing });
  assert.equal(registrations.length, 2, "the same agent is registered once");
  cleanup();
  assert.equal(disposed, 2, "fiber teardown removes every scoped shadow");
}

// 10. A profile already running a timed tool is not shadowed twice.
{
  let registered = 0;
  const agent = {
    session: { header: { origin: "user" } },
    ctx: { tools: {
      get: () => ({ parameters: { properties: { timeout: { type: "integer" } } } }),
      register: () => { registered += 1; return () => {}; },
    } },
  };
  const ctx = {
    on: () => () => {},
    get: () => undefined,
    agents: { list: () => [agent] },
    effect: () => () => {},
    logger: { warn: () => {} },
  };
  installTimedAsk(ctx, {
    getOptions: () => ({ enabled: true, timeout: 600 }),
    logger: ctx.logger,
  });
  assert.equal(registered, 0, "an already-timed tool must not be shadowed twice");
}

console.log("timed ask ok: timed schema, pending answerability, switch/-1 gating, fail-open, lifecycle");
