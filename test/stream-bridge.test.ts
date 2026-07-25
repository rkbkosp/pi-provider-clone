import type { AssistantMessageEvent, Context } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import {
  bridgeStream,
  mapAssistantMessageEvent,
  toSourceContext,
  toSourceModel,
  toTargetAssistantMessage,
} from "../stream-bridge.js";
import {
  collectEvents,
  makeAssistantMessage,
  makeModel,
  streamFromEvents,
} from "./helpers.js";

describe("provider identity transforms", () => {
  it("changes only the model provider", () => {
    const cloneModel = makeModel("clone");
    const sourceModel = toSourceModel(cloneModel, "source");

    expect(sourceModel).toEqual({ ...cloneModel, provider: "source" });
    expect(sourceModel).not.toBe(cloneModel);
    expect(cloneModel.provider).toBe("clone");
  });

  it("rewrites only assistant history produced by the current clone", () => {
    const cloneAssistant = makeAssistantMessage("clone");
    const sourceAssistant = makeAssistantMessage("source");
    const otherAssistant = makeAssistantMessage("other-clone");
    const context: Context = {
      systemPrompt: "system",
      messages: [
        { role: "user", content: "hello", timestamp: 1 },
        cloneAssistant,
        sourceAssistant,
        otherAssistant,
        {
          role: "toolResult",
          toolCallId: "call-1",
          toolName: "read",
          content: [{ type: "text", text: "result" }],
          isError: false,
          timestamp: 2,
        },
      ],
    };

    const transformed = toSourceContext(context, "source", "clone");

    expect(transformed).not.toBe(context);
    expect(transformed.messages[1]).toEqual({ ...cloneAssistant, provider: "source" });
    expect(transformed.messages[1]).not.toBe(cloneAssistant);
    expect(transformed.messages[2]).toBe(sourceAssistant);
    expect(transformed.messages[3]).toBe(otherAssistant);
    expect(transformed.messages[0]).toBe(context.messages[0]);
    expect(transformed.messages[4]).toBe(context.messages[4]);
  });

  it("changes source assistant output back to the clone and leaves others alone", () => {
    const source = makeAssistantMessage("source");
    const other = makeAssistantMessage("other");

    expect(toTargetAssistantMessage(source, "source", "clone")).toEqual({
      ...source,
      provider: "clone",
    });
    expect(toTargetAssistantMessage(other, "source", "clone")).toBe(other);
  });
});

describe("assistant event mapping", () => {
  const sourceMessage = makeAssistantMessage("source");
  const contentEvents: AssistantMessageEvent[] = [
    { type: "start", partial: sourceMessage },
    { type: "text_start", contentIndex: 0, partial: sourceMessage },
    { type: "text_delta", contentIndex: 0, delta: "a", partial: sourceMessage },
    { type: "text_end", contentIndex: 0, content: "a", partial: sourceMessage },
    { type: "thinking_start", contentIndex: 1, partial: sourceMessage },
    { type: "thinking_delta", contentIndex: 1, delta: "b", partial: sourceMessage },
    { type: "thinking_end", contentIndex: 1, content: "b", partial: sourceMessage },
    { type: "toolcall_start", contentIndex: 2, partial: sourceMessage },
    { type: "toolcall_delta", contentIndex: 2, delta: "{}", partial: sourceMessage },
    {
      type: "toolcall_end",
      contentIndex: 2,
      toolCall: { type: "toolCall", id: "call-1", name: "read", arguments: {} },
      partial: sourceMessage,
    },
  ];

  it.each(contentEvents)("maps $type partial messages", (event) => {
    const mapped = mapAssistantMessageEvent(event, "source", "clone");
    if (
      mapped.type === "done" ||
      mapped.type === "error"
    ) {
      throw new Error("Expected a partial event");
    }
    expect(mapped.partial.provider).toBe("clone");
  });

  it("maps done and error terminal messages", () => {
    const done = mapAssistantMessageEvent(
      { type: "done", reason: "stop", message: sourceMessage },
      "source",
      "clone",
    );
    const errorMessage = makeAssistantMessage("source", {
      stopReason: "error",
      errorMessage: "failed",
    });
    const error = mapAssistantMessageEvent(
      { type: "error", reason: "error", error: errorMessage },
      "source",
      "clone",
    );

    expect(done.type === "done" && done.message.provider).toBe("clone");
    expect(error.type === "error" && error.error.provider).toBe("clone");
  });
});

describe("stream bridge", () => {
  it("forwards events and resolves with a target-scoped final message", async () => {
    const sourceMessage = makeAssistantMessage("source");
    const stream = bridgeStream(
      () =>
        streamFromEvents([
          { type: "start", partial: sourceMessage },
          { type: "done", reason: "stop", message: sourceMessage },
        ]),
      {
        sourceId: "source",
        targetId: "clone",
        targetModel: makeModel("clone"),
        signal: undefined,
      },
    );

    const [start, done] = await collectEvents(stream);
    expect(start?.type === "start" && start.partial.provider).toBe("clone");
    expect(done?.type === "done" && done.message.provider).toBe("clone");
    await expect(stream.result()).resolves.toMatchObject({ provider: "clone" });
  });

  it("turns synchronous source failures into a terminal error event", async () => {
    const stream = bridgeStream(
      () => {
        throw new Error("synchronous failure");
      },
      {
        sourceId: "source",
        targetId: "clone",
        targetModel: makeModel("clone"),
        signal: undefined,
      },
    );

    const events = await collectEvents(stream);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "error",
      reason: "error",
      error: {
        provider: "clone",
        stopReason: "error",
        errorMessage: "Provider stream bridge failed: synchronous failure",
      },
    });
    await expect(stream.result()).resolves.toMatchObject({ stopReason: "error" });
  });

  it("turns a source stream without a terminal event into an error", async () => {
    const partial = makeAssistantMessage("source");
    const stream = bridgeStream(
      () => streamFromEvents([{ type: "start", partial }]),
      {
        sourceId: "source",
        targetId: "clone",
        targetModel: makeModel("clone"),
        signal: undefined,
      },
    );

    const events = await collectEvents(stream);
    expect(events.map((event) => event.type)).toEqual(["start", "error"]);
    expect(events[1]).toMatchObject({
      type: "error",
      error: { provider: "clone", stopReason: "error" },
    });
  });

  it("emits an aborted terminal event when the signal is aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const stream = bridgeStream(
      () => {
        throw new DOMException("aborted", "AbortError");
      },
      {
        sourceId: "source",
        targetId: "clone",
        targetModel: makeModel("clone"),
        signal: controller.signal,
      },
    );

    await expect(collectEvents(stream)).resolves.toMatchObject([
      { type: "error", reason: "aborted", error: { stopReason: "aborted" } },
    ]);
  });
});
