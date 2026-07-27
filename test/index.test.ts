import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { Api, Model, Provider } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import providerCloneExtension, { createProviderCloneExtension } from "../index.js";
import { loadCloneStore, saveCloneStore } from "../persistence.js";
import { makeProvider } from "./helpers.js";

type CommandHandler = (args: string, ctx: ExtensionCommandContext) => Promise<void>;
type EventHandler = (event: { reason?: string }, ctx: ExtensionContext) => unknown;

interface Harness {
  providers: Map<string, Provider>;
  command: CommandHandler;
  deleteCommand: CommandHandler;
  eventHandlers: Map<string, EventHandler[]>;
  registerProvider: ReturnType<typeof vi.fn>;
  unregisterProvider: ReturnType<typeof vi.fn>;
}

async function createHarness(): Promise<Harness> {
  const source = makeProvider("source");
  const providers = new Map<string, Provider>([[source.id, source]]);
  const commands = new Map<string, CommandHandler>();
  const eventHandlers = new Map<string, EventHandler[]>();
  const registerProvider = vi.fn((provider: Provider) => providers.set(provider.id, provider));
  const unregisterProvider = vi.fn((providerId: string) => providers.delete(providerId));

  const pi = {
    on(event: string, handler: EventHandler) {
      const handlers = eventHandlers.get(event) ?? [];
      handlers.push(handler);
      eventHandlers.set(event, handlers);
    },
    registerCommand(
      name: string,
      options: { handler: CommandHandler },
    ) {
      commands.set(name, options.handler);
    },
    registerProvider,
    unregisterProvider,
  } as unknown as ExtensionAPI;

  await createProviderCloneExtension({
    loadSourceProviders: () => [source],
  })(pi);
  const command = commands.get("clone-provider");
  const deleteCommand = commands.get("delete-cloned-provider");
  if (!command) throw new Error("clone-provider command was not registered");
  if (!deleteCommand) throw new Error("delete-cloned-provider command was not registered");

  return {
    providers,
    command,
    deleteCommand,
    eventHandlers,
    registerProvider,
    unregisterProvider,
  };
}

function createCommandContext(
  harness: Harness,
  options: {
    selected: string | undefined;
    input: string | undefined;
    confirmed?: boolean;
    modelProvider?: string;
    notifications: Array<{ message: string; type: string | undefined }>;
  },
): ExtensionCommandContext {
  const allModels = (): Model<Api>[] =>
    [...harness.providers.values()].flatMap((provider) => [...provider.getModels()]);

  return {
    waitForIdle: vi.fn(async () => undefined),
    model:
      options.modelProvider === undefined
        ? undefined
        : harness.providers.get(options.modelProvider)?.getModels()[0],
    modelRegistry: {
      getAll: allModels,
      getProvider: (id: string) => harness.providers.get(id),
      getProviderDisplayName: (id: string) => harness.providers.get(id)?.name ?? id,
    },
    ui: {
      select: vi.fn(async () => options.selected),
      input: vi.fn(async () => options.input),
      confirm: vi.fn(async () => options.confirmed ?? false),
      notify: vi.fn((message: string, type?: string) =>
        options.notifications.push({ message, type }),
      ),
    },
  } as unknown as ExtensionCommandContext;
}

const temporaryDirectories: string[] = [];
let previousAgentDirectory: string | undefined;

afterEach(async () => {
  if (previousAgentDirectory === undefined) {
    delete process.env.PI_CODING_AGENT_DIR;
  } else {
    process.env.PI_CODING_AGENT_DIR = previousAgentDirectory;
  }
  previousAgentDirectory = undefined;
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function useTemporaryAgentDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "pi-provider-clone-index-"));
  temporaryDirectories.push(directory);
  previousAgentDirectory = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = directory;
  return directory;
}

