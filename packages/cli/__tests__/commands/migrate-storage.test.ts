/**
 * Tests for migrate-storage activity-event instrumentation (issue #1654).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Command } from "commander";
import { recordActivityEvent } from "@aoagents/ao-core";

const { mockMigrateStorage, mockRollbackStorage } = vi.hoisted(() => ({
  mockMigrateStorage: vi.fn(),
  mockRollbackStorage: vi.fn(),
}));

vi.mock("@aoagents/ao-core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@aoagents/ao-core")>();
  return {
    ...actual,
    migrateStorage: (...args: unknown[]) => mockMigrateStorage(...args),
    rollbackStorage: (...args: unknown[]) => mockRollbackStorage(...args),
    recordActivityEvent: vi.fn(),
  };
});

import { registerMigrateStorage } from "../../src/commands/migrate-storage.js";

const recordedEvents = (): Array<Record<string, unknown>> =>
  vi.mocked(recordActivityEvent).mock.calls.map((c) => c[0] as Record<string, unknown>);

describe("ao migrate-storage — activity events", () => {
  let program: Command;
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrSpy: ReturnType<typeof vi.spyOn>;
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.mocked(recordActivityEvent).mockClear();
    mockMigrateStorage.mockReset();
    mockRollbackStorage.mockReset();

    program = new Command();
    program.exitOverride();
    registerMigrateStorage(program);

    exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    consoleErrSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    exitSpy.mockRestore();
    consoleErrSpy.mockRestore();
    consoleLogSpy.mockRestore();
  });

  it("emits cli.migration_failed when migrateStorage throws", async () => {
    mockMigrateStorage.mockRejectedValue(new Error("disk full"));

    await program.parseAsync(["node", "ao", "migrate-storage"]);

    const events = recordedEvents();
    expect(events).toContainEqual(
      expect.objectContaining({
        kind: "cli.migration_failed",
        source: "cli",
        level: "error",
        data: expect.objectContaining({
          rollback: false,
          errorMessage: "disk full",
        }),
      }),
    );
  });

  it("emits cli.migration_failed when rollbackStorage throws", async () => {
    mockRollbackStorage.mockRejectedValue(new Error("rollback boom"));

    await program.parseAsync(["node", "ao", "migrate-storage", "--rollback"]);

    const events = recordedEvents();
    expect(events).toContainEqual(
      expect.objectContaining({
        kind: "cli.migration_failed",
        source: "cli",
        level: "error",
        data: expect.objectContaining({
          rollback: true,
          errorMessage: "rollback boom",
        }),
      }),
    );
  });
});
