import type {
  Api,
  Model,
  Provider,
} from "@earendil-works/pi-ai";
import { bridgeStream, toSourceContext, toSourceModel } from "./stream-bridge.js";
import type {
  CloneableProvider,
  ProviderCloneDefinition,
  ProviderLookup,
  ProviderRegistrar,
  ProviderRegistryView,
} from "./types.js";

export class ProviderCloneError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ProviderCloneError";
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function listCloneableProviders(
  registry: ProviderRegistryView,
  cloneTargetIds: ReadonlySet<string>,
): CloneableProvider[] {
  const ids = new Set(registry.getAll().map((model) => model.provider));

  return [...ids]
    .filter((id) => !cloneTargetIds.has(id))
    .map((id) => ({
      id,
      name: registry.getProviderDisplayName(id),
      provider: registry.getProvider(id),
    }))
    .filter((item): item is CloneableProvider => item.provider !== undefined)
    .sort((a, b) => `${a.name} ${a.id}`.localeCompare(`${b.name} ${b.id}`));
}

export function createClonedProvider(source: Provider, targetId: string): Provider {
  const sourceId = source.id;
  let sourceModels: readonly Model<Api>[];

  try {
    sourceModels = source.getModels();
  } catch (error) {
    throw new ProviderCloneError(
      `Cannot clone provider "${sourceId}": reading its models failed: ${describeError(error)}`,
      { cause: error },
    );
  }

  if (sourceModels.length === 0) {
    throw new ProviderCloneError(`Cannot clone provider "${sourceId}": it has no models.`);
  }

  const clonedModels = sourceModels.map((model) => ({ ...model, provider: targetId }));
  const sourceFilterModels = source.filterModels;

  return {
    id: targetId,
    name: targetId,
    ...(source.baseUrl === undefined ? {} : { baseUrl: source.baseUrl }),
    ...(source.headers === undefined ? {} : { headers: source.headers }),
    auth: source.auth,
    getModels: () => clonedModels,
    ...(sourceFilterModels
      ? {
          filterModels(models, credential) {
            const sourceScopedModels = models.map((model) => ({
              ...model,
              provider: sourceId,
            }));
            const allowed = sourceFilterModels(sourceScopedModels, credential);
            const allowedIds = new Set(allowed.map((model) => model.id));
            return models.filter((model) => allowedIds.has(model.id));
          },
        }
      : {}),
    stream(model, context, options) {
      const sourceModel = toSourceModel(model, sourceId);
      const sourceContext = toSourceContext(context, sourceId, targetId);
      return bridgeStream(() => source.stream(sourceModel, sourceContext, options), {
        sourceId,
        targetId,
        targetModel: model,
        signal: options?.signal,
      });
    },
    streamSimple(model, context, options) {
      const sourceModel = toSourceModel(model, sourceId);
      const sourceContext = toSourceContext(context, sourceId, targetId);
      return bridgeStream(() => source.streamSimple(sourceModel, sourceContext, options), {
        sourceId,
        targetId,
        targetModel: model,
        signal: options?.signal,
      });
    },
  };
}

export interface RestoreProviderClonesOptions {
  definitions: readonly ProviderCloneDefinition[];
  registry: ProviderLookup;
  registrar: ProviderRegistrar;
  registeredCloneIds: Set<string>;
  onWarning(message: string): void;
  onRegistered?(definition: ProviderCloneDefinition, provider: Provider): void;
}

export interface RestoreProviderClonesResult {
  registered: string[];
  skipped: string[];
  failed: string[];
}

export function restoreProviderClones(
  options: RestoreProviderClonesOptions,
): RestoreProviderClonesResult {
  const result: RestoreProviderClonesResult = {
    registered: [],
    skipped: [],
    failed: [],
  };

  for (const definition of options.definitions) {
    const { sourceId, targetId } = definition;
    const existing = options.registry.getProvider(targetId);

    if (existing) {
      if (!options.registeredCloneIds.has(targetId)) {
        options.onWarning(
          `Cannot restore provider clone "${targetId}": the target provider ID is already in use.`,
        );
      }
      result.skipped.push(targetId);
      continue;
    }

    const source = options.registry.getProvider(sourceId);
    if (!source) {
      options.onWarning(
        `Cannot restore provider clone "${targetId}": source "${sourceId}" is unavailable.`,
      );
      result.failed.push(targetId);
      continue;
    }

    try {
      const clonedProvider = createClonedProvider(source, targetId);
      options.registrar.registerProvider(clonedProvider);
      options.registeredCloneIds.add(targetId);
      options.onRegistered?.(definition, clonedProvider);
      result.registered.push(targetId);
    } catch (error) {
      options.onWarning(
        `Cannot restore provider clone "${targetId}" from "${sourceId}": ${describeError(error)}`,
      );
      result.failed.push(targetId);
    }
  }

  return result;
}
