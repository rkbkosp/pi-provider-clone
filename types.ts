import type { Provider } from "@earendil-works/pi-ai";

export interface ProviderCloneDefinition {
  sourceId: string;
  targetId: string;
  createdAt: string;
}

export interface ProviderCloneStore {
  version: 1;
  clones: ProviderCloneDefinition[];
}

export interface CloneableProvider {
  id: string;
  name: string;
  provider: Provider;
}

export interface ProviderRegistryView {
  getAll(): ReturnType<Provider["getModels"]>;
  getProvider(id: string): Provider | undefined;
  getProviderDisplayName(id: string): string;
}

export interface ProviderLookup {
  getProvider(id: string): Provider | undefined;
}

export interface ProviderRegistrar {
  registerProvider(provider: Provider): void;
}
