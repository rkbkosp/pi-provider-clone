import {
  type Api,
  type Credential,
  type Model,
  type Provider,
} from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import {
  createClonedProvider,
  listCloneableProviders,
  ProviderCloneError,
  restoreProviderClones,
} from "../clone-provider.js";
import type { ProviderCloneDefinition } from "../types.js";
import {
  collectEvents,
  makeAssistantMessage,
  makeModel,
  makeProvider,
  streamFromEvents,
} from "./helpers.js";

describe("createClonedProvider", () => {
  it("copies complete model snapshots while changing only provider identity", () => {
    const sourceModel = makeModel("source");
    const sourceModels = [sourceModel];
    const source = makeProvider("source", sourceModels);
    const clone = createClonedProvider(source, "clone");

    const [clonedModel] = clone.getModels();
    expect(clonedModel).toEqual({ ...sourceModel, provider: "clone" });
    expect(clonedModel).not.toBe(sourceModel);
    expect(sourceModel.provider).toBe("source");

    sourceModels.push(makeModel("source", "added-later"));
    expect(clone.getModels()).toHaveLength(1);
    expect(clone.name).toBe("clone");
    expect(clone.baseUrl).toBe(source.baseUrl);
    expect(clone.headers).toBe(source.headers);
    expect(clone.auth).toBe(source.auth);
    expect("refreshModels" in clone).toBe(false);
  });

  it("rejects a source with no models", () => {
    expect(() => createClonedProvider(makeProvider("empty", []), "clone")).toThrow(
      ProviderCloneError,
    );
  });

  it("maps filter inputs to source and filter outputs back to clone models", () => {
    const models = [makeModel("source", "allowed"), makeModel("source", "blocked")];
    const seenProviders: string[][] = [];
    const seenCredentials: Array<Credential | undefined> = [];
    const source: Provider = {
      ...makeProvider("source", models),
      filterModels(candidateModels, credential) {
        seenProviders.push(candidateModels.map((model) => model.provider));
        seenCredentials.push(credential);
        return candidateModels.filter((model) => model.id === "allowed");
      },
    };
    const clone = createClonedProvider(source, "clone");
    const cloneModels = clone.getModels();
    const credential: Credential = { type: "api_key", key: "secret-for-test" };

    const filtered = clone.filterModels?.(cloneModels, credential);

    expect(seenProviders).toEqual([["source", "source"]]);
    expect(seenCredentials).toEqual([credential]);
    expect(filtered?.map((model) => `${model.provider}/${model.id}`)).toEqual([
      "clone/allowed",
    ]);
  });

  it("bridges stream and streamSimple identities without changing request options", async () => {
    const seen: Array<{
      method: "stream" | "streamSimple";
      model: Model<Api>;
      providers: string[];
      apiKey: string | undefined;
    }> = [];
    const source: Provider = {
      ...makeProvider("source"),
      stream(model, context, options) {
        seen.push({
          method: "stream",
          model,
          providers: context.messages
            .filter((message) => message.role === "assistant")
            .map((message) => message.provider),
          apiKey: options?.apiKey,
        });
        const message = makeAssistantMessage("source");
        return streamFromEvents([{ type: "done", reason: "stop", message }]);
      },
      streamSimple(model, context, options) {
        seen.push({
          method: "streamSimple",
          model,
          providers: context.messages
            .filter((message) => message.role === "assistant")
            .map((message) => message.provider),
          apiKey: options?.apiKey,
        });
        const message = makeAssistantMessage("source");
        return streamFromEvents([{ type: "done", reason: "stop", message }]);
      },
    };
    const clone = createClonedProvider(source, "clone");
    const cloneModel = clone.getModels()[0];
    if (!cloneModel) throw new Error("Missing cloned model");
    const context = {
      messages: [makeAssistantMessage("clone"), makeAssistantMessage("other-clone")],
    };

    const normalEvents = await collectEvents(
      clone.stream(cloneModel, context, { apiKey: "target-credential" }),
    );
    const simpleEvents = await collectEvents(
      clone.streamSimple(cloneModel, context, { apiKey: "target-credential" }),
    );

    expect(seen).toEqual([
      {
        method: "stream",
        model: { ...cloneModel, provider: "source" },
        providers: ["source", "other-clone"],
        apiKey: "target-credential",
      },
      {
        method: "streamSimple",
        model: { ...cloneModel, provider: "source" },
        providers: ["source", "other-clone"],
        apiKey: "target-credential",
      },
    ]);
    expect(normalEvents[0]).toMatchObject({ type: "done", message: { provider: "clone" } });
    expect(simpleEvents[0]).toMatchObject({ type: "done", message: { provider: "clone" } });
  });

  it("converts synchronous provider throws into stream errors", async () => {
    const source: Provider = {
      ...makeProvider("source"),
      stream() {
        throw new Error("source exploded");
      },
    };
    const clone = createClonedProvider(source, "clone");
    const model = clone.getModels()[0];
    if (!model) throw new Error("Missing cloned model");

    await expect(collectEvents(clone.stream(model, { messages: [] }))).resolves.toMatchObject([
      {
        type: "error",
        error: { provider: "clone", errorMessage: expect.stringContaining("source exploded") },
      },
    ]);
  });
});

