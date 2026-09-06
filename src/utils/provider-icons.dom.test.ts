import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../assets/provider-icons.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg"><defs><symbol id="openai"/><symbol id="synthetic"/></defs></svg>',
}));

import { ensureProviderIconSprite, removeProviderIconSprite, setProviderIcon } from "./provider-icons";

afterEach(() => {
  removeProviderIconSprite();
  document.body.replaceChildren();
});

describe("provider icons", () => {
  it("injects the bundled sprite once and removes it during cleanup", () => {
    ensureProviderIconSprite();
    ensureProviderIconSprite();

    expect(document.querySelectorAll("#opencode-provider-icon-sprite")).toHaveLength(1);
    expect(document.querySelector("#opencode-provider-icon-sprite symbol#openai")).not.toBeNull();

    removeProviderIconSprite();
    expect(document.getElementById("opencode-provider-icon-sprite")).toBeNull();
  });

  it("builds SVG elements safely and falls back for unknown provider IDs", () => {
    const icon = document.createElement("span");
    setProviderIcon(icon, "openai", 14);

    expect(icon.querySelector("svg")?.getAttribute("width")).toBe("14");
    expect(icon.querySelector("use")?.getAttribute("href")).toBe("#openai");

    setProviderIcon(icon, '\"><script>alert(1)</script>');
    expect(icon.querySelector("script")).toBeNull();
    expect(icon.querySelector("use")?.getAttribute("href")).toBe("#synthetic");
  });
});
