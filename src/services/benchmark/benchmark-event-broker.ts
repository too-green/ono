import { logger } from "../../logger";
import type { OpenCodeEventHandlers, OpenCodeEventSubscription } from "../opencode/events-helper";
import type { OpenCodeEvent } from "../opencode/opencode-types";

const GLOBAL_SCOPE_KEY = "\u0000global";

interface BrokerScope {
  directory?: string;
  global: boolean;
  handlers: Set<OpenCodeEventHandlers>;
}

/** Normalizes directory spellings so broker scope matching follows plugin path handling. */
export function directoryScopeKey(directory?: string): string {
  if (!directory) return "";
  return (directory.replace(/\\/g, "/").replace(/\/+$/, "") || directory).toLowerCase();
}

/**
 * In-memory directory-scoped replacement for the SSE event stream used by benchmark replay.
 * Subscribers connect asynchronously (onOpen) without starting playback; replay events are
 * delivered through publish() with production-matching directory scoping and handler isolation.
 */
export class BenchmarkEventBroker {
  private readonly scopes = new Map<string, BrokerScope>();
  private disposed = false;

  /** Adds a directory-scoped subscriber and fires its onOpen asynchronously like a real connection. */
  subscribe(handlers: OpenCodeEventHandlers, directory?: string): OpenCodeEventSubscription {
    return this.addSubscriber(handlers, directory, false);
  }

  /** Adds a server-wide subscriber; benchmark replay only publishes directory-scoped events. */
  subscribeGlobal(handlers: OpenCodeEventHandlers): OpenCodeEventSubscription {
    return this.addSubscriber(handlers, undefined, true);
  }

  /** Delivers one replay event to the matching directory scope; subscriber failures stay isolated. */
  publish(event: OpenCodeEvent, directory?: string): void {
    if (this.disposed) return;
    // Directory-less sessions have no scope to match; broadcast to every directory subscriber.
    if (directory === undefined) {
      for (const scope of this.scopes.values()) {
        if (scope.global) continue;
        this.forEachHandler(scope.handlers, (handler) => handler.onEvent(event, scope.directory));
      }
      return;
    }
    const scope = this.scopes.get(directoryScopeKey(directory));
    if (!scope) return;
    this.forEachHandler(scope.handlers, (handler) => handler.onEvent(event, scope.directory));
  }

  /** Drops every subscriber and stops accepting events. */
  close(): void {
    this.disposed = true;
    this.scopes.clear();
  }

  /** Registers one subscriber in its scope and schedules its asynchronous onOpen callback. */
  private addSubscriber(handlers: OpenCodeEventHandlers, directory: string | undefined, global: boolean): OpenCodeEventSubscription {
    const key = global ? GLOBAL_SCOPE_KEY : directoryScopeKey(directory);
    let scope = this.scopes.get(key);
    if (!scope) {
      scope = { directory: global ? undefined : directory, global, handlers: new Set() };
      this.scopes.set(key, scope);
    }
    scope.handlers.add(handlers);
    globalThis.setTimeout(() => {
      if (this.disposed || !scope.handlers.has(handlers)) return;
      try {
        handlers.onOpen?.();
      } catch (error) {
        logger.error("benchmark", "subscriber onOpen failed", { error });
      }
    }, 0);
    return {
      close: () => {
        scope.handlers.delete(handlers);
        if (scope.handlers.size === 0 && this.scopes.get(key) === scope) this.scopes.delete(key);
      },
    };
  }

  /** Iterates a handler snapshot so handlers may unsubscribe while processing an event. */
  private forEachHandler(handlers: Set<OpenCodeEventHandlers>, callback: (handler: OpenCodeEventHandlers) => void): void {
    for (const handler of [...handlers]) {
      try {
        callback(handler);
      } catch (error) {
        logger.error("benchmark", "subscriber failed", { error });
      }
    }
  }
}
