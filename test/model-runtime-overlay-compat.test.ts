import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  InMemoryCredentialStore,
  InMemoryModelsStore,
  type OAuthCredential,
  type Provider,
} from "@earendil-works/pi-ai";
import {
  ModelRegistry,
  ModelRuntime,
  type ExtensionAPI,
  type ExtensionContext,
  type ExtensionEvent,
  type ProviderConfig,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createProviderCloneExtension } from "../index.js";
import { saveCloneStore } from "../persistence.js";
import { makeProvider } from "./helpers.js";

type EventHandler = (event: ExtensionEvent, ctx: ExtensionContext) => unknown;

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

function oauthProvider(id: string): Provider {
  const provider = makeProvider(id);
  return {
    ...provider,
    auth: {
      oauth: {
        name: `OAuth ${id}`,
        async login() {
          throw new Error("login is not used by this test");
        },
        async refresh(credential) {
          return credential;
        },
        async toAuth(credential) {
          return { apiKey: credential.access };
        },
      },
    },
  };
}

interface RuntimeHarness {
  credentials: InMemoryCredentialStore;
  handlers: Map<string, EventHandler[]>;
  notifications: Array<{ message: string; type: string | undefined }>;
  registry: ModelRegistry;
  runtime: ModelRuntime;
  ctx: ExtensionContext;
  ownedClone: Provider;
}

async function createRuntimeHarness(): Promise<RuntimeHarness> {
  const directory = await mkdtemp(join(tmpdir(), "pi-provider-clone-runtime-"));
  temporaryDirectories.push(directory);
  const storePath = join(directory, "provider-clones.json");
  const source = oauthProvider("source");
  const targetId = "source-personal";
  await saveCloneStore(
    {
      version: 1,
      clones: [
        {
          sourceId: source.id,
          targetId,
          createdAt: "2026-08-21T00:00:00.000Z",
        },
      ],
    },
    storePath,
  );

  const credentials = new InMemoryCredentialStore();
  const credential: OAuthCredential = {
    type: "oauth",
    access: "target-access-token",
    refresh: "target-refresh-token",
    expires: Date.now() + 60 * 60 * 1000,
  };
  await credentials.modify(targetId, async () => credential);
  const runtime = await ModelRuntime.create({
    credentials,
    modelsPath: null,
    modelsStore: new InMemoryModelsStore(),
    allowModelNetwork: false,
    refreshOnCreate: false,
  });
  const registry = new ModelRegistry(runtime);
  const handlers = new Map<string, EventHandler[]>();

  const pi = {
    on(event: string, handler: EventHandler) {
      const registered = handlers.get(event) ?? [];
      registered.push(handler);
      handlers.set(event, registered);
    },
    registerCommand() {},
    registerProvider(providerOrName: Provider | string, config?: ProviderConfig) {
      if (typeof providerOrName === "string") {
        if (!config) throw new Error("Missing named provider config");
        runtime.registerProvider(providerOrName, config);
      } else {
        runtime.registerNativeProvider(providerOrName);
      }
    },
    unregisterProvider(providerId: string) {
      runtime.unregisterProvider(providerId);
    },
  } as unknown as ExtensionAPI;

  await createProviderCloneExtension({
    getStorePath: () => storePath,
    loadSourceProviders: () => [source],
  })(pi);

  const ownedClone = runtime.getRegisteredNativeProvider(targetId);
  const model = ownedClone?.getModels()[0];
  if (!ownedClone || !model) throw new Error("Saved clone was not restored");

  const notifications: Array<{ message: string; type: string | undefined }> = [];
  const ctx = {
    model,
    modelRegistry: registry,
    ui: {
      notify(message: string, type?: string) {
        notifications.push({ message, type });
      },
    },
  } as unknown as ExtensionContext;

  return {
    credentials,
    handlers,
    notifications,
    registry,
    runtime,
    ctx,
    ownedClone,
  };
}

async function emit(
  harness: RuntimeHarness,
  eventName: "input" | "turn_start",
  ctx: ExtensionContext = harness.ctx,
): Promise<void> {
  const event: ExtensionEvent =
    eventName === "input"
      ? { type: "input", text: "continue", source: "interactive" }
      : { type: "turn_start", turnIndex: 1, timestamp: Date.now() };
  for (const handler of harness.handlers.get(eventName) ?? []) {
    await handler(event, ctx);
  }
}

async function shutdownForReload(harness: RuntimeHarness): Promise<void> {
  const event = { type: "session_shutdown", reason: "reload" } as const;
  for (const handler of harness.handlers.get("session_shutdown") ?? []) {
    await handler(event, harness.ctx);
  }
}

function incompleteStreamOverlay(provider: Provider): ProviderConfig {
  const model = provider.getModels()[0];
  if (!model) throw new Error("Provider has no model");
  return {
    api: model.api,
    streamSimple: provider.streamSimple.bind(provider),
  };
}

