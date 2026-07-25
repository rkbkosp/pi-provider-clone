import { describe, expect, it } from "vitest";
import {
  PROVIDER_ID_PATTERN_TEXT,
  validateProviderId,
  validateTargetProviderId,
} from "../validation.js";

const validIds = [
  "openai-codex-personal",
  "a",
  "provider_2",
  "provider.v2",
  "provider-2_test.release",
  "0-provider",
];

const invalidIds = ["", "OpenAI", " openai", "openai ", "open ai", "openai/codex", ".openai", "_openai", "-openai"];

describe("provider ID validation", () => {
  it.each(validIds)("accepts %s", (providerId) => {
    expect(validateProviderId(providerId)).toBeUndefined();
  });

  it.each(invalidIds)("rejects %j", (providerId) => {
    expect(validateProviderId(providerId)).toBeDefined();
  });

  it("returns the documented pattern for malformed IDs", () => {
    expect(validateProviderId("Not Valid")).toBe(
      `Provider ID must match: ${PROVIDER_ID_PATTERN_TEXT}`,
    );
  });

  it("rejects source equality, saved targets, and registered providers", () => {
    const definition = {
      sourceId: "source",
      targetId: "saved-clone",
      createdAt: "2026-07-24T12:00:00.000Z",
    };
    const base = {
      sourceId: "source",
      definitions: [definition],
      providerExists: (id: string) => id === "registered-provider",
    };

    expect(validateTargetProviderId("source", base)).toMatch(/different/u);
    expect(validateTargetProviderId("saved-clone", base)).toMatch(/saved provider clone/u);
    expect(validateTargetProviderId("registered-provider", base)).toMatch(/already exists/u);
    expect(validateTargetProviderId("new-provider", base)).toBeUndefined();
  });
});