describe("provider enumeration", () => {
  it("lists model-backed providers, excludes clone targets, and sorts labels", () => {
    const providers = new Map<string, Provider>([
      ["z-provider", makeProvider("z-provider")],
      ["a-provider", makeProvider("a-provider")],
      ["clone", makeProvider("clone")],
    ]);
    const allModels = [
      makeModel("z-provider"),
      makeModel("a-provider"),
      makeModel("a-provider", "second"),
      makeModel("clone"),
      makeModel("missing"),
    ];

    const result = listCloneableProviders(
      {
        getAll: () => allModels,
        getProvider: (id) => providers.get(id),
        getProviderDisplayName: (id) => (id === "z-provider" ? "Alpha" : "Zulu"),
      },
      new Set(["clone"]),
    );

    expect(result.map(({ id }) => id)).toEqual(["z-provider", "a-provider"]);
  });
});

describe("clone restoration", () => {
  const definition: ProviderCloneDefinition = {
    sourceId: "source",
    targetId: "clone",
    createdAt: "2026-07-24T12:00:00.000Z",
  };

  it("registers once and remains idempotent", () => {
    const providers = new Map<string, Provider>([["source", makeProvider("source")]]);
    const registeredCloneIds = new Set<string>();
    const registerProvider = vi.fn((provider: Provider) => providers.set(provider.id, provider));
    const warnings: string[] = [];
    const registered: string[] = [];
    const options = {
      definitions: [definition],
      registry: { getProvider: (id: string) => providers.get(id) },
      registrar: { registerProvider },
      registeredCloneIds,
      onWarning: (message: string) => warnings.push(message),
      onRegistered: (saved: ProviderCloneDefinition) => registered.push(saved.targetId),
    };

    const first = restoreProviderClones(options);
    const second = restoreProviderClones(options);

    expect(first.registered).toEqual(["clone"]);
    expect(second.skipped).toEqual(["clone"]);
    expect(registerProvider).toHaveBeenCalledTimes(1);
    expect(registeredCloneIds).toEqual(new Set(["clone"]));
    expect(registered).toEqual(["clone"]);
    expect(warnings).toEqual([]);
  });

  it("does not overwrite a conflicting target", () => {
    const foreignTarget = makeProvider("clone");
    const providers = new Map<string, Provider>([
      ["source", makeProvider("source")],
      ["clone", foreignTarget],
    ]);
    const registerProvider = vi.fn();
    const warnings: string[] = [];

    const result = restoreProviderClones({
      definitions: [definition],
      registry: { getProvider: (id) => providers.get(id) },
      registrar: { registerProvider },
      registeredCloneIds: new Set(),
      onWarning: (message) => warnings.push(message),
    });

    expect(result.skipped).toEqual(["clone"]);
    expect(registerProvider).not.toHaveBeenCalled();
    expect(providers.get("clone")).toBe(foreignTarget);
    expect(warnings[0]).toMatch(/already in use/u);
  });

  it("reports missing sources and sources without models", () => {
    const warnings: string[] = [];
    const providers = new Map<string, Provider>([["empty", makeProvider("empty", [])]]);
    const definitions: ProviderCloneDefinition[] = [
      definition,
      {
        sourceId: "empty",
        targetId: "empty-clone",
        createdAt: definition.createdAt,
      },
    ];

    const result = restoreProviderClones({
      definitions,
      registry: { getProvider: (id) => providers.get(id) },
      registrar: { registerProvider: vi.fn() },
      registeredCloneIds: new Set(),
      onWarning: (message) => warnings.push(message),
    });

    expect(result.failed).toEqual(["clone", "empty-clone"]);
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toMatch(/unavailable/u);
    expect(warnings[1]).toMatch(/no models/u);
  });
});
