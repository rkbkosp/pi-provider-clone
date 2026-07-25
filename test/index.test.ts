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
import providerCloneExtension from "../index.js";
import { loadCloneStore, saveCloneStore } from "../persistence.js";
import { makeModel, makeProvider } from "./helpers.js";

type CommandHandler = (args: string, ctx: ExtensionCommandContext) => Promise<void>;
type EventHandler = (event: { reason?: string }, ctx: ExtensionContext) => unknown;

interface Harness {
  providers: Map<string, Provider>;
  command: CommandHandler;
  eventHandlers: Map<string, EventHandler[]>;
  registerProvider: ReturnType<typeof vi.fn>;
  unregisterProvider: ReturnType<typeof vi.fn>;
}

function createHarness(): Harness {
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

  providerCloneExtension(pi);
  const command = commands.get("clone-provider");
  if (!command) throw new Error("clone-provider command was not registered");

  return {
    providers,
    command,
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
    notifications: Array<{ message: string; type: string | undefined }>;
  },
): ExtensionCommandContext {
  const allModels = (): Model<Api>[] =>
    [...harness.providers.values()].flatMap((provider) => [...provider.getModels()]);

  return {
    waitForIdle: vi.fn(async () => undefined),
    modelRegistry: {
      getAll: allModels,
      getProvider: (id: string) => harness.providers.get(id),
      getProviderDisplayName: (id: string) => harness.providers.get(id)?.name ?? id,
    },
    ui: {
      select: vi.fn(async () => options.selected),
      input: vi.fn(async () => options.input),
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
  it("registers and persists a clone", async () => {
    const agentDirectory = await useTemporaryAgentDirectory();
    const harness = createHarness();
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

  it("restores clones idempotently and unloads them before reload", async () => {
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
    const harness = createHarness();
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
    expect(harness.providers.has("source-personal")).toBe(true);
    expect(notifications).toEqual([]);

    await shutdown({ reason: "reload" }, ctx);
    expect(harness.unregisterProvider).toHaveBeenCalledWith("source-personal");
    expect(harness.providers.has("source-personal")).toBe(false);

    const reloadedHarness = createHarness();
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
    const selectionHarness = createHarness();
    const selectionNotifications: Array<{ message: string; type: string | undefined }> = [];
    await selectionHarness.command(
      "",
      createCommandContext(selectionHarness, {
        selected: undefined,
        input: "unused",
        notifications: selectionNotifications,
      }),
    );

    const inputHarness = createHarness();
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

  it("rolls registration back when persistence fails", async () => {
    const agentDirectory = await useTemporaryAgentDirectory();
    await chmod(agentDirectory, 0o500);
    const harness = createHarness();
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
  });
});
