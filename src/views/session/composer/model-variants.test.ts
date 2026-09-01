import { describe, expect, it } from "vitest";
import type { JsonObject, OpenCodeMessageBundle, OpenCodeModelRef } from "../../../services/opencode-types";
import {
  agentColor,
  agentName,
  availableModelRefs,
  buildModelEntries,
  composerAgentFromState,
  composerModelFromState,
  isOffReasoningVariant,
  modelForAgent,
  modelLabelForRef,
  modelRefFromInfo,
  modelShortLabelForRef,
  modelVariants,
  nextAgentName,
  nextFavoriteRef,
  sameModel,
  titleCaseAgent,
  visibleAgents,
} from "./model-variants";

const empty = {};

describe("isOffReasoningVariant", () => {
  it("matches explicit off/none/disabled/no-reasoning tokens, ignoring case and separators", () => {
    expect(isOffReasoningVariant("off")).toBe(true);
    expect(isOffReasoningVariant("OFF")).toBe(true);
    expect(isOffReasoningVariant("none")).toBe(true);
    expect(isOffReasoningVariant("disabled")).toBe(true);
    expect(isOffReasoningVariant("no_reasoning")).toBe(true);
    expect(isOffReasoningVariant("no-reasoning")).toBe(true);
    expect(isOffReasoningVariant("No Reasoning")).toBe(true);
  });

  it("returns false for actual reasoning presets", () => {
    expect(isOffReasoningVariant("low")).toBe(false);
    expect(isOffReasoningVariant("medium")).toBe(false);
    expect(isOffReasoningVariant("high")).toBe(false);
    expect(isOffReasoningVariant("")).toBe(false);
  });
});

describe("sameModel", () => {
  it("matches on providerID + modelID, ignoring variant", () => {
    const a: OpenCodeModelRef = { providerID: "anthropic", modelID: "claude-3.5" };
    const b: OpenCodeModelRef = { providerID: "anthropic", modelID: "claude-3.5", variant: "high" };
    expect(sameModel(a, b)).toBe(true);
  });

  it("rejects when provider or model differs", () => {
    expect(sameModel({ providerID: "anthropic", modelID: "x" }, { providerID: "openai", modelID: "x" })).toBe(false);
    expect(sameModel({ providerID: "anthropic", modelID: "x" }, { providerID: "anthropic", modelID: "y" })).toBe(false);
  });

  it("returns false when either side is undefined", () => {
    expect(sameModel(undefined, { providerID: "anthropic", modelID: "x" })).toBe(false);
    expect(sameModel({ providerID: "anthropic", modelID: "x" }, undefined)).toBe(false);
    expect(sameModel(undefined, undefined)).toBe(false);
  });
});

describe("modelRefFromInfo", () => {
  it("reads providerID and modelID from canonical fields", () => {
    expect(modelRefFromInfo({ providerID: "anthropic", modelID: "claude" })).toEqual({ providerID: "anthropic", modelID: "claude" });
  });

  it("falls back to providerId/modelId/id aliases", () => {
    expect(modelRefFromInfo({ providerId: "openai", id: "gpt-4" })).toEqual({ providerID: "openai", modelID: "gpt-4" });
    expect(modelRefFromInfo({ providerId: "openai", modelId: "gpt-4o" })).toEqual({ providerID: "openai", modelID: "gpt-4o" });
  });

  it("returns undefined when either field is missing", () => {
    expect(modelRefFromInfo({ providerID: "anthropic" })).toBeUndefined();
    expect(modelRefFromInfo({ modelID: "claude" })).toBeUndefined();
    expect(modelRefFromInfo(empty)).toBeUndefined();
  });
});

describe("titleCaseAgent", () => {
  it("capitalizes words split on hyphens or spaces", () => {
    expect(titleCaseAgent("code-review")).toBe("Code Review");
    expect(titleCaseAgent("code review")).toBe("Code Review");
    expect(titleCaseAgent("build")).toBe("Build");
    expect(titleCaseAgent("default")).toBe("Default");
  });

  it("handles already-capitalized input idempotently", () => {
    expect(titleCaseAgent("Code-Review")).toBe("Code Review");
  });
});

