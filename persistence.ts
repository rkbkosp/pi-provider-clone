import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ProviderCloneDefinition, ProviderCloneStore } from "./types.js";
import { PROVIDER_ID_PATTERN } from "./validation.js";

export const CLONE_STORE_FILENAME = "provider-clones.json";

export class CloneStoreError extends Error {
  readonly storePath: string;

  constructor(message: string, storePath: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "CloneStoreError";
    this.storePath = storePath;
  }
}

export function emptyCloneStore(): ProviderCloneStore {
  return { version: 1, clones: [] };
}

export function getCloneStorePath(
  env: NodeJS.ProcessEnv = process.env,
  homeDirectory = homedir(),
): string {
  let agentDirectory = env.PI_CODING_AGENT_DIR || join(homeDirectory, ".pi", "agent");
  if (agentDirectory === "~") {
    agentDirectory = homeDirectory;
  } else if (agentDirectory.startsWith("~/")) {
    agentDirectory = join(homeDirectory, agentDirectory.slice(2));
  }
  return join(agentDirectory, CLONE_STORE_FILENAME);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseDefinition(value: unknown, index: number): ProviderCloneDefinition {
  if (!isRecord(value)) {
    throw new Error(`clones[${index}] must be an object`);
  }

  const { sourceId, targetId, createdAt } = value;
  if (typeof sourceId !== "string" || !PROVIDER_ID_PATTERN.test(sourceId)) {
    throw new Error(`clones[${index}].sourceId is not a valid provider ID`);
  }
  if (typeof targetId !== "string" || !PROVIDER_ID_PATTERN.test(targetId)) {
    throw new Error(`clones[${index}].targetId is not a valid provider ID`);
  }
  if (sourceId === targetId) {
    throw new Error(`clones[${index}] has identical source and target IDs`);
  }
  if (
    typeof createdAt !== "string" ||
    !Number.isFinite(Date.parse(createdAt)) ||
    new Date(createdAt).toISOString() !== createdAt
  ) {
    throw new Error(`clones[${index}].createdAt must be an ISO date string`);
  }

  return { sourceId, targetId, createdAt };
}

export function parseCloneStore(value: unknown): ProviderCloneStore {
  if (!isRecord(value)) {
    throw new Error("store must be an object");
  }
  if (value.version !== 1) {
    throw new Error(`unsupported store version: ${String(value.version)}`);
  }
  if (!Array.isArray(value.clones)) {
    throw new Error("clones must be an array");
  }

  const clones = value.clones.map(parseDefinition);
  const targetIds = new Set<string>();
  for (const definition of clones) {
    if (targetIds.has(definition.targetId)) {
      throw new Error(`duplicate clone target ID: ${definition.targetId}`);
    }
    targetIds.add(definition.targetId);
  }

  for (const definition of clones) {
    if (targetIds.has(definition.sourceId)) {
      throw new Error(
        `clone-of-clone definitions are not supported: ${definition.sourceId} -> ${definition.targetId}`,
      );
    }
  }

  return { version: 1, clones };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isMissingFileError(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}

export async function loadCloneStore(storePath = getCloneStorePath()): Promise<ProviderCloneStore> {
  let contents: string;
  try {
    contents = await readFile(storePath, "utf8");
  } catch (error) {
    if (isMissingFileError(error)) return emptyCloneStore();
    throw new CloneStoreError(
      `Unable to read provider clone store "${storePath}": ${errorMessage(error)}`,
      storePath,
      { cause: error },
    );
  }

  try {
    return parseCloneStore(JSON.parse(contents) as unknown);
  } catch (error) {
    throw new CloneStoreError(
      `Invalid provider clone store "${storePath}": ${errorMessage(error)}`,
      storePath,
      { cause: error },
    );
  }
}

export async function saveCloneStore(
  store: ProviderCloneStore,
  storePath = getCloneStorePath(),
): Promise<void> {
  let validated: ProviderCloneStore;
  try {
    validated = parseCloneStore(store);
  } catch (error) {
    throw new CloneStoreError(
      `Refusing to write invalid provider clone store "${storePath}": ${errorMessage(error)}`,
      storePath,
      { cause: error },
    );
  }

  const directory = dirname(storePath);
  const temporaryPath = join(
    directory,
    `.${CLONE_STORE_FILENAME}.${process.pid}.${randomUUID()}.tmp`,
  );

  try {
    await mkdir(directory, { recursive: true });
    await writeFile(temporaryPath, `${JSON.stringify(validated, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    await chmod(temporaryPath, 0o600);
    await rename(temporaryPath, storePath);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw new CloneStoreError(
      `Unable to save provider clone store "${storePath}": ${errorMessage(error)}`,
      storePath,
      { cause: error },
    );
  }
}
