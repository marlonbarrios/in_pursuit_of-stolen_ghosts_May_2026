import { NextRequest, NextResponse } from "next/server";

/**
 * Fetch Fal-hosted media server-side (avoids browser CORS) and return bytes.
 * Used to turn short-lived CDN URLs into `blob:` URLs in the client so images
 * keep working after Fal media TTL.
 */
function isAllowedFalMediaHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  if (h === "fal.media" || h.endsWith(".fal.media")) return true;
  /** e.g. `v3.fal.media`-style hosts sometimes appear as `*.fal.ai` in older docs */
  if (h === "v3.fal.ai" || h === "v3b.fal.ai") return true;
  return false;
}

export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ message: "Invalid JSON body" }, { status: 400 });
  }

  const urlRaw =
    body &&
    typeof body === "object" &&
    "url" in body &&
    typeof (body as { url: unknown }).url === "string"
      ? (body as { url: string }).url.trim()
      : "";

  if (!urlRaw) {
    return NextResponse.json({ message: "Missing url" }, { status: 400 });
  }

  let target: URL;
  try {
    target = new URL(urlRaw);
  } catch {
    return NextResponse.json({ message: "Invalid url" }, { status: 400 });
  }

  if (target.protocol !== "https:" || !isAllowedFalMediaHost(target.hostname)) {
    return NextResponse.json(
      { message: "URL host is not an allowed Fal media origin" },
      { status: 400 },
    );
  }

  const upstream = await fetch(target.toString(), {
    cache: "no-store",
    headers: { Accept: "image/*,*/*;q=0.8" },
  });

  if (!upstream.ok) {
    return NextResponse.json(
      { message: `Upstream Fal media HTTP ${upstream.status}` },
      { status: 502 },
    );
  }

  const ct =
    upstream.headers.get("content-type") ?? "application/octet-stream";
  const buf = await upstream.arrayBuffer();

  return new NextResponse(buf, {
    status: 200,
    headers: {
      "Content-Type": ct,
      "Cache-Control": "private, no-store",
    },
  });
}
