import type { ProviderCloneDefinition } from "./types.js";

export const PROVIDER_ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/u;
export const PROVIDER_ID_PATTERN_TEXT = "^[a-z0-9][a-z0-9._-]*$";

export interface TargetProviderValidationOptions {
  sourceId: string;
  definitions: readonly ProviderCloneDefinition[];
  providerExists(id: string): boolean;
}

export function validateProviderId(providerId: string): string | undefined {
  if (providerId.length === 0) {
    return "Provider ID is required.";
  }

  if (!PROVIDER_ID_PATTERN.test(providerId)) {
    return `Provider ID must match: ${PROVIDER_ID_PATTERN_TEXT}`;
  }

  return undefined;
}

export function validateTargetProviderId(
  targetId: string,
  options: TargetProviderValidationOptions,
): string | undefined {
  const formatError = validateProviderId(targetId);
  if (formatError) return formatError;

  if (targetId === options.sourceId) {
    return "Source and target provider IDs must be different.";
  }

  if (options.definitions.some((definition) => definition.targetId === targetId)) {
    return `Provider ID "${targetId}" is already used by a saved provider clone.`;
  }

  if (options.providerExists(targetId)) {
    return `Provider ID "${targetId}" already exists.`;
  }

  return undefined;
}