describe("visibleAgents", () => {
  it("filters out subagents and hidden agents", () => {
    const agents: JsonObject[] = [
      { name: "build", mode: "primary" },
      { name: "secret", mode: "subagent" },
      { name: "ghost", hidden: true },
      { name: "plan" },
    ];
    const visible = visibleAgents(agents);
    expect(visible.map((a) => a.name)).toEqual(["build", "plan"]);
  });

  it("returns empty array when all agents are filtered", () => {
    const agents: JsonObject[] = [{ name: "x", mode: "subagent" }, { name: "y", hidden: true }];
    expect(visibleAgents(agents)).toEqual([]);
  });
});

describe("agentName", () => {
  it("reads name then id then nothing", () => {
    expect(agentName({ name: "build" })).toBe("build");
    expect(agentName({ id: "fallback" })).toBe("fallback");
    expect(agentName({ mode: "primary" })).toBeUndefined();
  });
});

describe("agentColor", () => {
  it("maps semantic names to Obsidian CSS vars", () => {
    expect(agentColor({ color: "primary" })).toBe("var(--interactive-accent)");
    expect(agentColor({ color: "success" })).toBe("var(--color-green)");
    expect(agentColor({ color: "warning" })).toBe("var(--color-orange)");
    expect(agentColor({ color: "error" })).toBe("var(--color-red)");
    expect(agentColor({ color: "info" })).toBe("var(--color-blue)");
  });

  it("passes through raw hex/named colors not in the named map", () => {
    expect(agentColor({ color: "#ff00aa" })).toBe("#ff00aa");
    expect(agentColor({ color: "purple" })).toBe("purple");
  });

  it("returns undefined when agent or color is missing", () => {
    expect(agentColor(undefined)).toBeUndefined();
    expect(agentColor({})).toBeUndefined();
  });
});

describe("availableModelRefs", () => {
  it("collects refs from enabled models, skipping disabled", () => {
    const models: JsonObject[] = [
      { providerID: "anthropic", modelID: "claude", enabled: true },
      { providerID: "openai", modelID: "gpt-4" },
      { providerID: "meta", modelID: "llama", enabled: false },
    ];
    expect(availableModelRefs(models)).toEqual([
      { providerID: "anthropic", modelID: "claude" },
      { providerID: "openai", modelID: "gpt-4" },
    ]);
  });

  it("skips models missing provider or model id", () => {
    expect(availableModelRefs([{ providerID: "x" }, { modelID: "y" }])).toEqual([]);
  });
});

describe("modelVariants", () => {
  it("reads variant ids from array-of-object encoding", () => {
    const models: JsonObject[] = [
      {
        providerID: "anthropic",
        modelID: "claude",
        variants: [{ id: "low" }, { id: "high" }],
      },
    ];
    expect(modelVariants(models, { providerID: "anthropic", modelID: "claude" })).toEqual(["low", "high"]);
  });

  it("reads variant ids from array-of-string encoding", () => {
    const models: JsonObject[] = [
      { providerID: "anthropic", modelID: "claude", variants: ["low", "medium", "high"] },
    ];
    expect(modelVariants(models, { providerID: "anthropic", modelID: "claude" })).toEqual(["low", "medium", "high"]);
  });

  it("reads variant ids from object encoding", () => {
    const models: JsonObject[] = [
      { providerID: "anthropic", modelID: "claude", variants: { low: {}, high: {} } },
    ];
    expect(modelVariants(models, { providerID: "anthropic", modelID: "claude" })).toEqual(["low", "high"]);
  });

  it("returns [] when ref is undefined or model not found", () => {
    expect(modelVariants([], undefined)).toEqual([]);
    expect(modelVariants([{ providerID: "x", modelID: "y" }], { providerID: "a", modelID: "b" })).toEqual([]);
  });
});