describe.sequential("clone-provider command", () => {
  it("restores a built-in provider during the awaited factory", async () => {
    const agentDirectory = await useTemporaryAgentDirectory();
    await saveCloneStore(
      {
        version: 1,
        clones: [
          {
            sourceId: "openai-codex",
            targetId: "codex-personal",
            createdAt: "2026-07-24T12:00:00.000Z",
          },
        ],
      },
      join(agentDirectory, "provider-clones.json"),
    );

    const registerProvider = vi.fn();
    const eventHandlers = new Map<string, EventHandler[]>();
    const pi = {
      on(event: string, handler: EventHandler) {
        const handlers = eventHandlers.get(event) ?? [];
        handlers.push(handler);
        eventHandlers.set(event, handlers);
      },
      registerCommand: vi.fn(),
      registerProvider,
      unregisterProvider: vi.fn(),
    } as unknown as ExtensionAPI;

    await providerCloneExtension(pi);

    expect(registerProvider).toHaveBeenCalledTimes(1);
    const clone = registerProvider.mock.calls[0]?.[0] as Provider | undefined;
    expect(clone?.id).toBe("codex-personal");
    expect(clone?.getModels()).not.toHaveLength(0);
    expect(clone?.getModels().every((model) => model.provider === "codex-personal")).toBe(true);
  });

  it("registers and persists a clone", async () => {
    const agentDirectory = await useTemporaryAgentDirectory();
    const harness = await createHarness();
    const notifications: Array<{ message: string; type: string | undefined }> = [];
    const ctx = createCommandContext(harness, {
      selected: "Provider source (source)",
      input: "source-personal",
      notifications,
    });

    await harness.command("", ctx);

    expect(harness.registerProvider).toHaveBeenCalledTimes(1);
    expect(harness.providers.get("source-personal")?.getModels()[0]?.provider).toBe(
      "source-personal",
    );
    await expect(loadCloneStore(join(agentDirectory, "provider-clones.json"))).resolves.toMatchObject({
      version: 1,
      clones: [{ sourceId: "source", targetId: "source-personal" }],
    });
    expect(notifications.at(-1)).toMatchObject({
      type: "info",
      message: expect.stringContaining("/login source-personal"),
    });
  });

  it("restores clones in the factory and unloads them before reload", async () => {
    const agentDirectory = await useTemporaryAgentDirectory();
    await saveCloneStore(
      {
        version: 1,
        clones: [
          {
            sourceId: "source",
            targetId: "source-personal",
            createdAt: "2026-07-24T12:00:00.000Z",
          },
        ],
      },
      join(agentDirectory, "provider-clones.json"),
    );
    const harness = await createHarness();
    expect(harness.registerProvider).toHaveBeenCalledTimes(1);
    expect(harness.providers.has("source-personal")).toBe(true);

    const notifications: Array<{ message: string; type: string | undefined }> = [];
    const ctx = createCommandContext(harness, {
      selected: undefined,
      input: undefined,
      notifications,
    });
    const start = harness.eventHandlers.get("session_start")?.[0];
    const shutdown = harness.eventHandlers.get("session_shutdown")?.[0];
    if (!start || !shutdown) throw new Error("Lifecycle handlers were not registered");

    await start({ reason: "startup" }, ctx);
    await start({ reason: "startup" }, ctx);

    expect(harness.registerProvider).toHaveBeenCalledTimes(1);
    expect(notifications).toEqual([]);

    await shutdown({ reason: "reload" }, ctx);
    expect(harness.unregisterProvider).toHaveBeenCalledWith("source-personal");
    expect(harness.providers.has("source-personal")).toBe(false);

    const reloadedHarness = await createHarness();
    expect(reloadedHarness.registerProvider).toHaveBeenCalledTimes(1);
    expect(reloadedHarness.providers.has("source-personal")).toBe(true);

    const reloadedStart = reloadedHarness.eventHandlers.get("session_start")?.[0];
    if (!reloadedStart) throw new Error("Reloaded lifecycle handler was not registered");
    await reloadedStart(
      { reason: "reload" },
      createCommandContext(reloadedHarness, {
        selected: undefined,
        input: undefined,
        notifications,
      }),
    );
    expect(reloadedHarness.registerProvider).toHaveBeenCalledTimes(1);
    expect(reloadedHarness.providers.has("source-personal")).toBe(true);
  });

  it("silently stops when selection or input is cancelled", async () => {
    await useTemporaryAgentDirectory();
    const selectionHarness = await createHarness();
    const selectionNotifications: Array<{ message: string; type: string | undefined }> = [];
    await selectionHarness.command(
      "",
      createCommandContext(selectionHarness, {
        selected: undefined,
        input: "unused",
        notifications: selectionNotifications,
      }),
    );

    const inputHarness = await createHarness();
    const inputNotifications: Array<{ message: string; type: string | undefined }> = [];
    await inputHarness.command(
      "",
      createCommandContext(inputHarness, {
        selected: "Provider source (source)",
        input: undefined,
        notifications: inputNotifications,
      }),
    );

    expect(selectionHarness.registerProvider).not.toHaveBeenCalled();
    expect(inputHarness.registerProvider).not.toHaveBeenCalled();
    expect(selectionNotifications).toEqual([]);
    expect(inputNotifications).toEqual([]);
  });

  it.skipIf(process.platform === "win32")(
    "rolls registration back when persistence fails",
    async () => {
      const agentDirectory = await useTemporaryAgentDirectory();
      await chmod(agentDirectory, 0o500);
      const harness = await createHarness();
      const notifications: Array<{ message: string; type: string | undefined }> = [];
      const ctx = createCommandContext(harness, {
        selected: "Provider source (source)",
        input: "source-personal",
        notifications,
      });

      try {
        await harness.command("", ctx);
      } finally {
        await chmod(agentDirectory, 0o700);
      }

      expect(harness.registerProvider).toHaveBeenCalledTimes(1);
      expect(harness.unregisterProvider).toHaveBeenCalledWith("source-personal");
      expect(harness.providers.has("source-personal")).toBe(false);
      expect(notifications.at(-1)).toMatchObject({
        type: "error",
        message: expect.stringContaining("Unable to save provider clone store"),
      });
    },
  );
});

