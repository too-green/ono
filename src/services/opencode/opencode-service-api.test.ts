import { describe, expect, expectTypeOf, it } from "vitest";
import { OpenCodeService, createOpenCodeService } from "./opencode-service";
import type { OpenCodeServiceApi } from "./opencode-service-api";

describe("OpenCodeServiceApi boundary", () => {
  it("accepts the production OpenCodeService", () => {
    expectTypeOf(new OpenCodeService({ baseUrl: "https://remote.example" })).toMatchTypeOf<OpenCodeServiceApi>();
  });

  it("builds the production client through the construction seam", () => {
    const service = createOpenCodeService({ baseUrl: "https://remote.example" });
    expectTypeOf(service).toMatchTypeOf<OpenCodeServiceApi>();
    expect(typeof service.health).toBe("function");
    expect(typeof service.subscribeToEvents).toBe("function");
    expect(typeof service.updateConfig).toBe("function");
    expect(typeof service.dispose).toBe("function");
    service.dispose();
  });

  it("lets a non-production implementation occupy the plugin service slot", () => {
    // Proxy-backed stub proves an interchangeable implementation needs no OpenCodeService lineage.
    const calls: string[] = [];
    const stub = new Proxy({} as OpenCodeServiceApi, {
      get: (_target, property) => {
        if (typeof property !== "string") return undefined;
        return (..._args: unknown[]) => {
          calls.push(property);
          return { id: "session-1" };
        };
      },
    });
    const service: OpenCodeServiceApi = stub;
    const session = service.getSession("session-1", "/repo");
    expect(calls).toEqual(["getSession"]);
    expect(session.id).toBe("session-1");
  });
});
