import { mkdtemp, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CloneStoreError,
  emptyCloneStore,
  getCloneStorePath,
  loadCloneStore,
  parseCloneStore,
  saveCloneStore,
  updateCloneStore,
} from "../persistence.js";
import type { ProviderCloneStore } from "../types.js";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "pi-provider-clone-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

const store: ProviderCloneStore = {
  version: 1,
  clones: [
    {
      sourceId: "openai-codex",
      targetId: "openai-codex-personal",
      createdAt: "2026-07-24T12:00:00.000Z",
    },
  ],
};

describe("clone store persistence", () => {
  it("uses PI_CODING_AGENT_DIR and expands a leading home shortcut", () => {
    expect(getCloneStorePath({ PI_CODING_AGENT_DIR: "/custom/pi" }, "/home/test")).toBe(
      join("/custom/pi", "provider-clones.json"),
    );
    expect(getCloneStorePath({ PI_CODING_AGENT_DIR: "~/agent" }, "/home/test")).toBe(
      join("/home/test", "agent", "provider-clones.json"),
    );
    expect(getCloneStorePath({}, "/home/test")).toBe(
      join("/home/test", ".pi", "agent", "provider-clones.json"),
    );
  });

  it("treats a missing file as an empty store", async () => {
    const directory = await temporaryDirectory();
    await expect(loadCloneStore(join(directory, "missing.json"))).resolves.toEqual(
      emptyCloneStore(),
    );
  });

  it("round-trips through an atomic 0600 file", async () => {
    const directory = await temporaryDirectory();
    const storePath = join(directory, "nested", "provider-clones.json");

    await saveCloneStore(store, storePath);

    await expect(loadCloneStore(storePath)).resolves.toEqual(store);
    if (process.platform !== "win32") {
      expect((await stat(storePath)).mode & 0o777).toBe(0o600);
    }
    expect(await readdir(join(directory, "nested"))).toEqual(["provider-clones.json"]);
  });

  it("serializes concurrent read-modify-write updates", async () => {
    const directory = await temporaryDirectory();
    const storePath = join(directory, "provider-clones.json");
    let releaseFirst!: () => void;
    let markFirstEntered!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const firstEntered = new Promise<void>((resolve) => {
      markFirstEntered = resolve;
    });

    const firstUpdate = updateCloneStore(async (current) => {
      markFirstEntered();
      await firstGate;
      return {
        version: 1,
        clones: [
          ...current.clones,
          {
            sourceId: "openai-codex",
            targetId: "openai-codex-personal",
            createdAt: "2026-07-24T12:00:00.000Z",
          },
        ],
      };
    }, storePath);
    await firstEntered;

    const secondUpdate = updateCloneStore((current) => ({
      version: 1,
      clones: [
        ...current.clones,
        {
          sourceId: "anthropic",
          targetId: "anthropic-work",
          createdAt: "2026-07-24T13:00:00.000Z",
        },
      ],
    }), storePath);

    releaseFirst();
    await Promise.all([firstUpdate, secondUpdate]);

    await expect(loadCloneStore(storePath)).resolves.toMatchObject({
      clones: [
        { targetId: "openai-codex-personal" },
        { targetId: "anthropic-work" },
      ],
    });
    expect(await readdir(directory)).toEqual(["provider-clones.json"]);
  });

  it("reports malformed JSON without overwriting it", async () => {
    const directory = await temporaryDirectory();
    const storePath = join(directory, "provider-clones.json");
    const malformed = "{ definitely not JSON\n";
    await writeFile(storePath, malformed, "utf8");

    await expect(loadCloneStore(storePath)).rejects.toBeInstanceOf(CloneStoreError);
    expect(await readFile(storePath, "utf8")).toBe(malformed);
  });

  it("requires canonical ISO timestamps", () => {
    expect(() =>
      parseCloneStore({
        version: 1,
        clones: [
          {
            sourceId: "source",
            targetId: "target",
            createdAt: "July 24, 2026",
          },
        ],
      }),
    ).toThrow(/ISO date string/u);

    expect(() =>
      parseCloneStore({
        version: 1,
        clones: [
          {
            sourceId: "source",
            targetId: "target",
            createdAt: "2026-02-31T12:00:00.000Z",
          },
        ],
      }),
    ).toThrow(/ISO date string/u);
  });

  it("rejects duplicate targets and clone-of-clone definitions", () => {
    expect(() =>
      parseCloneStore({
        version: 1,
        clones: [store.clones[0], store.clones[0]],
      }),
    ).toThrow(/duplicate clone target/u);

    expect(() =>
      parseCloneStore({
        version: 1,
        clones: [
          store.clones[0],
          {
            sourceId: "openai-codex-personal",
            targetId: "nested-clone",
            createdAt: "2026-07-24T13:00:00.000Z",
          },
        ],
      }),
    ).toThrow(/clone-of-clone/u);
  });

  it("validates before replacing an existing file", async () => {
    const directory = await temporaryDirectory();
    const storePath = join(directory, "provider-clones.json");
    await writeFile(storePath, "keep me", "utf8");

    await expect(
      saveCloneStore(
        {
          version: 1,
          clones: [
            {
              sourceId: "invalid/source",
              targetId: "target",
              createdAt: "2026-07-24T12:00:00.000Z",
            },
          ],
        },
        storePath,
      ),
    ).rejects.toBeInstanceOf(CloneStoreError);
    expect(await readFile(storePath, "utf8")).toBe("keep me");
  });
});