describe.sequential("delete-cloned-provider command", () => {
  const savedClone = {
    sourceId: "source",
    targetId: "source-personal",
    createdAt: "2026-07-24T12:00:00.000Z",
  } as const;

  it("deletes a restored clone without deleting its Pi credential", async () => {
    const agentDirectory = await useTemporaryAgentDirectory();
    const storePath = join(agentDirectory, "provider-clones.json");
    await saveCloneStore({ version: 1, clones: [savedClone] }, storePath);

    const harness = await createHarness();
    const notifications: Array<{ message: string; type: string | undefined }> = [];
    const start = harness.eventHandlers.get("session_start")?.[0];
    if (!start) throw new Error("session_start handler was not registered");
    await start(
      { reason: "startup" },
      createCommandContext(harness, {
        selected: undefined,
        input: undefined,
        notifications,
      }),
    );

    await harness.deleteCommand(
      "",
      createCommandContext(harness, {
        selected: "source-personal (from source)",
        input: undefined,
        confirmed: true,
        modelProvider: "source-personal",
        notifications,
      }),
    );

    expect(harness.unregisterProvider).toHaveBeenCalledWith("source-personal");
    expect(harness.providers.has("source-personal")).toBe(false);
    await expect(loadCloneStore(storePath)).resolves.toEqual({ version: 1, clones: [] });
    expect(notifications.at(-1)).toMatchObject({
      type: "info",
      message: expect.stringMatching(/credential.*remains.*\/logout/u),
    });
    expect(notifications.at(-1)?.message).toMatch(/active provider.*\/model/u);
  });

  it("removes a saved definition without unregistering a conflicting provider", async () => {
    const agentDirectory = await useTemporaryAgentDirectory();
    const storePath = join(agentDirectory, "provider-clones.json");
    await saveCloneStore({ version: 1, clones: [savedClone] }, storePath);

    const harness = await createHarness();
    const foreignProvider = makeProvider("source-personal");
    harness.providers.set("source-personal", foreignProvider);
    const notifications: Array<{ message: string; type: string | undefined }> = [];
    const start = harness.eventHandlers.get("session_start")?.[0];
    if (!start) throw new Error("session_start handler was not registered");
    await start(
      { reason: "startup" },
      createCommandContext(harness, {
        selected: undefined,
        input: undefined,
        notifications,
      }),
    );

    await harness.deleteCommand(
      "",
      createCommandContext(harness, {
        selected: "source-personal (from source)",
        input: undefined,
        confirmed: true,
        notifications,
      }),
    );

    expect(harness.unregisterProvider).not.toHaveBeenCalled();
    expect(harness.providers.get("source-personal")).toBe(foreignProvider);
    await expect(loadCloneStore(storePath)).resolves.toEqual({ version: 1, clones: [] });
    expect(notifications.at(-1)).toMatchObject({
      type: "info",
      message: expect.stringMatching(/saved clone definition.*left untouched/iu),
    });
  });

  it("keeps the clone when deletion is cancelled", async () => {
    const agentDirectory = await useTemporaryAgentDirectory();
    const storePath = join(agentDirectory, "provider-clones.json");
    await saveCloneStore({ version: 1, clones: [savedClone] }, storePath);

    const harness = await createHarness();
    const notifications: Array<{ message: string; type: string | undefined }> = [];
    await harness.deleteCommand(
      "",
      createCommandContext(harness, {
        selected: "source-personal (from source)",
        input: undefined,
        confirmed: false,
        notifications,
      }),
    );

    expect(harness.unregisterProvider).not.toHaveBeenCalled();
    await expect(loadCloneStore(storePath)).resolves.toEqual({
      version: 1,
      clones: [savedClone],
    });
    expect(notifications).toEqual([]);
  });

  it("warns when there are no saved clones", async () => {
    await useTemporaryAgentDirectory();
    const harness = await createHarness();
    const notifications: Array<{ message: string; type: string | undefined }> = [];

    await harness.deleteCommand(
      "",
      createCommandContext(harness, {
        selected: undefined,
        input: undefined,
        notifications,
      }),
    );

    expect(notifications).toEqual([
      {
        type: "warning",
        message: "No saved provider clones are available to delete.",
      },
    ]);
  });

  it("restores the saved definition when unregistering fails", async () => {
    const agentDirectory = await useTemporaryAgentDirectory();
    const storePath = join(agentDirectory, "provider-clones.json");
    await saveCloneStore({ version: 1, clones: [savedClone] }, storePath);

    const harness = await createHarness();
    const notifications: Array<{ message: string; type: string | undefined }> = [];
    const start = harness.eventHandlers.get("session_start")?.[0];
    if (!start) throw new Error("session_start handler was not registered");
    await start(
      { reason: "startup" },
      createCommandContext(harness, {
        selected: undefined,
        input: undefined,
        notifications,
      }),
    );
    harness.unregisterProvider.mockImplementationOnce(() => {
      throw new Error("unregister failed");
    });

    await harness.deleteCommand(
      "",
      createCommandContext(harness, {
        selected: "source-personal (from source)",
        input: undefined,
        confirmed: true,
        notifications,
      }),
    );

    expect(harness.providers.has("source-personal")).toBe(true);
    await expect(loadCloneStore(storePath)).resolves.toEqual({
      version: 1,
      clones: [savedClone],
    });
    expect(notifications.at(-1)).toMatchObject({
      type: "error",
      message: expect.stringContaining("unregister failed"),
    });
  });

  it.skipIf(process.platform === "win32")(
    "keeps a registered clone when persistence fails",
    async () => {
      const agentDirectory = await useTemporaryAgentDirectory();
      const storePath = join(agentDirectory, "provider-clones.json");
      await saveCloneStore({ version: 1, clones: [savedClone] }, storePath);

      const harness = await createHarness();
      const notifications: Array<{ message: string; type: string | undefined }> = [];
      const start = harness.eventHandlers.get("session_start")?.[0];
      if (!start) throw new Error("session_start handler was not registered");
      await start(
        { reason: "startup" },
        createCommandContext(harness, {
          selected: undefined,
          input: undefined,
          notifications,
        }),
      );
      await chmod(agentDirectory, 0o500);

      try {
        await harness.deleteCommand(
          "",
          createCommandContext(harness, {
            selected: "source-personal (from source)",
            input: undefined,
            confirmed: true,
            notifications,
          }),
        );
      } finally {
        await chmod(agentDirectory, 0o700);
      }

      expect(harness.unregisterProvider).not.toHaveBeenCalled();
      expect(harness.providers.has("source-personal")).toBe(true);
      await expect(loadCloneStore(storePath)).resolves.toEqual({
        version: 1,
        clones: [savedClone],
      });
      expect(notifications.at(-1)).toMatchObject({
        type: "error",
        message: expect.stringContaining("Unable to save provider clone store"),
      });
    },
  );
});
