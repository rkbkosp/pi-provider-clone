import {
  InMemoryCredentialStore,
  InMemoryModelsStore,
  type Provider,
} from "@earendil-works/pi-ai";
import {
  ModelRuntime,
  type ExtensionAPI,
  type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import {
  createClonedProvider,
  listCloneableProviders,
  restoreProviderClones,
} from "./clone-provider.js";
import {
  getCloneStorePath,
  loadCloneStore,
  updateCloneStore,
} from "./persistence.js";
import type { ProviderCloneDefinition } from "./types.js";
import { validateTargetProviderId } from "./validation.js";

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isAbortError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "AbortError" || (error as Error & { code?: unknown }).code === "ABORT_ERR")
  );
}

async function loadFactorySourceProviders(): Promise<readonly Provider[]> {
  const runtime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsStore: new InMemoryModelsStore(),
    allowModelNetwork: false,
  });
  return runtime.getProviders();
}

export interface ProviderCloneExtensionDependencies {
  getStorePath?(): string;
  loadSourceProviders?(): readonly Provider[] | Promise<readonly Provider[]>;
}

interface CommandLifetime {
  generation: number;
  controller: AbortController;
}

export function createProviderCloneExtension(
  dependencies: ProviderCloneExtensionDependencies = {},
): ExtensionFactory {
  const getStorePath = dependencies.getStorePath ?? getCloneStorePath;
  const loadSourceProviders =
    dependencies.loadSourceProviders ?? loadFactorySourceProviders;

  return async function providerCloneExtension(pi: ExtensionAPI): Promise<void> {
    const storePath = getStorePath();
    const registeredCloneIds = new Set<string>();
    const registeredProviders = new Map<
      string,
      ReturnType<typeof createClonedProvider>
    >();
    const startupWarnings: string[] = [];
    const sourceProviders = new Map<string, Provider>();
    const inFlightCommands = new Set<AbortController>();
    const pendingStoreOperations = new Set<Promise<unknown>>();
    let sessionGeneration = 0;
    let sessionActive = true;

    const beginCommand = (): CommandLifetime => {
      const controller = new AbortController();
      const lifetime = { generation: sessionGeneration, controller };
      if (!sessionActive) controller.abort();
      inFlightCommands.add(controller);
      return lifetime;
    };
    const commandIsCurrent = (lifetime: CommandLifetime): boolean =>
      sessionActive &&
      sessionGeneration === lifetime.generation &&
      !lifetime.controller.signal.aborted;
    const finishCommand = (lifetime: CommandLifetime): void => {
      inFlightCommands.delete(lifetime.controller);
    };
    const invalidateCommandLifetimes = (): void => {
      sessionActive = false;
      sessionGeneration += 1;
      for (const controller of inFlightCommands) controller.abort();
      inFlightCommands.clear();
    };
    const trackStoreOperation = <T>(operation: Promise<T>): Promise<T> => {
      pendingStoreOperations.add(operation);
      void operation
        .finally(() => pendingStoreOperations.delete(operation))
        .catch(() => undefined);
      return operation;
    };

    try {
      for (const provider of await loadSourceProviders()) {
        sourceProviders.set(provider.id, provider);
      }
    } catch (error) {
      startupWarnings.push(
        `Unable to initialize the provider clone source catalog: ${describeError(error)}`,
      );
    }

    try {
      const store = await loadCloneStore(storePath);
      restoreProviderClones({
        definitions: store.clones,
        registry: { getProvider: (id) => sourceProviders.get(id) },
        registrar: pi,
        registeredCloneIds,
        onWarning: (message) => startupWarnings.push(message),
        onRegistered: (definition, provider) => {
          registeredProviders.set(definition.targetId, provider);
        },
      });
    } catch (error) {
      startupWarnings.push(describeError(error));
    }

    let startupWarningsReported = false;
    pi.on("session_start", (_event, ctx) => {
      sessionGeneration += 1;
      sessionActive = true;

      if (startupWarningsReported) return;
      startupWarningsReported = true;

      for (const warning of startupWarnings) {
        ctx.ui.notify(warning, "warning");
      }
    });

    pi.on("session_shutdown", async (event, ctx) => {
      invalidateCommandLifetimes();
      if (pendingStoreOperations.size > 0) {
        await Promise.allSettled([...pendingStoreOperations]);
      }
      if (event.reason === "quit") return;

      for (const targetId of registeredCloneIds) {
        const registeredProvider = registeredProviders.get(targetId);
        if (registeredProvider && ctx.modelRegistry.getProvider(targetId) !== registeredProvider) {
          continue;
        }

        try {
          pi.unregisterProvider(targetId);
        } catch (error) {
          ctx.ui.notify(
            `Failed to unload provider clone "${targetId}": ${describeError(error)}`,
            "warning",
          );
        }
      }

      registeredCloneIds.clear();
      registeredProviders.clear();
    });

    pi.registerCommand("delete-cloned-provider", {
      description: "Delete a provider clone created by this extension",
      handler: async (_args, ctx) => {
        const lifetime = beginCommand();
        try {
          await ctx.waitForIdle();
          if (!commandIsCurrent(lifetime)) return;

          let store;
          try {
            store = await loadCloneStore(storePath);
          } catch (error) {
            if (!commandIsCurrent(lifetime)) return;
            ctx.ui.notify(describeError(error), "error");
            return;
          }
          if (!commandIsCurrent(lifetime)) return;

          if (store.clones.length === 0) {
            ctx.ui.notify("No saved provider clones are available to delete.", "warning");
            return;
          }

          const definitionByLabel = new Map<string, ProviderCloneDefinition>(
            [...store.clones]
              .sort((a, b) => a.targetId.localeCompare(b.targetId))
              .map((definition) => [
                `${definition.targetId} (from ${definition.sourceId})`,
                definition,
              ]),
          );
          const selectedLabel = await ctx.ui.select(
            "Select provider clone to delete:",
            [...definitionByLabel.keys()],
          );
          if (!commandIsCurrent(lifetime)) return;
          if (selectedLabel === undefined) return;

          const definition = definitionByLabel.get(selectedLabel);
          if (!definition) {
            ctx.ui.notify("The selected provider clone is no longer available.", "error");
            return;
          }

          const registeredProvider = registeredProviders.get(definition.targetId);
          const ownsRegisteredProvider =
            registeredProvider !== undefined &&
            ctx.modelRegistry.getProvider(definition.targetId) === registeredProvider;
          const isActive =
            ownsRegisteredProvider && ctx.model?.provider === definition.targetId;
          const activeWarning = isActive
            ? "\n\nThis provider is currently active. Use /model to select another model before sending another prompt."
            : "";
          const deletionDescription = ownsRegisteredProvider
            ? "The provider and its saved clone definition will be removed. "
            : "Only the saved clone definition will be removed; the provider currently using this ID will be left untouched. ";
          const confirmed = await ctx.ui.confirm(
            "Delete provider clone?",
            `Delete "${definition.targetId}", cloned from "${definition.sourceId}"?\n\n` +
              deletionDescription +
              `Credentials stored by Pi for this provider ID will remain; use /logout to remove them.${activeWarning}`,
          );
          if (!commandIsCurrent(lifetime)) return;
          if (!confirmed) return;

          try {
            await trackStoreOperation(
              updateCloneStore(
                (current) => {
                  const currentDefinition = current.clones.find(
                    (saved) => saved.targetId === definition.targetId,
                  );
                  if (
                    !currentDefinition ||
                    currentDefinition.sourceId !== definition.sourceId ||
                    currentDefinition.createdAt !== definition.createdAt
                  ) {
                    throw new Error(
                      `Provider clone "${definition.targetId}" changed while deletion was being confirmed. Try again.`,
                    );
                  }

                  return {
                    version: 1,
                    clones: current.clones.filter(
                      (saved) => saved.targetId !== definition.targetId,
                    ),
                  };
                },
                storePath,
                { signal: lifetime.controller.signal },
              ),
            );
          } catch (error) {
            if (!commandIsCurrent(lifetime) || isAbortError(error)) return;
            ctx.ui.notify(describeError(error), "error");
            return;
          }
          if (!commandIsCurrent(lifetime)) return;

          if (registeredProvider && ownsRegisteredProvider) {
            try {
              pi.unregisterProvider(definition.targetId);
            } catch (error) {
              if (!commandIsCurrent(lifetime)) return;
              const rollbackErrors: string[] = [];

              try {
                if (ctx.modelRegistry.getProvider(definition.targetId) === undefined) {
                  pi.registerProvider(registeredProvider);
                }
              } catch (rollbackError) {
                rollbackErrors.push(`provider rollback failed: ${describeError(rollbackError)}`);
              }

              try {
                await trackStoreOperation(
                  updateCloneStore(
                    (current) => {
                      const currentDefinition = current.clones.find(
                        (saved) => saved.targetId === definition.targetId,
                      );
                      if (currentDefinition) {
                        if (
                          currentDefinition.sourceId === definition.sourceId &&
                          currentDefinition.createdAt === definition.createdAt
                        ) {
                          return current;
                        }
                        throw new Error("the target ID is now used by another clone definition");
                      }
                      return { version: 1, clones: [...current.clones, definition] };
                    },
                    storePath,
                    { signal: lifetime.controller.signal },
                  ),
                );
              } catch (rollbackError) {
                if (!commandIsCurrent(lifetime) || isAbortError(rollbackError)) return;
                rollbackErrors.push(`store rollback failed: ${describeError(rollbackError)}`);
              }
              if (!commandIsCurrent(lifetime)) return;

              const rollbackSuffix =
                rollbackErrors.length > 0 ? ` Rollback errors: ${rollbackErrors.join("; ")}` : "";
              ctx.ui.notify(
                `Failed to unregister provider clone "${definition.targetId}": ${describeError(error)}${rollbackSuffix}`,
                "error",
              );
              return;
            }
          }

          registeredCloneIds.delete(definition.targetId);
          registeredProviders.delete(definition.targetId);

          const activeSuffix = isActive
            ? " It was the active provider; use /model to select another model before continuing."
            : "";
          const deletionResult = ownsRegisteredProvider
            ? `Provider clone "${definition.targetId}" deleted. `
            : `Saved clone definition for "${definition.targetId}" deleted; the provider currently using this ID was left untouched. `;
          ctx.ui.notify(
            deletionResult +
              `Any credential stored by Pi for this provider ID remains available to /logout.${activeSuffix}`,
            "info",
          );
        } catch (error) {
          if (!commandIsCurrent(lifetime)) return;
          throw error;
        } finally {
          finishCommand(lifetime);
        }
      },
    });

    pi.registerCommand("clone-provider", {
      description: "Clone a provider under a new provider ID",
      handler: async (_args, ctx) => {
        const lifetime = beginCommand();
        try {
          await ctx.waitForIdle();
          if (!commandIsCurrent(lifetime)) return;

          let store;
          try {
            store = await loadCloneStore(storePath);
          } catch (error) {
            if (!commandIsCurrent(lifetime)) return;
            ctx.ui.notify(describeError(error), "error");
            return;
          }
          if (!commandIsCurrent(lifetime)) return;

          const cloneTargetIds = new Set([
            ...store.clones.map((definition) => definition.targetId),
            ...registeredCloneIds,
          ]);
          const sources = listCloneableProviders(ctx.modelRegistry, cloneTargetIds).filter(
            (source) => sourceProviders.has(source.id),
          );
          if (sources.length === 0) {
            ctx.ui.notify("No cloneable providers with models are available.", "warning");
            return;
          }

          const sourceByLabel = new Map<string, (typeof sources)[number]>(
            sources.map((source) => [`${source.name} (${source.id})`, source]),
          );
          const selectedLabel = await ctx.ui.select(
            "Select source provider:",
            [...sourceByLabel.keys()],
          );
          if (!commandIsCurrent(lifetime)) return;
          if (selectedLabel === undefined) return;

          const sourceChoice = sourceByLabel.get(selectedLabel);
          if (!sourceChoice) {
            ctx.ui.notify("The selected source provider is no longer available.", "error");
            return;
          }

          const targetId = await ctx.ui.input(
            "New provider ID:",
            `${sourceChoice.id}-personal`,
          );
          if (!commandIsCurrent(lifetime)) return;
          if (targetId === undefined) return;

          const validationError = validateTargetProviderId(targetId, {
            sourceId: sourceChoice.id,
            definitions: store.clones,
            providerExists: (id) => ctx.modelRegistry.getProvider(id) !== undefined,
          });
          if (validationError) {
            ctx.ui.notify(validationError, "error");
            return;
          }

          const factorySource = sourceProviders.get(sourceChoice.id);
          if (!factorySource) {
            ctx.ui.notify(
              `Cannot clone provider "${sourceChoice.id}": the factory source is no longer available.`,
              "error",
            );
            return;
          }

          let clonedProvider;
          try {
            clonedProvider = createClonedProvider(factorySource, targetId);
            pi.registerProvider(clonedProvider);
            registeredCloneIds.add(targetId);
            registeredProviders.set(targetId, clonedProvider);
          } catch (error) {
            if (!commandIsCurrent(lifetime)) return;
            let rollbackError: unknown;
            try {
              if (
                clonedProvider &&
                ctx.modelRegistry.getProvider(targetId) === clonedProvider
              ) {
                pi.unregisterProvider(targetId);
              }
            } catch (caught) {
              rollbackError = caught;
            }

            const rollbackSuffix = rollbackError
              ? ` Rollback also failed: ${describeError(rollbackError)}`
              : "";
            ctx.ui.notify(
              `Failed to register provider clone "${targetId}": ${describeError(error)}${rollbackSuffix}`,
              "error",
            );
            return;
          }

          const definition: ProviderCloneDefinition = {
            sourceId: sourceChoice.id,
            targetId,
            createdAt: new Date().toISOString(),
          };

          try {
            await trackStoreOperation(
              updateCloneStore(
                (current) => {
                  if (current.clones.some((saved) => saved.targetId === targetId)) {
                    throw new Error(
                      `Provider clone target "${targetId}" was added by another process. Try another ID.`,
                    );
                  }
                  return { version: 1, clones: [...current.clones, definition] };
                },
                storePath,
                { signal: lifetime.controller.signal },
              ),
            );
          } catch (error) {
            if (!commandIsCurrent(lifetime) || isAbortError(error)) return;
            let rollbackError: unknown;
            try {
              if (ctx.modelRegistry.getProvider(targetId) === clonedProvider) {
                pi.unregisterProvider(targetId);
              }
            } catch (caught) {
              rollbackError = caught;
            }
            registeredCloneIds.delete(targetId);
            registeredProviders.delete(targetId);

            const rollbackSuffix = rollbackError
              ? ` Rollback also failed: ${describeError(rollbackError)}`
              : "";
            ctx.ui.notify(`${describeError(error)}${rollbackSuffix}`, "error");
            return;
          }
          if (!commandIsCurrent(lifetime)) return;

          ctx.ui.notify(
            `Provider "${targetId}" cloned from "${sourceChoice.id}". ` +
              `Run /login ${targetId}, then use /model to select a model.`,
            "info",
          );
        } catch (error) {
          if (!commandIsCurrent(lifetime)) return;
          throw error;
        } finally {
          finishCommand(lifetime);
        }
      },
    });
  };
}

export default createProviderCloneExtension();