describe("modelLabelForRef / modelShortLabelForRef", () => {
  const models: JsonObject[] = [
    { providerID: "anthropic", modelID: "claude-3.5", name: "Claude 3.5 Sonnet" },
    { providerID: "openai", modelID: "gpt-4o" },
  ];

  it("prefers human-readable name from catalog", () => {
    expect(modelShortLabelForRef(models, { providerID: "anthropic", modelID: "claude-3.5" })).toBe("Claude 3.5 Sonnet");
    expect(modelLabelForRef(models, { providerID: "anthropic", modelID: "claude-3.5" })).toBe("Claude 3.5 Sonnet · anthropic");
  });

  it("falls back to modelID when name is missing", () => {
    expect(modelShortLabelForRef(models, { providerID: "openai", modelID: "gpt-4o" })).toBe("gpt-4o");
    expect(modelLabelForRef(models, { providerID: "openai", modelID: "gpt-4o" })).toBe("gpt-4o · openai");
  });

  it("includes variant in full label when present", () => {
    expect(modelLabelForRef(models, { providerID: "anthropic", modelID: "claude-3.5", variant: "high" })).toBe("Claude 3.5 Sonnet · anthropic · high");
  });
});

describe("modelForAgent", () => {
  it("reads the agent's configured model + variant", () => {
    const agents: JsonObject[] = [
      { name: "build", model: { providerID: "anthropic", modelID: "claude" }, variant: "high" },
    ];
    expect(modelForAgent(agents, "build")).toEqual({ providerID: "anthropic", modelID: "claude", variant: "high" });
  });

  it("returns undefined when agent is not found or has no model", () => {
    expect(modelForAgent([{ name: "build" }], "build")).toBeUndefined();
    expect(modelForAgent([{ name: "build" }], "missing")).toBeUndefined();
  });
});

describe("buildModelEntries", () => {
  it("produces ModelEntry[] with name + variants", () => {
    const models: JsonObject[] = [
      { providerID: "anthropic", modelID: "claude", name: "Claude", variants: ["low", "high"] },
      { providerID: "openai", modelID: "gpt", enabled: false },
      { providerID: "meta" },
    ];
    const entries = buildModelEntries(models);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toEqual({ providerID: "anthropic", modelID: "claude", name: "Claude", variants: ["low", "high"] });
  });
});

describe("composerAgentFromState", () => {
  const agents: JsonObject[] = [{ name: "build" }, { name: "plan" }];

  it("prefers the canonical session agent when visible", () => {
    expect(composerAgentFromState(agents, { agent: "plan" }, [])).toBe("plan");
  });

  it("uses the canonical session agent without local persistence", () => {
    expect(composerAgentFromState(agents, { agent: "plan" }, [])).toBe("plan");
  });

  it("falls back to latest user-message agent when session has no agent", () => {
    const messages: OpenCodeMessageBundle[] = [
      { info: { type: "assistant" }, parts: [] },
      { info: { type: "user", agent: "plan" }, parts: [] },
      { info: { type: "user" }, parts: [] },
    ];
    expect(composerAgentFromState(agents, {}, messages)).toBe("plan");
  });

  it("falls back to first visible agent when nothing else resolves", () => {
    expect(composerAgentFromState(agents, {}, [])).toBe("build");
  });

  it("returns undefined when no agents are visible", () => {
    expect(composerAgentFromState([], {}, [])).toBeUndefined();
  });
});

