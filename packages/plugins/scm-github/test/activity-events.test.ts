/**
 * Regression tests for plugin-internal activity events (issue #1659).
 *
 * Covers scm.gh_unavailable (MUST emit, deduped once-per-process).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { recordActivityEventMock } = vi.hoisted(() => ({
  recordActivityEventMock: vi.fn(),
}));

vi.mock("@aoagents/ao-core", async () => {
  const actual = (await vi.importActual("@aoagents/ao-core")) as Record<string, unknown>;
  return {
    ...actual,
    recordActivityEvent: recordActivityEventMock,
  };
});

import {
  enrichSessionsPRBatch,
  setExecFileAsync,
  clearETagCache,
  clearPRMetadataCache,
  _resetGhUnavailableEmittedForTesting,
} from "../src/graphql-batch.js";
import type { PRInfo } from "@aoagents/ao-core";

const samplePRs: PRInfo[] = [
  {
    owner: "octocat",
    repo: "hello-world",
    number: 42,
    url: "https://github.com/octocat/hello-world/pull/42",
    title: "Add new feature",
    branch: "feature/new",
    baseBranch: "main",
    isDraft: false,
  },
];

beforeEach(() => {
  vi.clearAllMocks();
  clearETagCache();
  clearPRMetadataCache();
  _resetGhUnavailableEmittedForTesting();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("scm.gh_unavailable (MUST emit)", () => {
  it("emits when verifyGhCLI fails because gh is missing/unauthenticated", async () => {
    const execFileMock = vi.fn().mockImplementation((file: string) => {
      if (file === "gh") {
        const err = new Error("spawn gh ENOENT") as Error & { code?: string };
        err.code = "ENOENT";
        return Promise.reject(err);
      }
      return Promise.resolve({ stdout: "", stderr: "" });
    });
    setExecFileAsync(execFileMock as unknown as Parameters<typeof setExecFileAsync>[0]);

    // The batch-level try/catch swallows verifyGhCLI's throw — but the event
    // fires before the throw, which is what we care about for RCA.
    const result = await enrichSessionsPRBatch(samplePRs);
    expect(result.enrichment.size).toBe(0);

    expect(recordActivityEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "scm",
        kind: "scm.gh_unavailable",
        level: "error",
        data: expect.objectContaining({
          plugin: "scm-github",
          errorMessage: expect.any(String),
        }),
      }),
    );
  });

  it("emits exactly once across multiple gh-missing failures (deduped per-process)", async () => {
    const execFileMock = vi.fn().mockImplementation((file: string) => {
      if (file === "gh") {
        return Promise.reject(new Error("gh ENOENT"));
      }
      return Promise.resolve({ stdout: "", stderr: "" });
    });
    setExecFileAsync(execFileMock as unknown as Parameters<typeof setExecFileAsync>[0]);

    await enrichSessionsPRBatch(samplePRs);
    await enrichSessionsPRBatch(samplePRs);
    await enrichSessionsPRBatch(samplePRs);

    const ghUnavailableCalls = recordActivityEventMock.mock.calls.filter(
      ([event]) => event.kind === "scm.gh_unavailable",
    );
    expect(ghUnavailableCalls).toHaveLength(1);
  });
});
