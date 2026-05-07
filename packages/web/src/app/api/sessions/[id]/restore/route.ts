import { type NextRequest } from "next/server";
import { validateIdentifier } from "@/lib/validation";
import { getServices } from "@/lib/services";
import { sessionToDashboard } from "@/lib/serialize";
import {
  SessionNotRestorableError,
  WorkspaceMissingError,
  SessionNotFoundError,
  recordActivityEvent,
} from "@aoagents/ao-core";
import {
  getCorrelationId,
  jsonWithCorrelation,
  recordApiObservation,
  resolveProjectIdForSessionId,
} from "@/lib/observability";

/** POST /api/sessions/:id/restore — Restore a terminated session */
export async function POST(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const correlationId = getCorrelationId(_request);
  const startedAt = Date.now();
  const { id } = await params;
  const idErr = validateIdentifier(id, "id");
  if (idErr) {
    return jsonWithCorrelation({ error: idErr }, { status: 400 }, correlationId);
  }

  try {
    const { config, sessionManager } = await getServices();
    const projectId = resolveProjectIdForSessionId(config, id);
    const restored = await sessionManager.restore(id);

    recordApiObservation({
      config,
      method: "POST",
      path: "/api/sessions/[id]/restore",
      correlationId,
      startedAt,
      outcome: "success",
      statusCode: 200,
      projectId: restored.projectId ?? projectId,
      sessionId: id,
    });
    recordActivityEvent({
      projectId: restored.projectId ?? projectId,
      sessionId: id,
      source: "api",
      kind: "api.session_restore_requested",
      summary: `session restore requested: ${id}`,
    });

    return jsonWithCorrelation(
      {
        ok: true,
        sessionId: id,
        session: sessionToDashboard(restored),
      },
      { status: 200 },
      correlationId,
    );
  } catch (err) {
    if (err instanceof SessionNotFoundError) {
      return jsonWithCorrelation({ error: err.message }, { status: 404 }, correlationId);
    }
    if (err instanceof SessionNotRestorableError) {
      const { config: cfg } = await getServices().catch(() => ({ config: undefined }));
      const pid = cfg ? resolveProjectIdForSessionId(cfg, id) : undefined;
      recordActivityEvent({
        projectId: pid,
        sessionId: id,
        source: "api",
        kind: "api.session_restore_failed",
        level: "warn",
        summary: `session restore failed: ${err.message}`,
        data: { reason: err.message, statusCode: 409 },
      });
      return jsonWithCorrelation({ error: err.message }, { status: 409 }, correlationId);
    }
    if (err instanceof WorkspaceMissingError) {
      const { config: cfg } = await getServices().catch(() => ({ config: undefined }));
      const pid = cfg ? resolveProjectIdForSessionId(cfg, id) : undefined;
      recordActivityEvent({
        projectId: pid,
        sessionId: id,
        source: "api",
        kind: "api.session_restore_failed",
        level: "warn",
        summary: `session restore failed: ${err.message}`,
        data: { reason: err.message, statusCode: 422 },
      });
      return jsonWithCorrelation({ error: err.message }, { status: 422 }, correlationId);
    }
    const { config } = await getServices().catch(() => ({ config: undefined }));
    const projectId = config ? resolveProjectIdForSessionId(config, id) : undefined;
    if (config) {
      recordApiObservation({
        config,
        method: "POST",
        path: "/api/sessions/[id]/restore",
        correlationId,
        startedAt,
        outcome: "failure",
        statusCode: 500,
        projectId,
        sessionId: id,
        reason: err instanceof Error ? err.message : "Failed to restore session",
      });
    }
    const msg = err instanceof Error ? err.message : "Failed to restore session";
    recordActivityEvent({
      projectId,
      sessionId: id,
      source: "api",
      kind: "api.session_restore_failed",
      level: "error",
      summary: `session restore failed: ${msg}`,
      data: { reason: msg, statusCode: 500 },
    });
    return jsonWithCorrelation({ error: msg }, { status: 500 }, correlationId);
  }
}
