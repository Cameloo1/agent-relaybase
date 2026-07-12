import type http from "node:http";
import { relaybaseErrorResponse } from "./apiErrors.ts";
import { sendJson } from "./responses.ts";
import { AppPackageService, AppPackageServiceError } from "./appPackageService.ts";

const MAX_JSON_BODY_BYTES = 256 * 1024;
type RequireToken = (options?: { code?: string; message?: string; userAction?: string }) => void;

export async function handleAppPackageApiRequest(input: {
  service: AppPackageService;
  request: http.IncomingMessage;
  response: http.ServerResponse;
  parts: string[];
  correlationId: string;
  requireToken: RequireToken;
}): Promise<boolean> {
  const { service, request, response, parts, correlationId, requireToken } = input;
  const packageRoute = parts[0] === "__hub" && parts[1] === "api" && parts[2] === "packages";
  const runRoute = parts[0] === "__hub" && parts[1] === "api" && parts[2] === "package-runs";
  if (!packageRoute && !runRoute) {
    return false;
  }

  requireToken({
    code: "UNAUTHORIZED_APP_PACKAGES",
    message: "Unauthorized Relaybase app package access.",
    userAction: "Use the session token from this daemon state directory before managing app packages."
  });

  try {
    if (packageRoute && request.method === "GET" && parts.length === 3) {
      const packages = service.listDefinitions().map((definition) => ({
        ...definition,
        lastRun: service.store.listRunsForPackage(definition.id)[0] ?? null
      }));
      sendJson(response, 200, { packages });
      return true;
    }

    if (packageRoute && request.method === "POST" && parts.length === 3) {
      const body = await readJsonBody(request);
      sendJson(response, 201, { package: await service.createDefinition(body) });
      return true;
    }

    if (packageRoute && request.method === "GET" && parts.length === 4) {
      const definition = service.getDefinition(parts[3] as string);
      sendJson(response, 200, {
        package: definition,
        runs: service.store.listRunsForPackage(definition.id)
      });
      return true;
    }

    if (packageRoute && request.method === "DELETE" && parts.length === 4) {
      sendJson(response, 200, { package: service.deleteDefinition(parts[3] as string), deleted: true });
      return true;
    }

    if (packageRoute && request.method === "POST" && parts.length === 5 && parts[4] === "launch") {
      const run = service.launch(parts[3] as string, correlationId);
      sendJson(response, 202, { runId: run.id, run });
      return true;
    }

    if (runRoute && request.method === "GET" && parts.length === 4) {
      sendJson(response, 200, { run: service.getRun(parts[3] as string) });
      return true;
    }

    if (runRoute && request.method === "POST" && parts.length === 5 && parts[4] === "retry") {
      const run = service.retryRun(parts[3] as string, correlationId);
      sendJson(response, 202, { runId: run.id, run });
      return true;
    }

    if (runRoute && request.method === "POST" && parts.length === 5 && parts[4] === "abort") {
      sendJson(response, 200, { run: service.abortRun(parts[3] as string) });
      return true;
    }

    throw new AppPackageServiceError(404, "PACKAGE_ROUTE_NOT_FOUND", "Relaybase app package route was not found.", {
      detail: { method: request.method, route: parts.join("/") },
      userAction: "Use a documented app package or package-run API route."
    });
  } catch (error) {
    if (error instanceof AppPackageServiceError) {
      sendJson(
        response,
        error.statusCode,
        relaybaseErrorResponse({
          code: error.code,
          message: error.message,
          retryable: error.retryable,
          correlationId,
          detail: error.detail,
          userAction: error.userAction
        })
      );
      return true;
    }
    throw error;
  }
}

async function readJsonBody(request: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_JSON_BODY_BYTES) {
      throw new AppPackageServiceError(413, "PACKAGE_REQUEST_TOO_LARGE", "App package request body is too large.", {
        userAction: "Send a package request smaller than 256 KiB."
      });
    }
    chunks.push(buffer);
  }
  if (chunks.length === 0) {
    return {};
  }
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("body must be an object");
    }
    return parsed as Record<string, unknown>;
  } catch {
    throw new AppPackageServiceError(
      400,
      "PACKAGE_REQUEST_INVALID_JSON",
      "App package request body must be a JSON object.",
      {
        userAction: "Send a valid JSON object with documented package fields."
      }
    );
  }
}
