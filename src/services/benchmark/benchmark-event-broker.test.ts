import { describe, expect, it, vi } from "vitest";

import { BenchmarkEventBroker } from "./benchmark-event-broker";
import type { OpenCodeEvent, OpenCodeEventHandlers } from "../opencode/opencode-types";

/** Waits for the broker's asynchronous onOpen scheduling window. */
function tick(ms = 5): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function event(type: string): OpenCodeEvent {
  return { type, properties: {} };
}

describe("BenchmarkEventBroker", () => {
  it("fires onOpen asynchronously on subscribe without delivering replay events", async () => {
    const broker = new BenchmarkEventBroker();
    const events: OpenCodeEvent[] = [];
    let opened = false;
    broker.subscribe({ onOpen: () => { opened = true; }, onEvent: (event) => events.push(event) }, "/repo");
    expect(opened).toBe(false);
    await tick();
    expect(opened).toBe(true);
    expect(events).toEqual([]);
    broker.close();
  });

  it("publishes directory-scoped events to matching subscribers and isolates scope mismatches", async () => {
    const broker = new BenchmarkEventBroker();
    const root: OpenCodeEvent[] = [];
    const feature: OpenCodeEvent[] = [];
    broker.subscribe({ onEvent: (event) => root.push(event) }, "/repo");
    broker.subscribe({ onEvent: (event) => feature.push(event) }, "/repo/feature");
    broker.subscribe({ onEvent: (event) => root.push(event) }, "/repo");

    broker.publish(event("session.status"), "/repo");

    expect(root).toHaveLength(2);
    expect(feature).toEqual([]);
    broker.close();
  });

  it("broadcasts events without a directory to every directory scope", () => {
    const broker = new BenchmarkEventBroker();
    const seen: string[] = [];
    broker.subscribe({ onEvent: (event) => seen.push(event.type) }, "/repo");
    broker.subscribe({ onEvent: (event) => seen.push(event.type) }, "/other");
    broker.publish(event("session.status"));
    expect(seen).toEqual(["session.status", "session.status"]);
    broker.close();
  });

  it("delivers directory information to handlers and matches normalized directory spellings", async () => {
    const broker = new BenchmarkEventBroker();
    const directories: (string | undefined)[] = [];
    broker.subscribe({ onEvent: (_event, directory) => directories.push(directory) }, "/repo");
    broker.publish(event("session.status"), "/repo/");
    expect(directories).toEqual(["/repo"]);
    broker.close();
  });

  it("isolates throwing subscribers and keeps dispatching to the rest", async () => {
    const broker = new BenchmarkEventBroker();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const second = vi.fn();
    const handlers: OpenCodeEventHandlers = { onEvent: () => { throw new Error("subscriber failed"); } };
    broker.subscribe(handlers, "/repo");
    broker.subscribe({ onEvent: second }, "/repo");
    broker.publish(event("session.status"), "/repo");
    expect(second).toHaveBeenCalledOnce();
    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining("subscriber failed"),
      expect.anything(),
    );
    broker.close();
  });

  it("stops delivery after a subscription close and after broker close", async () => {
    const broker = new BenchmarkEventBroker();
    const seen: string[] = [];
    const handlers: OpenCodeEventHandlers = { onEvent: (event) => seen.push(event.type) };
    const subscription = broker.subscribe(handlers, "/repo");
    subscription.close();
    broker.publish(event("session.status"), "/repo");
    expect(seen).toEqual([]);
    broker.close();
    const afterClose: string[] = [];
    broker.subscribe({ onEvent: (event) => afterClose.push(event.type) }, "/repo");
    broker.publish(event("session.status"), "/repo");
    expect(afterClose).toEqual([]);
  });

  it("does not fire onOpen for closed subscriptions scheduled before close", async () => {
    const broker = new BenchmarkEventBroker();
    const onOpen = vi.fn();
    const subscription = broker.subscribe({ onOpen, onEvent: () => undefined }, "/repo");
    subscription.close();
    await tick();
    expect(onOpen).not.toHaveBeenCalled();
    broker.close();
  });
});
