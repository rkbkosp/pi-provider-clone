import {
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessage,
  type AssistantMessageEvent,
  type AssistantMessageEventStream,
  type Context,
  type Model,
} from "@earendil-works/pi-ai";

export function toSourceModel<TApi extends Api>(
  model: Model<TApi>,
  sourceId: string,
): Model<TApi> {
  return { ...model, provider: sourceId };
}

export function toSourceContext(
  context: Context,
  sourceId: string,
  targetId: string,
): Context {
  return {
    ...context,
    messages: context.messages.map((message) => {
      if (message.role === "assistant" && message.provider === targetId) {
        return { ...message, provider: sourceId };
      }
      return message;
    }),
  };
}

export function toTargetAssistantMessage(
  message: AssistantMessage,
  sourceId: string,
  targetId: string,
): AssistantMessage {
  if (message.provider !== sourceId) return message;
  return { ...message, provider: targetId };
}

function assertNever(value: never): never {
  throw new Error(`Unsupported assistant message event: ${JSON.stringify(value)}`);
}

export function mapAssistantMessageEvent(
  event: AssistantMessageEvent,
  sourceId: string,
  targetId: string,
): AssistantMessageEvent {
  switch (event.type) {
    case "start":
    case "text_start":
    case "text_delta":
    case "text_end":
    case "thinking_start":
    case "thinking_delta":
    case "thinking_end":
    case "toolcall_start":
    case "toolcall_delta":
    case "toolcall_end":
      return {
        ...event,
        partial: toTargetAssistantMessage(event.partial, sourceId, targetId),
      };
    case "done":
      return {
        ...event,
        message: toTargetAssistantMessage(event.message, sourceId, targetId),
      };
    case "error":
      return {
        ...event,
        error: toTargetAssistantMessage(event.error, sourceId, targetId),
      };
    default:
      return assertNever(event);
  }
}

function eventMessage(event: AssistantMessageEvent): AssistantMessage {
  switch (event.type) {
    case "start":
    case "text_start":
    case "text_delta":
    case "text_end":
    case "thinking_start":
    case "thinking_delta":
    case "thinking_end":
    case "toolcall_start":
    case "toolcall_delta":
    case "toolcall_end":
      return event.partial;
    case "done":
      return event.message;
    case "error":
      return event.error;
    default:
      return assertNever(event);
  }
}

function isAbortError(error: unknown): boolean {
  return (
    (error instanceof Error && error.name === "AbortError") ||
    (typeof error === "object" &&
      error !== null &&
      "name" in error &&
      error.name === "AbortError")
  );
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function emptyUsage(): AssistantMessage["usage"] {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function createBridgeErrorMessage(
  model: Model<Api>,
  targetId: string,
  latestMessage: AssistantMessage | undefined,
  error: unknown,
  signal: AbortSignal | undefined,
): AssistantMessage {
  const aborted = signal?.aborted === true || isAbortError(error);
  const prefix = aborted ? "Provider stream bridge aborted" : "Provider stream bridge failed";

  return {
    ...(latestMessage ?? {
      role: "assistant" as const,
      content: [],
      api: model.api,
      model: model.id,
      usage: emptyUsage(),
      timestamp: Date.now(),
    }),
    provider: targetId,
    stopReason: aborted ? "aborted" : "error",
    errorMessage: `${prefix}: ${describeError(error)}`,
  };
}

export interface BridgeStreamOptions {
  sourceId: string;
  targetId: string;
  targetModel: Model<Api>;
  signal: AbortSignal | undefined;
}

export function bridgeStream(
  createInnerStream: () => AsyncIterable<AssistantMessageEvent>,
  options: BridgeStreamOptions,
): AssistantMessageEventStream {
  const outer = createAssistantMessageEventStream();

  void (async () => {
    let latestMessage: AssistantMessage | undefined;
    let terminated = false;

    try {
      const inner = createInnerStream();
      for await (const sourceEvent of inner) {
        const targetEvent = mapAssistantMessageEvent(
          sourceEvent,
          options.sourceId,
          options.targetId,
        );
        latestMessage = eventMessage(targetEvent);
        outer.push(targetEvent);

        if (targetEvent.type === "done" || targetEvent.type === "error") {
          terminated = true;
          break;
        }
      }

      if (!terminated) {
        throw new Error("Source stream ended without a done or error event");
      }
    } catch (error) {
      if (!terminated) {
        const message = createBridgeErrorMessage(
          options.targetModel,
          options.targetId,
          latestMessage,
          error,
          options.signal,
        );
        const reason = message.stopReason === "aborted" ? "aborted" : "error";
        outer.push({ type: "error", reason, error: message });
      }
    } finally {
      outer.end();
    }
  })();

  return outer;
}