describe("composerModelFromState", () => {
  const models: JsonObject[] = [
    { providerID: "anthropic", modelID: "claude" },
    { providerID: "openai", modelID: "gpt-4o" },
  ];
  const agents: JsonObject[] = [
    { name: "build", model: { providerID: "anthropic", modelID: "claude" }, variant: "high" },
  ];

  it("falls back to the latest user-message model and variant", () => {
    const messages: OpenCodeMessageBundle[] = [{
      info: { role: "user", model: { providerID: "openai", modelID: "gpt-4o", variant: "high" } },
      parts: [],
    }];
    expect(composerModelFromState(models, agents, {}, messages)).toEqual({ providerID: "openai", modelID: "gpt-4o", variant: "high" });
  });

  it("falls back to session.model", () => {
    const session: JsonObject = { model: { providerID: "openai", id: "gpt-4o", variant: "low" } };
    expect(composerModelFromState(models, agents, session, [])).toEqual({ providerID: "openai", modelID: "gpt-4o", variant: "low" });
  });

  it("falls back to the session-agent's configured model", () => {
    const session: JsonObject = { agent: "build" };
    expect(composerModelFromState(models, agents, session, [])).toEqual({ providerID: "anthropic", modelID: "claude", variant: "high" });
  });

  it("prefers the resolved selected agent when it differs from session.agent", () => {
    const availableAgents: JsonObject[] = [
      ...agents,
      { name: "plan", model: { providerID: "openai", modelID: "gpt-4o" }, variant: "low" },
    ];
    const session: JsonObject = { agent: "build" };
    expect(composerModelFromState(models, availableAgents, session, [], "plan")).toEqual({ providerID: "openai", modelID: "gpt-4o", variant: "low" });
  });

  it("falls back to first available ref when no other source resolves", () => {
    expect(composerModelFromState(models, agents, {}, [])).toEqual({ providerID: "anthropic", modelID: "claude" });
  });

  it("returns undefined when no models are available", () => {
    expect(composerModelFromState([], agents, {}, [])).toBeUndefined();
  });
});

describe("nextFavoriteRef", () => {
  const favorites = [
    { providerID: "anthropic", modelID: "claude", variant: "high" },
    { providerID: "openai", modelID: "gpt-4o", variant: "low" },
    { providerID: "google", modelID: "gemini" },
  ];

  it("returns the first favorite when nothing is selected", () => {
    expect(nextFavoriteRef(favorites, undefined)).toBe(favorites[0]);
  });

  it("advances past an exact model+variant match", () => {
    expect(nextFavoriteRef(favorites, { providerID: "anthropic", modelID: "claude", variant: "high" })).toBe(favorites[1]);
  });

  it("wraps back to the first favorite after the last exact match", () => {
    expect(nextFavoriteRef(favorites, { providerID: "google", modelID: "gemini" })).toBe(favorites[0]);
  });

  it("advances from a same-model match whose variant differs", () => {
    expect(nextFavoriteRef(favorites, { providerID: "openai", modelID: "gpt-4o", variant: "high" })).toBe(favorites[2]);
  });

  it("treats off-style variants as equivalent to each other", () => {
    const offFavorites = [
      { providerID: "anthropic", modelID: "claude", variant: "none" },
      { providerID: "openai", modelID: "gpt-4o" },
    ];
    expect(nextFavoriteRef(offFavorites, { providerID: "anthropic", modelID: "claude", variant: "off" })).toBe(offFavorites[1]);
  });

  it("returns the first favorite when the current selection matches nothing", () => {
    expect(nextFavoriteRef(favorites, { providerID: "mistral", modelID: "large" })).toBe(favorites[0]);
  });

  it("returns undefined with no favorites", () => {
    expect(nextFavoriteRef([], { providerID: "anthropic", modelID: "claude" })).toBeUndefined();
  });
});

describe("nextAgentName", () => {
  it("returns the first agent when nothing is selected", () => {
    expect(nextAgentName(["build", "plan"], undefined)).toBe("build");
  });

  it("advances to the next agent in list order", () => {
    expect(nextAgentName(["build", "plan", "review"], "build")).toBe("plan");
  });

  it("wraps back to the first agent after the last one", () => {
    expect(nextAgentName(["build", "plan"], "plan")).toBe("build");
  });

  it("returns the first agent when the current one is unknown", () => {
    expect(nextAgentName(["build", "plan"], "gone")).toBe("build");
  });

  it("returns undefined with no agents", () => {
    expect(nextAgentName([], "build")).toBeUndefined();
  });
});
