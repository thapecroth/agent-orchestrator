import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { WebSocket } from "ws";

// Activity event recording is mocked to assert what fires without touching the
// real SQLite layer in unit tests.
const recordActivityEvent = vi.fn();
vi.mock("@aoagents/ao-core", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    recordActivityEvent: (event: unknown) => recordActivityEvent(event),
  };
});

import { SessionBroadcaster, createMuxWebSocket } from "../mux-websocket";

// Mock global fetch
const mockFetch = vi.fn();
global.fetch = mockFetch;

describe("SessionBroadcaster", () => {
  let broadcaster: SessionBroadcaster;

  beforeEach(() => {
    vi.useFakeTimers();
    mockFetch.mockReset();
    recordActivityEvent.mockClear();
    broadcaster = new SessionBroadcaster("3000");
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  const makePatch = (id: string) => ({
    id,
    status: "working",
    activity: "active",
    attentionLevel: "working" as const,
    lastActivityAt: new Date().toISOString(),
  });

  describe("subscribe", () => {
    it("sends an immediate snapshot to a new subscriber", async () => {
      const patches = [makePatch("s1")];
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ sessions: patches }),
      });

      const callback = vi.fn();
      broadcaster.subscribe(callback);

      // Let the snapshot fetch resolve
      await vi.advanceTimersByTimeAsync(0);

      expect(mockFetch).toHaveBeenCalledWith(
        "http://localhost:3000/api/sessions/patches",
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
      expect(callback).toHaveBeenCalledWith(patches);
    });

    it("starts polling interval on first subscriber", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ sessions: [] }),
      });

      broadcaster.subscribe(vi.fn());
      await vi.advanceTimersByTimeAsync(0);

      // Snapshot fetch is called once on subscribe
      expect(mockFetch).toHaveBeenCalledTimes(1);

      // After 3 seconds, polling interval should trigger a second fetch
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ sessions: [] }),
      });
      await vi.advanceTimersByTimeAsync(3000);

      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it("does not start a second polling interval for additional subscribers", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ sessions: [] }),
      });

      broadcaster.subscribe(vi.fn());
      broadcaster.subscribe(vi.fn());
      await vi.advanceTimersByTimeAsync(0);

      // 1 snapshot for sub1 + 1 snapshot for sub2 = 2
      expect(mockFetch).toHaveBeenCalledTimes(2);

      // After 3 seconds, only one polling fetch happens
      await vi.advanceTimersByTimeAsync(3000);
      expect(mockFetch).toHaveBeenCalledTimes(3);
    });

    it("returns an unsubscribe function that stops polling when last subscriber leaves", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ sessions: [] }),
      });

      const unsub = broadcaster.subscribe(vi.fn());
      await vi.advanceTimersByTimeAsync(0);

      // Unsubscribe triggers disconnect
      unsub();

      // Reset and advance past polling interval
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ sessions: [] }),
      });
      await vi.advanceTimersByTimeAsync(3000);

      // Should not have called fetch again after unsubscribe
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });
  });

  describe("broadcast", () => {
    it("delivers patches to all subscribers on each poll", async () => {
      const patches = [makePatch("s1"), makePatch("s2")];

      // Initial snapshot for first subscriber
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ sessions: patches }),
      });
      // Initial snapshot for second subscriber
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ sessions: patches }),
      });
      // Polling fetch after 3s
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ sessions: patches }),
      });

      const cb1 = vi.fn();
      const cb2 = vi.fn();
      broadcaster.subscribe(cb1);
      broadcaster.subscribe(cb2);

      await vi.advanceTimersByTimeAsync(10);

      // Both callbacks should have received initial snapshot
      expect(cb1).toHaveBeenCalledWith(patches);
      expect(cb2).toHaveBeenCalledWith(patches);

      // Advance past poll interval (3s) and add buffer for promise resolution
      await vi.advanceTimersByTimeAsync(3010);

      // Should be called again from polling
      expect(cb1).toHaveBeenCalledTimes(2);
      expect(cb2).toHaveBeenCalledTimes(2);
    });

    it("isolates subscriber errors — one throw does not skip others", async () => {
      const patches = [makePatch("s1")];

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ sessions: patches }),
      });
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ sessions: patches }),
      });

      const throwingCb = vi.fn().mockImplementation(() => {
        throw new Error("ws.send failed");
      });
      const goodCb = vi.fn();
      broadcaster.subscribe(throwingCb);
      broadcaster.subscribe(goodCb);

      await vi.advanceTimersByTimeAsync(10);

      // goodCb should have received patches despite throwingCb error
      expect(goodCb).toHaveBeenCalledWith(patches);
    });
  });

  describe("fetchSnapshot", () => {
    it("returns null on fetch failure", async () => {
      mockFetch.mockRejectedValueOnce(new Error("network error"));

      const callback = vi.fn();
      broadcaster.subscribe(callback);
      await vi.advanceTimersByTimeAsync(10);

      // callback should not have been called (snapshot returned null)
      expect(callback).not.toHaveBeenCalled();
    });

    it("returns null on non-OK response", async () => {
      mockFetch.mockResolvedValueOnce({ ok: false, status: 500 });

      const callback = vi.fn();
      broadcaster.subscribe(callback);
      await vi.advanceTimersByTimeAsync(10);

      expect(callback).not.toHaveBeenCalled();
    });
  });

  describe("disconnect", () => {
    it("stops polling when last subscriber unsubscribes", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ sessions: [] }),
      });

      const unsub = broadcaster.subscribe(vi.fn());
      await vi.advanceTimersByTimeAsync(0);

      // Unsubscribe triggers disconnect
      unsub();

      // Advance past polling interval
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ sessions: [] }),
      });
      await vi.advanceTimersByTimeAsync(3000);

      // Should only have 1 fetch (initial snapshot)
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });
  });

  describe("ui.session_broadcast_failed activity events", () => {
    function failedKinds(): string[] {
      return recordActivityEvent.mock.calls
        .map(([e]) => (e as { kind: string }).kind)
        .filter((k) => k === "ui.session_broadcast_failed");
    }

    it("emits exactly once on the healthy→failing transition", async () => {
      // First fetch fails — triggers emission
      mockFetch.mockRejectedValueOnce(new Error("ECONNREFUSED"));
      // Second fetch (3s later) also fails — should NOT emit again
      mockFetch.mockRejectedValueOnce(new Error("ECONNREFUSED"));

      broadcaster.subscribe(vi.fn());
      await vi.advanceTimersByTimeAsync(10);
      await vi.advanceTimersByTimeAsync(3010);

      expect(failedKinds()).toEqual(["ui.session_broadcast_failed"]);
    });

    it("re-arms after recovery (success → failure emits again)", async () => {
      // fail → succeed → fail
      mockFetch.mockRejectedValueOnce(new Error("net down"));
      mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ sessions: [] }) });
      mockFetch.mockRejectedValueOnce(new Error("net down again"));

      broadcaster.subscribe(vi.fn());
      await vi.advanceTimersByTimeAsync(10);
      await vi.advanceTimersByTimeAsync(3010); // poll #1 → success
      await vi.advanceTimersByTimeAsync(3010); // poll #2 → failure

      expect(failedKinds().length).toBe(2);
    });

    it("emits with source=ui, level=warn, and the failure URL in data", async () => {
      mockFetch.mockRejectedValueOnce(new Error("ETIMEDOUT"));

      broadcaster.subscribe(vi.fn());
      await vi.advanceTimersByTimeAsync(10);

      expect(recordActivityEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          source: "ui",
          kind: "ui.session_broadcast_failed",
          level: "warn",
        }),
      );
      const call = recordActivityEvent.mock.calls.find(
        ([e]) => (e as { kind: string }).kind === "ui.session_broadcast_failed",
      )![0] as { data: Record<string, unknown> };
      expect(call.data["url"]).toContain("/api/sessions/patches");
      expect(call.data["errorMessage"]).toContain("ETIMEDOUT");
    });

    it("includes httpStatus when fetch returns non-OK response", async () => {
      mockFetch.mockResolvedValueOnce({ ok: false, status: 503 });

      broadcaster.subscribe(vi.fn());
      await vi.advanceTimersByTimeAsync(10);

      const call = recordActivityEvent.mock.calls.find(
        ([e]) => (e as { kind: string }).kind === "ui.session_broadcast_failed",
      )![0] as { data: Record<string, unknown> };
      expect(call.data["httpStatus"]).toBe(503);
    });
  });
});

