import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  createClonedProvider,
  listCloneableProviders,
  restoreProviderClones,
} from "./clone-provider.js";
import { getCloneStorePath, loadCloneStore, saveCloneStore } from "./persistence.js";
import type { ProviderCloneDefinition } from "./types.js";
import { validateTargetProviderId } from "./validation.js";

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export default function providerCloneExtension(pi: ExtensionAPI): void {
  const storePath = getCloneStorePath();
  const registeredCloneIds = new Set<string>();
  const registeredProviders = new Map<string, ReturnType<typeof createClonedProvider>>();
  let restoreAttempted = false;

  pi.on("session_start", async (_event, ctx) => {
    if (restoreAttempted) return;
    restoreAttempted = true;

    let store;
    try {
      store = await loadCloneStore(storePath);
    } catch (error) {
      ctx.ui.notify(describeError(error), "warning");
      return;
    }

    restoreProviderClones({
      definitions: store.clones,
      registry: ctx.modelRegistry,
      registrar: pi,
      registeredCloneIds,
      onWarning: (message) => ctx.ui.notify(message, "warning"),
      onRegistered: (definition, provider) => {
        registeredProviders.set(definition.targetId, provider);
      },
    });
  });

  pi.on("session_shutdown", (event, ctx) => {
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

  pi.registerCommand("clone-provider", {
    description: "Clone a provider under a new provider ID",
    handler: async (_args, ctx) => {
      await ctx.waitForIdle();

      let store;
      try {
        store = await loadCloneStore(storePath);
      } catch (error) {
        ctx.ui.notify(describeError(error), "error");
        return;
      }

      const cloneTargetIds = new Set([
        ...store.clones.map((definition) => definition.targetId),
        ...registeredCloneIds,
      ]);
      const sources = listCloneableProviders(ctx.modelRegistry, cloneTargetIds);
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

      const currentSource = ctx.modelRegistry.getProvider(sourceChoice.id);
      if (!currentSource) {
        ctx.ui.notify(
          `Cannot clone provider "${sourceChoice.id}": the source is no longer available.`,
          "error",
        );
        return;
      }

      let clonedProvider;
      try {
        clonedProvider = createClonedProvider(currentSource, targetId);
        pi.registerProvider(clonedProvider);
        registeredCloneIds.add(targetId);
        registeredProviders.set(targetId, clonedProvider);
      } catch (error) {
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
        await saveCloneStore(
          { version: 1, clones: [...store.clones, definition] },
          storePath,
        );
      } catch (error) {
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

      ctx.ui.notify(
        `Provider "${targetId}" cloned from "${sourceChoice.id}". ` +
          `Run /login ${targetId}, then use /model to select a model.`,
        "info",
      );
    },
  });
}
