import {
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessage,
  type AssistantMessageEvent,
  type Model,
  type Provider,
} from "@earendil-works/pi-ai";

export function makeModel(provider = "source", id = "model-1"): Model<Api> {
  return {
    id,
    name: "Model One",
    api: "openai-responses",
    provider,
    baseUrl: "https://example.test/v1",
    reasoning: true,
    thinkingLevelMap: { high: "high", max: "max" },
    input: ["text", "image"],
    cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.2 },
    contextWindow: 128_000,
    maxTokens: 16_384,
    headers: { "x-model": "one" },
    compat: { supportsDeveloperRole: false },
  };
}

export function makeAssistantMessage(
  provider = "source",
  overrides: Partial<AssistantMessage> = {},
): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: "openai-responses",
    provider,
    model: "model-1",
    usage: {
      input: 1,
      output: 2,
      cacheRead: 3,
      cacheWrite: 4,
      totalTokens: 10,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: 1,
    ...overrides,
  };
}

export function streamFromEvents(events: readonly AssistantMessageEvent[]) {
  const stream = createAssistantMessageEventStream();
  for (const event of events) stream.push(event);
  stream.end();
  return stream;
}

export async function collectEvents(
  stream: AsyncIterable<AssistantMessageEvent>,
): Promise<AssistantMessageEvent[]> {
  const events: AssistantMessageEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

export function makeProvider(
  id = "source",
  models: readonly Model<Api>[] = [makeModel(id)],
): Provider {
  return {
    id,
    name: `Provider ${id}`,
    baseUrl: "https://example.test/v1",
    headers: { "x-provider": id },
    auth: {
      apiKey: {
        name: "Test API key",
        async resolve() {
          return undefined;
        },
      },
    },
    getModels: () => models,
    stream(model) {
      const message = makeAssistantMessage(model.provider, {
        api: model.api,
        model: model.id,
      });
      return streamFromEvents([{ type: "done", reason: "stop", message }]);
    },
    streamSimple(model) {
      const message = makeAssistantMessage(model.provider, {
        api: model.api,
        model: model.id,
      });
      return streamFromEvents([{ type: "done", reason: "stop", message }]);
    },
  };
}