// ── Connection-level activity events ──────────────────────────────────
// These verify ui.terminal_* events fire at the right WS lifecycle points.
// We exercise the connection handler directly by emitting "connection" on
// the WebSocketServer and feeding a fake ws + IncomingMessage stand-in.

class FakeWS extends EventEmitter {
  readyState: 0 | 1 | 2 | 3 = WebSocket.OPEN;
  bufferedAmount = 0;
  ping = vi.fn();
  terminate = vi.fn(() => {
    this.readyState = WebSocket.CLOSED;
  });
  send = vi.fn();
}

function makeFakeRequest(opts?: { remoteAddress?: string; xff?: string }) {
  return {
    headers: opts?.xff ? { "x-forwarded-for": opts.xff } : {},
    socket: { remoteAddress: opts?.remoteAddress ?? "127.0.0.1" },
  };
}

describe("mux WebSocket connection events", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    recordActivityEvent.mockClear();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  function emitConnection(opts?: Parameters<typeof makeFakeRequest>[0]) {
    const wss = createMuxWebSocket();
    if (!wss) {
      throw new Error("mux WS server not created — node-pty unavailable");
    }
    const ws = new FakeWS();
    wss.emit("connection", ws as unknown as WebSocket, makeFakeRequest(opts));
    return { wss, ws };
  }

  function findEvent(kind: string): { data: Record<string, unknown> } | undefined {
    const found = recordActivityEvent.mock.calls.find(
      ([e]) => (e as { kind: string }).kind === kind,
    );
    return found?.[0] as { data: Record<string, unknown> } | undefined;
  }

  it("emits ui.terminal_connected on a new mux connection (with remoteAddr)", () => {
    emitConnection({ xff: "198.51.100.5, 10.0.0.1" });

    expect(recordActivityEvent).toHaveBeenCalledWith(
      expect.objectContaining({ source: "ui", kind: "ui.terminal_connected" }),
    );
    const evt = findEvent("ui.terminal_connected")!;
    expect(evt.data["remoteAddr"]).toBe("198.51.100.5");
  });

  it("emits ui.terminal_disconnected exactly once on close", () => {
    const { ws } = emitConnection();
    recordActivityEvent.mockClear();

    ws.emit("close", 1000, Buffer.from("normal"));

    const calls = recordActivityEvent.mock.calls.filter(
      ([e]) => (e as { kind: string }).kind === "ui.terminal_disconnected",
    );
    expect(calls.length).toBe(1);
    const evt = findEvent("ui.terminal_disconnected")!;
    expect(evt.data["code"]).toBe(1000);
    expect(evt.data["reason"]).toBe("normal");
  });

  it("emits ui.terminal_heartbeat_lost once on 3 missed pongs and terminates", () => {
    const { ws } = emitConnection();
    recordActivityEvent.mockClear();

    // Each 15s interval sends a ping and increments missedPongs by 1.
    // After 3 ticks (45s) it should hit MAX_MISSED_PONGS=3 and terminate.
    vi.advanceTimersByTime(15_000);
    vi.advanceTimersByTime(15_000);
    vi.advanceTimersByTime(15_000);

    const calls = recordActivityEvent.mock.calls.filter(
      ([e]) => (e as { kind: string }).kind === "ui.terminal_heartbeat_lost",
    );
    expect(calls.length).toBe(1);
    expect(ws.terminate).toHaveBeenCalled();

    // Issue invariant: at most one emit per state change — extra ticks must not
    // produce another event.
    vi.advanceTimersByTime(15_000);
    expect(
      recordActivityEvent.mock.calls.filter(
        ([e]) => (e as { kind: string }).kind === "ui.terminal_heartbeat_lost",
      ).length,
    ).toBe(1);
  });

  it("does NOT emit heartbeat_lost when pong arrives before 3 missed pings", () => {
    const { ws } = emitConnection();
    recordActivityEvent.mockClear();

    vi.advanceTimersByTime(15_000); // missedPongs=1
    ws.emit("pong"); // resets to 0
    vi.advanceTimersByTime(15_000); // missedPongs=1
    vi.advanceTimersByTime(15_000); // missedPongs=2

    expect(
      recordActivityEvent.mock.calls.filter(
        ([e]) => (e as { kind: string }).kind === "ui.terminal_heartbeat_lost",
      ).length,
    ).toBe(0);
    expect(ws.terminate).not.toHaveBeenCalled();
  });

  it("emits ui.terminal_protocol_error on malformed client message", () => {
    const { ws } = emitConnection();
    recordActivityEvent.mockClear();

    ws.emit("message", Buffer.from("not-json{{{"));

    const calls = recordActivityEvent.mock.calls.filter(
      ([e]) => (e as { kind: string }).kind === "ui.terminal_protocol_error",
    );
    expect(calls.length).toBe(1);
    const evt = findEvent("ui.terminal_protocol_error")!;
    expect(evt.data["errorMessage"]).toBeTruthy();
  });
});
