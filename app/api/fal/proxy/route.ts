import {
  fromHeaders,
  handleRequest,
} from "@fal-ai/serverless-proxy";
import { NextRequest, NextResponse } from "next/server";

function safeFalResponseHeaders(upstream: Response): Record<string, string> {
  const id = upstream.headers.get("x-fal-request-id");
  return id ? { "x-fal-request-id": id } : {};
}

/**
 * App Router fal proxy with explicit NextResponse materialization.
 * - Drops hop-by-hop headers (opaque 500s from Next if forwarded).
 * - On upstream errors, always returns JSON so `@fal-ai/client` can populate `ApiError.body`
 *   (otherwise HTML/plain 500 → `body: undefined`).
 */
async function routeHandler(request: NextRequest) {
  try {
    return await handleRequest({
      id: "nextjs-app-router",
      method: request.method,
      getRequestBody: async () => request.text(),
      getHeaders: () => fromHeaders(request.headers),
      getHeader: (name) => request.headers.get(name),
      sendHeader: (name, value) => {
        void name;
        void value;
        /* Headers are applied in sendResponse from upstream Response; avoid accumulating
         * values that NextResponse rejects (some x-fal-* or CDN headers). */
      },
      respondWith: (status, data) =>
        NextResponse.json(data, { status }),
      sendResponse: async (res) => {
        const text = await res.text();
        const ct = (res.headers.get("content-type") ?? "").toLowerCase();
        const meta = safeFalResponseHeaders(res);

        const tryParseJson = () => {
          if (!ct.includes("application/json") || text.length === 0) return null;
          try {
            return JSON.parse(text) as unknown;
          } catch {
            return null;
          }
        };

        if (!res.ok) {
          const parsed = tryParseJson();
          if (parsed !== null) {
            return NextResponse.json(parsed, { status: res.status, headers: meta });
          }
          const clip = text.slice(0, 12_000);
          console.warn("[api/fal/proxy] upstream non-JSON error", {
            status: res.status,
            contentType: ct || "(missing)",
            bodyPreview: clip.slice(0, 800),
          });
          return NextResponse.json(
            {
              message:
                clip.slice(0, 500) ||
                `Fal HTTP ${res.status} (${res.statusText || "error"})`,
              detail: clip || `Upstream HTTP ${res.status}`,
            },
            { status: res.status, headers: meta },
          );
        }

        if (ct.includes("application/json")) {
          const parsed = tryParseJson();
          if (parsed !== null) {
            return NextResponse.json(parsed, { status: res.status, headers: meta });
          }
          return NextResponse.json(
            {
              message: "Fal returned invalid JSON for a JSON response",
              detail: text.slice(0, 2000),
            },
            { status: 502, headers: meta },
          );
        }

        return new NextResponse(text, {
          status: res.status,
          headers: meta,
        });
      },
    });
  } catch (err) {
    console.error(
      "[api/fal/proxy]",
      err instanceof Error ? err.stack ?? err.message : err,
    );
    return NextResponse.json(
      {
        message:
          err instanceof Error
            ? err.message
            : "Fal proxy failed (see server logs)",
        detail:
          err instanceof Error
            ? err.message
            : "Fal proxy failed (see server logs)",
      },
      { status: 500 },
    );
  }
}

export const GET = routeHandler;
export const POST = routeHandler;
export const PUT = routeHandler;