describe.sequential("Pi 0.84.x runtime overlay compatibility", () => {
  it("restores OAuth auth and the original identity bridge before the next request", async () => {
    const harness = await createRuntimeHarness();
    const targetId = harness.ownedClone.id;
    const model = harness.ownedClone.getModels()[0];
    if (!model) throw new Error("Clone has no model");

    await expect(harness.runtime.getAuth(model)).resolves.toMatchObject({
      auth: { apiKey: "target-access-token" },
    });

    // Pi 0.84.x deletes the native provider before composing a named overlay.
    harness.runtime.registerProvider(
      targetId,
      incompleteStreamOverlay(harness.ownedClone),
    );
    expect(harness.runtime.getRegisteredNativeProvider(targetId)).toBeUndefined();
    expect(harness.runtime.getProvider(targetId)?.getModels()).toEqual([]);
    await expect(harness.runtime.getAuth(model)).resolves.toBeUndefined();
    await expect(
      harness.runtime.completeSimple(model, { messages: [] }),
    ).resolves.toMatchObject({
      stopReason: "error",
      errorMessage: `Provider is not configured: ${targetId}`,
    });

    await emit(harness, "turn_start");

    expect(harness.runtime.getRegisteredNativeProvider(targetId)).toBe(
      harness.ownedClone,
    );
    expect(harness.runtime.getProvider(targetId)).toBe(harness.ownedClone);
    await expect(harness.runtime.getAuth(model)).resolves.toMatchObject({
      auth: { apiKey: "target-access-token" },
    });
    await expect(
      harness.runtime.completeSimple(model, { messages: [] }),
    ).resolves.toMatchObject({ provider: targetId });
    await expect(harness.credentials.read("source")).resolves.toBeUndefined();
    await expect(harness.credentials.read(targetId)).resolves.toMatchObject({
      type: "oauth",
      access: "target-access-token",
    });
    expect(harness.notifications).toEqual([
      {
        type: "warning",
        message: expect.stringMatching(/restored.*incomplete runtime provider overlay/iu),
      },
    ]);

    harness.runtime.registerProvider(
      targetId,
      incompleteStreamOverlay(harness.ownedClone),
    );
    await emit(harness, "input");
    expect(harness.runtime.getProvider(targetId)).toBe(harness.ownedClone);
    expect(harness.notifications).toHaveLength(1);

    await shutdownForReload(harness);
    expect(harness.runtime.getProvider(targetId)).toBeUndefined();
  });

  it("restores a missing active clone before input auth preflight", async () => {
    const harness = await createRuntimeHarness();
    const targetId = harness.ownedClone.id;

    harness.runtime.unregisterProvider(targetId);
    expect(harness.runtime.getProvider(targetId)).toBeUndefined();

    await emit(harness, "input");

    expect(harness.runtime.getProvider(targetId)).toBe(harness.ownedClone);
    expect(harness.notifications).toHaveLength(1);
  });

  it("does not overwrite complete named or native foreign providers", async () => {
    const namedHarness = await createRuntimeHarness();
    const targetId = namedHarness.ownedClone.id;
    const model = namedHarness.ownedClone.getModels()[0];
    if (!model) throw new Error("Clone has no model");
    namedHarness.runtime.registerProvider(targetId, {
      api: model.api,
      baseUrl: model.baseUrl,
      apiKey: "foreign-key",
      models: [model],
    });
    await emit(namedHarness, "turn_start");

    expect(namedHarness.runtime.getProvider(targetId)).not.toBe(
      namedHarness.ownedClone,
    );
    expect(namedHarness.runtime.getRegisteredNativeProvider(targetId)).toBeUndefined();
    expect(namedHarness.runtime.getRegisteredProviderConfig(targetId)?.models).toHaveLength(1);
    expect(namedHarness.notifications).toEqual([]);

    const nativeHarness = await createRuntimeHarness();
    const nativeForeign = makeProvider(nativeHarness.ownedClone.id);
    nativeHarness.runtime.registerNativeProvider(nativeForeign);

    await emit(nativeHarness, "turn_start");

    expect(nativeHarness.runtime.getProvider(nativeForeign.id)).toBe(nativeForeign);
    expect(nativeHarness.runtime.getRegisteredNativeProvider(nativeForeign.id)).toBe(
      nativeForeign,
    );
    expect(nativeHarness.notifications).toEqual([]);
  });

  it("does not reclaim an incomplete overlay for an inactive clone", async () => {
    const harness = await createRuntimeHarness();
    const targetId = harness.ownedClone.id;
    harness.runtime.registerProvider(
      targetId,
      incompleteStreamOverlay(harness.ownedClone),
    );
    const otherModel = makeProvider("other").getModels()[0];
    if (!otherModel) throw new Error("Other provider has no model");
    const inactiveCtx = {
      ...harness.ctx,
      model: otherModel,
    } as ExtensionContext;

    await emit(harness, "turn_start", inactiveCtx);

    expect(harness.runtime.getRegisteredNativeProvider(targetId)).toBeUndefined();
    expect(harness.runtime.getProvider(targetId)?.getModels()).toEqual([]);
    expect(harness.notifications).toEqual([]);
  });

  it("does not claim an explicit dynamic named provider while its catalog is empty", async () => {
    const harness = await createRuntimeHarness();
    const targetId = harness.ownedClone.id;
    const model = harness.ownedClone.getModels()[0];
    if (!model) throw new Error("Clone has no model");
    const refreshModels = vi.fn(async () => []);
    harness.runtime.registerProvider(targetId, {
      api: model.api,
      apiKey: "foreign-key",
      refreshModels,
    });
    expect(harness.runtime.getProvider(targetId)?.getModels()).toEqual([]);

    await emit(harness, "turn_start");

    expect(harness.runtime.getProvider(targetId)).not.toBe(harness.ownedClone);
    expect(harness.runtime.getRegisteredNativeProvider(targetId)).toBeUndefined();
    expect(harness.runtime.getRegisteredProviderConfig(targetId)?.refreshModels).toBe(
      refreshModels,
    );
    expect(harness.notifications).toEqual([]);
  });
});
