import { NextRequest, NextResponse } from 'next/server';

import { falTokenAllowedApps } from '@/lib/fal-allowed-app';

/**
 * `POST https://rest.fal.ai/tokens/` often returns a JSON *string literal* (quotes in the body).
 * The WebSocket URL must use the raw JWT only — no surrounding `"` or the handshake fails
 * (`Invalid frame header` / connection errors).
 */
function extractJwtFromTokensResponse(body: string): string {
  const trimmed = body.trim();
  if (!trimmed) return trimmed;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (typeof parsed === 'string') return parsed;
    if (
      parsed &&
      typeof parsed === 'object' &&
      'detail' in parsed &&
      typeof (parsed as { detail: unknown }).detail === 'string'
    ) {
      return (parsed as { detail: string }).detail;
    }
  } catch {
    /* fall through */
  }
  if (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

/**
 * Short-lived JWT for `fal.realtime.connect` (browser → your backend → Fal).
 * @see https://fal.ai/docs
 */
export async function POST(request: NextRequest) {
  const key = process.env.FAL_KEY;
  if (!key?.trim()) {
    return new NextResponse('FAL_KEY is not configured on the server', {
      status: 500,
    });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return new NextResponse('Invalid JSON body', { status: 400 });
  }

  if (!body || typeof body !== 'object' || !('app' in body)) {
    return new NextResponse('Missing "app" in JSON body', { status: 400 });
  }

  const app = (body as { app: unknown }).app;
  if (typeof app !== 'string' || app.length === 0) {
    return new NextResponse('Invalid "app"', { status: 400 });
  }

  const rawExp = (body as { token_expiration?: unknown }).token_expiration;
  const tokenExpiration =
    typeof rawExp === 'number' && Number.isFinite(rawExp)
      ? Math.min(600, Math.max(10, Math.floor(rawExp)))
      : 120;

  let allowedApps: string[];
  try {
    allowedApps = falTokenAllowedApps(app);
  } catch {
    return new NextResponse('Invalid app identifier', { status: 400 });
  }

  const upstream = await fetch('https://rest.fal.ai/tokens/', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Key ${key}`,
    },
    body: JSON.stringify({
      allowed_apps: allowedApps,
      token_expiration: tokenExpiration,
    }),
  });

  const text = await upstream.text();

  if (!upstream.ok) {
    return new NextResponse(text, { status: upstream.status });
  }

  const token = extractJwtFromTokensResponse(text);

  return new NextResponse(token, {
    status: 200,
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
}
