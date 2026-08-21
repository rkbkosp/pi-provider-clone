import { mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Provider } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createProviderCloneExtension } from "../index.js";
import { loadCloneStore, saveCloneStore } from "../persistence.js";
import { makeProvider } from "./helpers.js";

const STALE_CONTEXT_ERROR =
  "This extension ctx is stale after session replacement or reload";

type CommandHandler = (args: string, ctx: ExtensionCommandContext) => Promise<void>;
type EventHandler = (event: { reason?: string }, ctx: ExtensionContext) => unknown;

interface GuardedContextOptions {
  providers: Map<string, Provider>;
  valid: { value: boolean };
  selected?: string;
  input?: string;
  confirmed?: boolean;
  notifications: Array<{ message: string; type: string | undefined }>;
  onConfirm?: () => void;
}

function createGuardedContext(options: GuardedContextOptions): ExtensionCommandContext {
  const assertValid = () => {
    if (!options.valid.value) throw new Error(STALE_CONTEXT_ERROR);
  };
  const allModels = () =>
    [...options.providers.values()].flatMap((provider) => [...provider.getModels()]);
  const modelRegistry = {
    getAll: () => {
      assertValid();
      return allModels();
    },
    getProvider: (id: string) => {
      assertValid();
      return options.providers.get(id);
    },
    getProviderDisplayName: (id: string) => {
      assertValid();
      return options.providers.get(id)?.name ?? id;
    },
  };
  const ui = {
    select: vi.fn(async () => {
      assertValid();
      return options.selected;
    }),
    input: vi.fn(async () => {
      assertValid();
      return options.input;
    }),
    confirm: vi.fn(async () => {
      assertValid();
      options.onConfirm?.();
      return options.confirmed ?? false;
    }),
    notify: vi.fn((message: string, type?: string) => {
      assertValid();
      options.notifications.push({ message, type });
    }),
  };

  return {
    waitForIdle: vi.fn(async () => {
      assertValid();
    }),
    get modelRegistry() {
      assertValid();
      return modelRegistry;
    },
    get model() {
      assertValid();
      return undefined;
    },
    get ui() {
      assertValid();
      return ui;
    },
  } as unknown as ExtensionCommandContext;
}

interface Harness {
  providers: Map<string, Provider>;
  cloneCommand: CommandHandler;
  deleteCommand: CommandHandler;
  start: EventHandler;
  recover: EventHandler;
  shutdown: EventHandler;
  registerProvider: ReturnType<typeof vi.fn>;
  unregisterProvider: ReturnType<typeof vi.fn>;
}

async function createHarness(storePath: string): Promise<Harness> {
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
    registerCommand(name: string, options: { handler: CommandHandler }) {
      commands.set(name, options.handler);
    },
    registerProvider,
    unregisterProvider,
  } as unknown as ExtensionAPI;

  await createProviderCloneExtension({
    getStorePath: () => storePath,
    loadSourceProviders: () => [source],
  })(pi);

  const cloneCommand = commands.get("clone-provider");
  const deleteCommand = commands.get("delete-cloned-provider");
  const start = eventHandlers.get("session_start")?.[0];
  const recover = eventHandlers.get("turn_start")?.[0];
  const shutdown = eventHandlers.get("session_shutdown")?.[0];
  if (!cloneCommand || !deleteCommand || !start || !recover || !shutdown) {
    throw new Error("provider clone lifecycle hooks were not registered");
  }

  return {
    providers,
    cloneCommand,
    deleteCommand,
    start,
    recover,
    shutdown,
    registerProvider,
    unregisterProvider,
  };
}

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function temporaryStorePath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "pi-provider-clone-stale-"));
  temporaryDirectories.push(directory);
  return join(directory, "provider-clones.json");
}

describe.sequential("session replacement cancellation", () => {
  it("does not inspect a stale ctx if a recovery callback arrives after shutdown", async () => {
    const harness = await createHarness(await temporaryStorePath());
    const valid = { value: true };
    const notifications: Array<{ message: string; type: string | undefined }> = [];
    const ctx = createGuardedContext({
      providers: harness.providers,
      valid,
      notifications,
    });

    await harness.start({ reason: "startup" }, ctx);
    await harness.shutdown({ reason: "reload" }, ctx);
    valid.value = false;

    expect(() => harness.recover({}, ctx)).not.toThrow();
    expect(notifications).toEqual([]);
  });

  it("aborts a clone waiting on persistence without touching the stale command ctx", async () => {
    const storePath = await temporaryStorePath();
    const lockPath = `${storePath}.lock`;
    await writeFile(lockPath, "external-lock\n", "utf8");
    const harness = await createHarness(storePath);
    const valid = { value: true };
    const notifications: Array<{ message: string; type: string | undefined }> = [];
    const ctx = createGuardedContext({
      providers: harness.providers,
      valid,
      selected: "Provider source (source)",
      input: "source-personal",
      notifications,
    });

    await harness.start({ reason: "startup" }, ctx);
    const commandPromise = harness.cloneCommand("", ctx);
    await vi.waitFor(() => expect(harness.registerProvider).toHaveBeenCalledTimes(1));

    await harness.shutdown({ reason: "reload" }, ctx);
    valid.value = false;
    await commandPromise;
    await unlink(lockPath).catch(() => undefined);

    expect(harness.providers.has("source-personal")).toBe(false);
    expect(harness.unregisterProvider).toHaveBeenCalledWith("source-personal");
    await expect(loadCloneStore(storePath)).resolves.toEqual({ version: 1, clones: [] });
    expect(notifications).toEqual([]);
  });

  it("aborts a delete waiting on persistence and preserves the saved definition", async () => {
    const storePath = await temporaryStorePath();
    const definition = {
      sourceId: "source",
      targetId: "source-personal",
      createdAt: "2026-08-18T00:00:00.000Z",
    } as const;
    await saveCloneStore({ version: 1, clones: [definition] }, storePath);
    const harness = await createHarness(storePath);
    const lockPath = `${storePath}.lock`;
    await writeFile(lockPath, "external-lock\n", "utf8");
    const valid = { value: true };
    const notifications: Array<{ message: string; type: string | undefined }> = [];
    let confirmed = false;
    const ctx = createGuardedContext({
      providers: harness.providers,
      valid,
      selected: "source-personal (from source)",
      confirmed: true,
      notifications,
      onConfirm: () => {
        confirmed = true;
      },
    });

    await harness.start({ reason: "startup" }, ctx);
    const commandPromise = harness.deleteCommand("", ctx);
    await vi.waitFor(() => expect(confirmed).toBe(true));

    await harness.shutdown({ reason: "reload" }, ctx);
    valid.value = false;
    await commandPromise;
    await unlink(lockPath).catch(() => undefined);

    expect(harness.providers.has("source-personal")).toBe(false);
    expect(harness.unregisterProvider).toHaveBeenCalledWith("source-personal");
    await expect(loadCloneStore(storePath)).resolves.toEqual({
      version: 1,
      clones: [definition],
    });
    expect(notifications).toEqual([]);
  });
});
