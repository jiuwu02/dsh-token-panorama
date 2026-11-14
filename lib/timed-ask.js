/**
 * Give the "auto answers" wait limit authority over `ask_user_question` too.
 *
 * Before this module the limit only bounded the answering model's own
 * `llm.stream` call. The platform's legacy `ask_user_question` tool then
 * waited for the human with no deadline at all, so a question could stall a
 * run long after the configured limit had passed -- and the switch looked like
 * it did nothing whenever the model chose to escalate with `{"answers":[]}`.
 *
 * The platform already ships a *timed* variant of that tool (profiles that set
 * `tool-ask-user` to `mode: timed` use it). It calls
 * `ctx.userQuestions.askTimed(...)`, whose expiry returns a pending result;
 * the session projection turns that into a `continued` question and the Client
 * keeps an answerable card wired to `userQuestions.answer(...)`. This plugin
 * cannot switch the platform's tool into that mode (its row lives inside a
 * preset's `config.plugins`, which `applyPatches` cannot address by id), so
 * it installs the same shape as an agent-scoped shadow instead. Scoped tools
 * shadow the global legacy registration for that agent only, which is also
 * what makes `request/header.tools` carry the `timeout` property the
 * projection looks for.
 *
 * Fail open. With the switch off, with the limit set to -1, with no live agent,
 * on a platform without `askTimed`, or if the timed call fails for any reason
 * other than cancellation, `execute` falls back to the ordinary untimed
 * `ctx.userQuestions.ask(...)`. A question is never lost to make a timeout
 * visible.
 */

export const TIMED_ASK_NAME = "ask_user_question";

/** Model-facing description; mirrors the platform's own timed tool. */
export const TIMED_ASK_DESCRIPTION =
  "Ask brief, direct, self-contained questions about missing information, preferences, or decisions. Use user-facing terms; assume no knowledge of background work or internal names. Use distinct stable question IDs. An answer item with empty selected and no custom means the user skipped that question: continue without it, do not ask it again, and do not treat the skip as permission. A pending result instead means no answer batch arrived before the timeout and the user can still answer.";

/**
 * Carried in the pending result's `message`. The projection and the Client
 * read the rendered text back as one JSON object, so the instruction has to be
 * a field of the value rather than prose beside it.
 */
export const PENDING_NOTICE =
  "No answer batch arrived before the timeout. This is pending, not a skipped answer. Continue useful independent work. The user can still answer; their reply will be a user message identified as answer_to_pending_question with this callId and the original questions. Do not treat this as permission.";

const TIMEOUT_DESCRIPTION =
  "Optional wait seconds for the whole batch (defaults to the configured wait limit). Omit unless a different duration is needed. Use -1 only when an answer is required before proceeding.";

/**
 * Raw JSON Schema in the same compiled shape `defineTool` produces. The
 * `timeout` property is not decoration: `isTimedAskUserQuestionSchema`
 * looks for exactly this to set `userQuestions.timed` from the request
 * header, and only a timed request can become `continued`.
 */
const timedParameters = () => ({
  type: "object",
  properties: {
    questions: {
      type: "array",
      description: "Questions to ask the user.",
      items: {
        type: "object",
        additionalProperties: true,
        properties: {
          id: { type: "string", description: "Stable id for this question; echoed in the answer." },
          question: { type: "string", description: "The specific question to ask the user." },
          header: { type: "string", description: "Optional short heading for the question." },
          options: {
            type: "array",
            description: "Optional choices to show the user.",
            items: {
              type: "object",
              additionalProperties: true,
              properties: {
                label: { type: "string", description: "Short user-facing option label." },
                description: { type: "string", description: "One sentence explaining the tradeoff or impact." },
              },
              required: ["label"],
            },
          },
          multi_select: { type: "boolean", description: "Whether the user may select more than one option. Defaults to false." },
        },
        required: ["id", "question"],
      },
    },
    timeout: { type: "integer", description: TIMEOUT_DESCRIPTION },
  },
  required: ["questions"],
});

/** `oneOf` is required: a legacy-only answers schema would reject pending. */
const timedOutputSchema = () => ({
  oneOf: [
    {
      type: "object",
      additionalProperties: false,
      properties: {
        pending: { type: "boolean", enum: [true] },
        callId: { type: "string" },
        message: { type: "string" },
      },
      required: ["pending", "callId", "message"],
    },
    {
      type: "object",
      additionalProperties: false,
      properties: {
        answers: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              id: { type: "string" },
              selected: { type: "array", items: { type: "string" } },
              custom: { type: "string" },
            },
            required: ["id", "selected"],
          },
        },
      },
      required: ["answers"],
    },
  ],
});

const validSeconds = (value) =>
  Number.isInteger(value) &&
  (value === -1 || (value >= 1 && value <= 2147483));

const answerResult = (result) => {
  const answers = Array.isArray(result?.answers) ? result.answers : [];
  return {
    answers: answers.map((answer) => ({
      id: answer.id,
      selected: Array.isArray(answer.selected) ? [...answer.selected] : [],
      ...(typeof answer.custom === "string" ? { custom: answer.custom } : {}),
    })),
  };
};

const questionRequest = (args, exec) => {
  const questions = Array.isArray(args?.questions) ? args.questions : [];
  const seen = new Set();
  for (const question of questions) {
    if (seen.has(question?.id))
      throw new Error(
        `question id ${JSON.stringify(question?.id)} must be unique within this call`,
      );
    seen.add(question?.id);
  }
  return {
    questions: questions.map((question) => ({
      id: question.id,
      question: question.question,
      ...(typeof question.header === "string" ? { header: question.header } : {}),
      ...(Array.isArray(question.options)
        ? { options: question.options.map((option) => ({ ...option })) }
        : {}),
      ...(typeof question.multi_select === "boolean"
        ? { multiSelect: question.multi_select }
        : {}),
    })),
    ...(exec?.agent !== undefined ? { agent: exec.agent } : {}),
    ...(exec?.signal !== undefined ? { signal: exec.signal } : {}),
  };
};

