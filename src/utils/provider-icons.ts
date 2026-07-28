/**
 * Provider icon utilities for the OpenCode Obsidian plugin.
 *
 * This sprite is a static copy of opencode's bundled provider icon sprite:
 *   packages/ui/src/components/provider-icons/sprite.svg
 * (from the opencode repo at https://github.com/anomalyco/opencode).
 * It contains <symbol> defs for 100+ providers, each using fill="currentColor".
 *
 * STALENESS: This is a build-time snapshot that can go out of date as opencode
 * adds new providers. The source of truth for provider logos is models.dev:
 *
 *   https://models.dev/providers/{providerID}/logo.svg
 *
 * models.dev is the open-source AI model database that opencode uses for its
 * entire models/providers registry. Each provider has a logo.svg using
 * viewBox="0 0 24 24" and fill="currentColor". If a provider logo is missing,
 * models.dev serves a default fallback logo.
 *
 * FUTURE UPGRADE PLAN:
 * Instead of bundling this static sprite, fetch provider logos dynamically from
 * models.dev with the following strategy:
 *   1. Lazy fetch: When setProviderIcon() is called and the logo isn't cached,
 *      render a fallback icon and fetch `models.dev/providers/{id}/logo.svg`
 *      in the background using Obsidian's requestUrl (avoids CORS in Electron).
 *   2. Cache in localStorage: Key per provider ID, e.g.
 *      `opencode-provider-icon:{providerID}` -> raw SVG string.
 *   3. Weekly auto-refresh: On plugin load, check a cache timestamp. If older
 *      than 7 days, clear cached SVGs so they re-fetch lazily.
 *   4. Manual refresh button: Add a "Refresh provider icons" button in the
 *      settings tab that clears the cache and pre-fetches all known providers.
 *
 * Reference: https://github.com/anomalyco/models.dev (logo contribution guide
 * describes the SVG format and endpoint).
 */

import spriteText from "../assets/provider-icons.svg";

const SPRITE_CONTAINER_ID = "opencode-provider-icon-sprite";

/**
 * Injects the provider icon sprite (hidden <svg> with <symbol> defs) into the document body.
 * Idempotent — safe to call multiple times. Referenced by setProviderIcon().
 */
export function ensureProviderIconSprite(): void {
  if (document.getElementById(SPRITE_CONTAINER_ID)) return;
  const holder = document.createElement("div");
  holder.id = SPRITE_CONTAINER_ID;
  holder.setAttribute("aria-hidden", "true");
  holder.style.cssText = "position:absolute;width:0;height:0;overflow:hidden;";
  holder.innerHTML = spriteText;
  document.body.appendChild(holder);
}

/**
 * Sets a provider icon inside the given element using an SVG <use> reference.
 * Falls back to the "synthetic" symbol for unknown provider IDs.
 * Referenced by ModelSelectionMenu and SessionView model label.
 */
export function setProviderIcon(el: HTMLElement, providerID: string, size = 16): void {
  ensureProviderIconSprite();
  const known = document.getElementById(providerID) !== null;
  const symbolId = known ? providerID : "synthetic";
  el.innerHTML = `<svg width="${size}" height="${size}" viewBox="0 0 40 40"><use href="#${symbolId}"/></svg>`;
}