/**
 * Build the registry-ready shadow definition.
 *
 * `getOptions` is read on every call, so a saved switch or wait limit takes
 * effect on the next question without re-registering the tool.
 */
export function buildTimedAskDefinition({ getOptions, getUserQuestions, logger }) {
  return {
    name: TIMED_ASK_NAME,
    description: TIMED_ASK_DESCRIPTION,
    parameters: timedParameters(),
    output: {
      schema: timedOutputSchema(),
      render: (_args, value) => [
        { type: "text", text: JSON.stringify(value) },
      ],
    },
    async execute(args, exec) {
      const options = getOptions?.() ?? {};
      const configured = validSeconds(options.timeout) ? options.timeout : 120;
      const raw = args?.timeout;
      const seconds = validSeconds(raw) ? raw : configured;
      const request = questionRequest(args, exec);

      let service;
      try {
        service = getUserQuestions?.(exec);
      } catch {
        service = undefined;
      }
      if (!service || typeof service.ask !== "function")
        throw new Error(
          "dsh-token-panorama: userQuestions service is unavailable",
        );

      // The timed path is the only one that can produce a pending result, and
      // pending is the only outcome that leaves the question answerable.
      if (
        options.enabled === true &&
        seconds !== -1 &&
        exec?.agent !== undefined &&
        typeof service.askTimed === "function"
      ) {
        try {
          const result = await service.askTimed(
            request,
            exec.callId,
            seconds * 1_000,
          );
          if (result?.pending === true)
            return {
              pending: true,
              callId: result.callId ?? String(exec.callId),
              message: PENDING_NOTICE,
            };
          return answerResult(result);
        } catch (error) {
          if (exec.signal?.aborted) throw error;
          logger?.warn?.(
            `dsh-token-panorama: timed ask fell back to the human card: ${String(error)}`,
          );
        }
      }

      // Legacy wait. No `wait` field: approval/plan-review batches reject a
      // request that carries one, and without the switch there is no deadline
      // to signal to the Client anyway.
      return answerResult(await service.ask(request));
    },
  };
}

/**
 * Install the shadow for every live agent of this plugin fiber.
 *
 * A config save replaces the fiber rather than re-emitting `agent/created`
 * for agents that already exist, so both the initial sweep and the event are
 * needed. One fiber-level effect owns every disposer: unloading the fiber
 * removes all shadows, letting the next instance register its own without a
 * duplicate-name error.
 */
export function installTimedAsk(ctx, { getOptions, logger }) {
  if (!ctx || typeof ctx.on !== "function") return;

  // Resolve at execution time, not registration time: this plugin does not
  // declare `userQuestions` in `inject`, so the service may not exist yet when
  // apply() runs. Try this fiber, then the live agent's own scope -- the same
  // scope the platform's tool dispatches the question through.
  const getUserQuestions = (exec) => {
    const agentCtx = exec?.agent?.ctx;
    const candidates = [
      () => ctx.userQuestions,
      () => ctx.get?.("userQuestions"),
      () => agentCtx?.userQuestions,
      () => agentCtx?.get?.("userQuestions"),
    ];
    for (const read of candidates) {
      try {
        const service = read();
        if (service && typeof service.ask === "function") return service;
      } catch {}
    }
    return undefined;
  };
  const definition = buildTimedAskDefinition({
    getOptions,
    getUserQuestions,
    logger,
  });
  const owned = new Map();

  const registerFor = (agent) => {
    if (!agent || owned.has(agent)) return;
    // Delegated callers cannot own a live question; leave them the global tool.
    if (agent.session?.header?.origin === "subagent") return;
    try {
      const tools = agent.ctx?.tools ?? agent.ctx?.get?.("tools");
      if (!tools || typeof tools.register !== "function") return;
      // A profile already running the platform's timed variant, or an older
      // fiber whose shadow survived, needs no second shadow: shadowing it
      // again would throw a duplicate-name error on this agent's layer.
      let alreadyTimed = false;
      try {
        const visible =
          typeof tools.get === "function"
            ? tools.get(TIMED_ASK_NAME, agent)
            : undefined;
        alreadyTimed = visible?.parameters?.properties?.timeout !== undefined;
      } catch {}
      if (alreadyTimed) return;
      owned.set(agent, tools.register(definition));
    } catch (error) {
      logger?.warn?.(
        `dsh-token-panorama: timed ask shadow skipped: ${String(error)}`,
      );
    }
  };

  const releaseFor = (agent) => {
    const dispose = owned.get(agent);
    if (!dispose) return;
    owned.delete(agent);
    try {
      dispose();
    } catch {}
  };

  try {
    const agents = ctx.agents ?? ctx.get?.("agents");
    for (const agent of agents?.list?.() ?? []) registerFor(agent);
  } catch {}

  // A global listener reaches agents composed under any scope, not only the
  // one this fiber happens to sit in; the platform's own session controller
  // uses the same option for agent/created. Fall back to a plain listener if a
  // host build does not recognise it.
  const subscribe = (event, handler) => {
    try {
      return ctx.on(event, handler, { global: true });
    } catch {
      return ctx.on(event, handler);
    }
  };
  subscribe("agent/created", ({ agent }) => registerFor(agent));
  subscribe("agent/disposed", ({ agent }) => releaseFor(agent));

  if (typeof ctx.effect === "function") {
    ctx.effect(() => () => {
      for (const agent of [...owned.keys()]) releaseFor(agent);
    });
  }
}
