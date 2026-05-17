'use client';

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { decode } from '@msgpack/msgpack';
import { ApiError, fal } from '@fal-ai/client';
import { DrawingPanel, type DrawingPanelHandle } from './drawing-panel';
import { falTokenAllowedApps } from '@/lib/fal-allowed-app';

fal.config({
  proxyUrl: '/api/fal/proxy',
});

/**
 * Realtime WebSocket img2img (same pattern as [dabit3/falai-lcm-turbo-app](https://github.com/dabit3/falai-lcm-turbo-app)).
 * Override with `NEXT_PUBLIC_FAL_REALTIME_APP` if you use a custom realtime endpoint id.
 *
 * Default: [fal-ai/flux-2/klein/realtime](https://fal.ai/models/fal-ai/flux-2/klein/realtime) (typed `RealtimeEdit` / sketch + prompt over WSS).
 */
const FAL_REALTIME_APP =
  (typeof process !== 'undefined' &&
    process.env.NEXT_PUBLIC_FAL_REALTIME_APP?.trim()) ||
  'fal-ai/flux-2/klein/realtime';

/** Matches the panel / letterbox fill — never use black behind generations. */
const FAL_PREVIEW_BG = '#fff8ee';

/** Client throttle aligned with fal realtime default spirit (~128ms); slightly tighter for sketch feel. */
const FAL_REALTIME_THROTTLE_MS = 96;
/** Local scheduler so we do not export the board faster than the realtime client throttles. */
const FAL_SCENE_THROTTLE_MS = 96;

const PROMPT =
  'Turn this into an abstract, highly organic image that fuses hieroglyphic signs and pictograms with the raw simplicity of cave painting—hand-made silhouettes, ritual marks, ochre and earth—and the tactile richness of oil paint: impasto, scraped layers, thin glazes, visible brush gesture. The content is ideas of memory: half-remembered shapes, palimpsest layers, faded and recurring marks, mnemonic signs that feel recovered rather than described—never a literal story or snapshot. Everything stays symbolic and non-literal: biomorphic shapes, swarming lines, and glyph-like figures suggested, never realistic bodies or scenes; biological imagery abstracted—cells, membranes, tissues, branching vessels, spores, simple marine or microbial echoes—as painted pattern and sign, never textbook illustration, never anatomical hyperrealism, no gore. Rooted in South America: Amazonian and Andean rhythm, lowland and high-altitude palettes, geoglyph-like lines, pre-Columbian textile and ceramic motifs as pure abstraction—never ethnographic illustration. Faint echoes of Mesoamerican glyph cadence and African diaspora form as pattern and color only. Depth comes from paint and surface, not from photographic space; strange palette, living organic motion within strict abstraction, not photorealistic, not hyperrealistic';

type FalUiStatus = 'idle' | 'sending' | 'ok' | 'error';

/** Hosted CDN URL → local blob for canvas paint (realtime payloads are usually `data:` already). */
async function materializeFalImageForDisplay(rawUrl: string): Promise<string> {
  const u = rawUrl.trim();
  if (u.startsWith('data:') || u.startsWith('blob:')) return u;
  if (!u.startsWith('https://') && !u.startsWith('http://')) {
    throw new Error('Unexpected image URL format from Fal');
  }
  const res = await fetch('/api/fal/fetch-media', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: u }),
  });
  if (!res.ok) {
    let msg = `Image fetch failed (${res.status})`;
    try {
      const j = (await res.json()) as { message?: string };
      if (typeof j.message === 'string') msg = j.message;
    } catch {
      /* ignore */
    }
    throw new Error(msg);
  }
  return URL.createObjectURL(await res.blob());
}

function revokeIfBlob(url: string | null) {
  if (url?.startsWith('blob:')) URL.revokeObjectURL(url);
}

/**
 * Match default Fal realtime decoding (msgpack + JSON string frames), then unwrap
 * `x-fal-message` envelopes so `onResult` runs (the stock client drops that type).
 */
async function decodeFalRealtimeWire(data: unknown): Promise<unknown> {
  if (typeof data === 'string') {
    return JSON.parse(data) as unknown;
  }
  const toUint8 = async (
    value: ArrayBuffer | Uint8Array | Blob,
  ): Promise<Uint8Array> => {
    if (value instanceof Uint8Array) return value;
    if (value instanceof Blob) return new Uint8Array(await value.arrayBuffer());
    return new Uint8Array(value);
  };
  if (data instanceof ArrayBuffer || data instanceof Uint8Array) {
    return decode(await toUint8(data)) as unknown;
  }
  if (data instanceof Blob) {
    return decode(await toUint8(data)) as unknown;
  }
  return data;
}

function normalizeFalRealtimeDecoded(decoded: unknown, depth = 0): unknown {
  if (depth > 8) return decoded;
  if (!decoded || typeof decoded !== 'object') return decoded;
  const d = decoded as Record<string, unknown>;
  if (d.type === 'x-fal-message') {
    const inner =
      d.payload ??
      d.data ??
      d.message ??
      d.output ??
      d.result ??
      d.body;
    if (inner != null && typeof inner === 'object') {
      return normalizeFalRealtimeDecoded(inner, depth + 1);
    }
  }
  return decoded;
}

/** Binary JPEG/PNG from msgpack → data URL for canvas `Image` src. */
function uint8ToBase64(bytes: Uint8Array): string {
  const CHUNK = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    const sub = bytes.subarray(i, i + CHUNK);
    binary += String.fromCharCode.apply(null, sub as unknown as number[]);
  }
  return btoa(binary);
}

/** Msgpack / Buffer polyfills may expose bytes as views other than Uint8Array. */
function asUint8Array(value: unknown): Uint8Array | null {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value) && !(value instanceof DataView)) {
    const v = value as ArrayBufferView;
    return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
  }
  return null;
}

function tryImageRowToDisplayUrl(row: unknown): string | null {
  if (!row || typeof row !== 'object') return null;
  const o = row as Record<string, unknown>;
  if (typeof o.url === 'string' && o.url.length > 0) return o.url;
  const ctRaw =
    (typeof o.content_type === 'string' && o.content_type.length > 0
      ? o.content_type
      : null) ??
    (typeof o.contentType === 'string' && o.contentType.length > 0
      ? o.contentType
      : null) ??
    'image/jpeg';
  const ct = ctRaw;
  const c = o.content ?? o.data ?? o.bytes;
  if (typeof c === 'string' && c.length > 0) {
    if (c.startsWith('data:')) return c;
    return `data:${ct};base64,${c}`;
  }
  const bin = asUint8Array(c);
  if (bin && bin.byteLength > 0) {
    return `data:${ct};base64,${uint8ToBase64(bin)}`;
  }
  return null;
}

/** Unwrap Fal realtime / queue-style envelopes. */
function unwrapFalPayload(result: unknown): Record<string, unknown> | null {
  if (!result || typeof result !== 'object') return null;
  let cur: Record<string, unknown> = result as Record<string, unknown>;
  for (let d = 0; d < 6; d += 1) {
    if (cur.status === 'error') return null;
    const next =
      (cur.data && typeof cur.data === 'object' && (cur.data as object)) ||
      (cur.result && typeof cur.result === 'object' && (cur.result as object)) ||
      (cur.output && typeof cur.output === 'object' && (cur.output as object)) ||
      (cur.payload && typeof cur.payload === 'object' && (cur.payload as object)) ||
      (cur.response && typeof cur.response === 'object' && (cur.response as object)) ||
      (cur.body && typeof cur.body === 'object' && (cur.body as object));
    if (!next) break;
    cur = next as Record<string, unknown>;
  }
  return cur;
}

function pickRealtimePreviewUrl(result: unknown): string | null {
  const r = unwrapFalPayload(result);
  if (!r) return null;
  if (r.error) return null;

  let images = r.images;
  if ((!Array.isArray(images) || images.length === 0) && r && typeof r === 'object') {
    for (const v of Object.values(r)) {
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        const nested = (v as Record<string, unknown>).images;
        if (Array.isArray(nested) && nested.length > 0) {
          images = nested;
          break;
        }
      }
    }
  }

  if (Array.isArray(images) && images.length > 0) {
    for (let i = images.length - 1; i >= 0; i -= 1) {
      const picked = tryImageRowToDisplayUrl(images[i]);
      if (picked) return picked;
    }
  }

  if (r.image) {
    const picked = tryImageRowToDisplayUrl(r.image);
    if (picked) return picked;
  }

  return null;
}

/** DevTools-friendly summary of the drawable `src` (never logs full base64). */
function describePreviewSrcForLog(src: string): {
  kind: 'https' | 'http' | 'data-url' | 'blob' | 'other';
  mime?: string;
  approximateBase64Chars?: number;
  host?: string;
} {
  if (src.startsWith('https://')) {
    try {
      return { kind: 'https', host: new URL(src).host };
    } catch {
      return { kind: 'https' };
    }
  }
  if (src.startsWith('http://')) {
    try {
      return { kind: 'http', host: new URL(src).host };
    } catch {
      return { kind: 'http' };
    }
  }
  if (src.startsWith('data:')) {
    const semi = src.indexOf(';');
    const comma = src.indexOf(',');
    const mime = semi > 5 ? src.slice(5, semi) : undefined;
    const approximateBase64Chars = comma >= 0 ? src.length - comma - 1 : 0;
    return { kind: 'data-url', mime, approximateBase64Chars };
  }
  if (src.startsWith('blob:')) {
    return { kind: 'blob' };
  }
  return { kind: 'other' };
}

function formatFalError(error: unknown): string {
  if (error instanceof ApiError) {
    const body = error.body as {
      detail?: unknown;
      message?: string;
      error?: string;
    } | undefined;
    const detail = body?.detail;
    if (typeof detail === 'string') return detail;
    if (Array.isArray(detail) && detail[0] && typeof detail[0] === 'object') {
      const row = detail[0] as { msg?: string; message?: string };
      return row.msg ?? row.message ?? error.message;
    }
    if (typeof body?.error === 'string') return body.error;
    return (
      body?.message ??
      error.message ??
      `Fal request failed (HTTP ${String(error.status)})`
    );
  }
  if (error instanceof Error) return error.message;
  return 'Fal request failed';
}

export default function Home() {
  const drawRef = useRef<DrawingPanelHandle>(null);
  const falCanvasHostRef = useRef<HTMLDivElement>(null);
  const falCanvasRef = useRef<HTMLCanvasElement>(null);
  const falPaintGenRef = useRef(0);
  const realtimeSendRef = useRef<((input: Record<string, unknown>) => void) | null>(
    null,
  );

  const [hasFalImage, setHasFalImage] = useState(false);
  const hasFalImageRef = useRef(false);
  const [hydrated, setHydrated] = useState(false);
  const [editorReady, setEditorReady] = useState(false);
  const [falStatus, setFalStatus] = useState<FalUiStatus>('idle');
  const [falDetail, setFalDetail] = useState<string | null>(null);
  const [lastFrameAt, setLastFrameAt] = useState<number | null>(null);

  const seed = useMemo(() => Math.floor(Math.random() * 100_000), []);

  const paintRasterOnFalPreviewCanvas = useCallback(
    async (rasterSrc: string, revokeRasterWhenDone: boolean): Promise<boolean> => {
      const gen = ++falPaintGenRef.current;

      const img = new Image();
      await new Promise<void>((resolve, reject) => {
        img.onload = () => {
          img.decode?.().then(() => resolve()).catch(() => resolve());
        };
        img.onerror = () => reject(new Error('Bitmap decode failed'));
        img.src = rasterSrc;
      });

      if (gen !== falPaintGenRef.current) {
        if (revokeRasterWhenDone) revokeIfBlob(rasterSrc);
        return false;
      }

      /** Flex layout often reports 0×0 for one frame; wait before giving up. */
      let host: HTMLDivElement | null = null;
      let w = 0;
      let h = 0;
      for (let i = 0; i < 12; i += 1) {
        host = falCanvasHostRef.current;
        const canvasTry = falCanvasRef.current;
        if (!host || !canvasTry) {
          if (revokeRasterWhenDone) revokeIfBlob(rasterSrc);
          return false;
        }
        w = host.clientWidth;
        h = host.clientHeight;
        if (w > 0 && h > 0) break;
        await new Promise<void>((r) => requestAnimationFrame(() => r()));
      }

      if (gen !== falPaintGenRef.current) {
        if (revokeRasterWhenDone) revokeIfBlob(rasterSrc);
        return false;
      }

      const canvas = falCanvasRef.current;
      if (!host || !canvas || w <= 0 || h <= 0) {
        if (revokeRasterWhenDone) revokeIfBlob(rasterSrc);
        return false;
      }

      const sw = img.naturalWidth;
      const sh = img.naturalHeight;
      if (sw <= 0 || sh <= 0) {
        if (revokeRasterWhenDone) revokeIfBlob(rasterSrc);
        return false;
      }

      const dpr = Math.min(2, window.devicePixelRatio ?? 1);
      const pw = Math.max(1, Math.floor(w * dpr));
      const ph = Math.max(1, Math.floor(h * dpr));

      const off = document.createElement('canvas');
      off.width = pw;
      off.height = ph;
      const octx = off.getContext('2d');
      if (!octx) {
        if (revokeRasterWhenDone) revokeIfBlob(rasterSrc);
        return false;
      }

      octx.setTransform(1, 0, 0, 1, 0, 0);
      octx.scale(dpr, dpr);
      octx.fillStyle = FAL_PREVIEW_BG;
      octx.fillRect(0, 0, w, h);

      const scale = Math.min(w / sw, h / sh);
      const dw = sw * scale;
      const dh = sh * scale;
      const dx = (w - dw) / 2;
      const dy = (h - dh) / 2;
      octx.drawImage(img, dx, dy, dw, dh);

      if (gen !== falPaintGenRef.current) {
        if (revokeRasterWhenDone) revokeIfBlob(rasterSrc);
        return false;
      }

      canvas.width = pw;
      canvas.height = ph;
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;

      const ctx = canvas.getContext('2d');
      if (!ctx) {
        if (revokeRasterWhenDone) revokeIfBlob(rasterSrc);
        return false;
      }

      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.drawImage(off, 0, 0);

      if (revokeRasterWhenDone) revokeIfBlob(rasterSrc);

      if (gen === falPaintGenRef.current) {
        hasFalImageRef.current = true;
        setHasFalImage(true);
        setLastFrameAt(Date.now());
        return true;
      }

      return false;
    },
    [],
  );

  const paintFalPreviewFromRemoteOrDataUrl = useCallback(
    async (src: string): Promise<boolean> => {
      let raster = src;
      let revokeRaster = false;
      if (src.startsWith('http://') || src.startsWith('https://')) {
        raster = await materializeFalImageForDisplay(src);
        revokeRaster = true;
      } else if (src.startsWith('blob:')) {
        revokeRaster = true;
      }
      try {
        return await paintRasterOnFalPreviewCanvas(raster, revokeRaster);
      } catch (e) {
        if (revokeRaster) revokeIfBlob(raster);
        throw e;
      }
    },
    [paintRasterOnFalPreviewCanvas],
  );

  const sceneThrottleRef = useRef<{
    lastRun: number;
    trailingTimer: ReturnType<typeof setTimeout> | null;
  }>({ lastRun: 0, trailingTimer: null });

  const pushRealtimeSketch = useCallback(async () => {
    const send = realtimeSendRef.current;
    if (!send || !drawRef.current?.hasDrawableContent()) return;
    let dataUrl: string | null;
    try {
      dataUrl = await drawRef.current.getDataUrl();
    } catch (e) {
      console.warn('[Fal] sketch export failed', e);
      return;
    }
    if (!dataUrl) return;
    setFalStatus((s) => (s === 'error' ? s : 'sending'));
    send({
      prompt: PROMPT,
      image_url: dataUrl,
      seed,
      num_inference_steps: 4,
      image_size: 'square',
    });
  }, [seed]);

  const schedulePushAfterDrawChange = useCallback(() => {
    const t = sceneThrottleRef.current;
    const now = Date.now();
    const since = t.lastRun === 0 ? Number.POSITIVE_INFINITY : now - t.lastRun;

    if (since >= FAL_SCENE_THROTTLE_MS) {
      t.lastRun = now;
      if (t.trailingTimer) {
        clearTimeout(t.trailingTimer);
        t.trailingTimer = null;
      }
      void pushRealtimeSketch();
      return;
    }

    const remaining = FAL_SCENE_THROTTLE_MS - since;
    if (!t.trailingTimer) {
      t.trailingTimer = setTimeout(() => {
        t.trailingTimer = null;
        t.lastRun = Date.now();
        void pushRealtimeSketch();
      }, remaining);
    }
  }, [pushRealtimeSketch]);

  useEffect(() => {
    setHydrated(true);
  }, []);

  /** Fal WebSocket session (see dabit3/falai-lcm-turbo-app pattern). */
  useEffect(() => {
    if (!hydrated || !editorReady) return;

    const { send, close } = fal.realtime.connect(FAL_REALTIME_APP, {
      connectionKey: 'inpursuit-stolen-ghosts-realtime',
      clientOnly: true,
      throttleInterval: FAL_REALTIME_THROTTLE_MS,
      maxBuffering: 2,
      tokenExpirationSeconds: 120,
      decodeMessage: async (data) =>
        normalizeFalRealtimeDecoded(await decodeFalRealtimeWire(data)),
      tokenProvider: async () => {
        const res = await fetch('/api/fal/realtime-token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            app: FAL_REALTIME_APP,
            token_expiration: 120,
          }),
        });
        if (!res.ok) {
          throw new Error((await res.text()).slice(0, 500) || `HTTP ${res.status}`);
        }
        const raw = (await res.text()).trim();
        try {
          const parsed = JSON.parse(raw) as unknown;
          if (typeof parsed === 'string') return parsed;
        } catch {
          /* plain JWT */
        }
        if (raw.startsWith('"') && raw.endsWith('"') && raw.length >= 2) {
          return raw.slice(1, -1);
        }
        return raw;
      },
      onResult: (result) => {
        const src = pickRealtimePreviewUrl(result);
        if (!src) {
          if (process.env.NODE_ENV === 'development') {
            const u = unwrapFalPayload(result);
            console.warn('[Fal] realtime onResult: could not extract image', {
              topKeys:
                result && typeof result === 'object'
                  ? Object.keys(result as object)
                  : [],
              unwrappedKeys: u ? Object.keys(u) : null,
            });
          }
          return;
        }
        if (process.env.NODE_ENV === 'development') {
          const u = unwrapFalPayload(result);
          const rid =
            result && typeof result === 'object' && 'request_id' in result
              ? (result as { request_id?: unknown }).request_id
              : undefined;
          console.info(
            '[Fal] realtime: image frame received (WebSocket → onResult → bitmap URL)',
            {
              pipelineStep:
                'fal.realtime.connect / decodeMessage → handler onResult → pickRealtimePreviewUrl',
              request_id: rid,
              topLevelKeys:
                result && typeof result === 'object'
                  ? Object.keys(result as object)
                  : [],
              unwrappedKeys: u ? Object.keys(u) : null,
              imagesLength: Array.isArray(u?.images) ? u.images.length : null,
              previewSrc: describePreviewSrcForLog(src),
            },
          );
        }
        void paintFalPreviewFromRemoteOrDataUrl(src).then(
          (didPaint) => {
            if (didPaint) {
              if (process.env.NODE_ENV === 'development') {
                console.info(
                  '[Fal] realtime: preview canvas painted (Image.decode → drawImage)',
                );
              }
              setFalStatus('ok');
              setFalDetail(null);
            } else if (process.env.NODE_ENV === 'development') {
              console.warn(
                '[Fal] realtime: frame skipped (no layout size yet, stale generation, or empty bitmap)',
              );
            }
          },
          (e) => {
            console.error('[Fal] realtime frame paint failed', e);
            setFalStatus('error');
            setFalDetail(
              e instanceof Error ? e.message : 'Failed to paint realtime frame',
            );
          },
        );
      },
      onError: (err) => {
        const message = formatFalError(err);
        console.error('[Fal] realtime error', err);
        setFalStatus('error');
        setFalDetail(message);
      },
    });

    realtimeSendRef.current = (payload: Record<string, unknown>) => send(payload);

    return () => {
      realtimeSendRef.current = null;
      close();
    };
  }, [editorReady, hydrated, paintFalPreviewFromRemoteOrDataUrl]);

  /** Cream fill before the first frame only — must not run after a Fal bitmap exists or resize would erase it. */
  useEffect(() => {
    if (!hydrated) return;
    const host = falCanvasHostRef.current;
    const canvas = falCanvasRef.current;
    if (!host || !canvas) return;

    const paintCreamOnly = () => {
      if (hasFalImageRef.current) return;
      const w = host.clientWidth;
      const h = host.clientHeight;
      if (w <= 0 || h <= 0) return;
      const dpr = Math.min(2, window.devicePixelRatio ?? 1);
      const pw = Math.max(1, Math.floor(w * dpr));
      const ph = Math.max(1, Math.floor(h * dpr));
      canvas.width = pw;
      canvas.height = ph;
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.scale(dpr, dpr);
      ctx.fillStyle = FAL_PREVIEW_BG;
      ctx.fillRect(0, 0, w, h);
    };

    paintCreamOnly();
    const ro = new ResizeObserver(paintCreamOnly);
    ro.observe(host);
    return () => ro.disconnect();
  }, [hydrated]);

  useEffect(() => {
    if (!hydrated || !editorReady) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch('/api/fal/proxy', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-fal-target-url': 'https://rest.fal.ai/tokens/',
          },
          body: JSON.stringify({
            allowed_apps: falTokenAllowedApps(FAL_REALTIME_APP),
            token_expiration: 120,
          }),
        });
        const text = await res.text();
        if (cancelled) return;
        if (!res.ok) {
          let detail = text;
          try {
            const parsed = JSON.parse(text) as { detail?: unknown };
            if (typeof parsed.detail === 'string') detail = parsed.detail;
            else if (parsed.detail !== undefined)
              detail = JSON.stringify(parsed.detail);
          } catch {
            /* keep raw text */
          }
          console.error('[Fal] API token check failed', {
            status: res.status,
            statusText: res.statusText,
            detail,
          });
          setFalStatus('error');
          setFalDetail(
            `Fal API ${res.status}: ${detail.slice(0, 500)}${detail.length > 500 ? '…' : ''}`,
          );
          return;
        }
        console.info(
          '[Fal] API token check OK (credentials and billing accepted for realtime app alias).',
        );
      } catch (e) {
        if (cancelled) return;
        console.error('[Fal] token check network error', e);
        setFalStatus('error');
        setFalDetail(
          e instanceof Error
            ? e.message
            : 'Could not reach /api/fal/proxy (is dev server running?)',
        );
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [hydrated, editorReady]);

  useEffect(
    () => () => {
      const t = sceneThrottleRef.current;
      if (t.trailingTimer) clearTimeout(t.trailingTimer);
      falPaintGenRef.current += 1;
    },
    [],
  );

  const editorCaption = !hydrated
    ? 'Loading…'
    : editorReady
      ? 'Excalidraw is ready — the right panel streams over Fal realtime WebSocket (throttled sends while you draw).'
      : 'Loading drawing board…';

  const falCaption =
    falStatus === 'error'
      ? falDetail ?? 'Error talking to Fal.'
      : falStatus === 'ok' && lastFrameAt
        ? `Last image ${new Date(lastFrameAt).toLocaleTimeString()}.`
        : falStatus === 'sending'
          ? 'Realtime Fal inference (WebSocket)…'
          : 'Draw something first; Fal sends only when the sketch changes and the board is not empty.';

  const showStreamPlaceholder =
    !hasFalImage && !(falStatus === 'error' && falDetail);

  return (
    <main className="min-h-screen bg-[#fff8e8] p-12 text-stone-900">
      <div className="audio-player my-4">
        <p className="text-xl mb-2">
          en busca de los fantasmas robados | in pursuit of stolen ghosts
        </p>
        <audio controls src="/ghost_stolen.mp3" loop className="w-full max-w-md">
          Your browser does not support the audio element.
        </audio>
      </div>

      <div className="flex flex-wrap gap-8 items-start">
        <div className="space-y-3 max-w-[600px]">
          <div>
            <p className="text-sm font-semibold uppercase tracking-wide text-amber-950">
              draw here
            </p>
            <p className="text-base text-amber-950/80 mt-1">{editorCaption}</p>
          </div>
          {hydrated ? (
            <DrawingPanel
              ref={drawRef}
              onReadyChange={setEditorReady}
              onSceneChange={schedulePushAfterDrawChange}
            />
          ) : (
            <div
              className="h-[600px] w-[600px] rounded-sm border-2 border-dashed border-amber-900/35 bg-[#fff1c8] flex items-center justify-center text-amber-950/70 text-lg"
              aria-hidden
            >
              …
            </div>
          )}
        </div>

        <div className="space-y-3 max-w-[600px]">
          <div>
            <p className="text-sm font-semibold uppercase tracking-wide text-amber-950">
              fal realtime — {FAL_REALTIME_APP}
            </p>
            <p
              className={`text-base mt-1 ${
                falStatus === 'error' ? 'text-red-800 font-medium' : 'text-amber-950/80'
              }`}
              role="status"
              aria-live={falStatus === 'error' ? 'assertive' : 'polite'}
            >
              {falCaption}
            </p>
          </div>
          <div
            className="h-[600px] w-[600px] rounded-sm border-2 border-amber-900/25 flex flex-col overflow-hidden shadow-sm [color-scheme:light] bg-[#fff8ee]"
            style={{ backgroundColor: FAL_PREVIEW_BG }}
          >
            <div
              ref={falCanvasHostRef}
              className="relative flex-1 min-h-0 w-full h-full flex items-center justify-center p-1 isolate"
              style={{ backgroundColor: FAL_PREVIEW_BG }}
            >
              <canvas
                ref={falCanvasRef}
                className="absolute inset-0 z-[1] block h-full w-full"
                style={{ backgroundColor: FAL_PREVIEW_BG }}
                aria-hidden={!hasFalImage}
                role={hasFalImage ? 'img' : undefined}
                aria-label={hasFalImage ? 'Generated image' : undefined}
              />
              {!hasFalImage && falStatus === 'error' && falDetail ? (
                <div className="absolute inset-0 z-20 flex items-center justify-center overflow-auto p-4 bg-[#fff8ee]">
                  <div
                    className="text-left px-8 py-10 max-w-[520px] rounded-md border-2 border-red-700/50 bg-red-50 text-red-950 shadow-sm"
                    role="alert"
                  >
                    <p className="text-lg font-semibold">Fal did not accept the request</p>
                    <p className="text-sm mt-3 whitespace-pre-wrap break-words leading-relaxed">
                      {falDetail}
                    </p>
                    <p className="text-xs mt-4 text-red-900/80 border-t border-red-200 pt-4">
                      In Chrome or Firefox: open Developer Tools → Console and look for
                      lines starting with{' '}
                      <span className="font-mono bg-red-100 px-1 rounded">[Fal]</span>
                      (token check, realtime WebSocket, proxy failures).
                    </p>
                  </div>
                </div>
              ) : null}
              {showStreamPlaceholder ? (
                <div className="absolute inset-0 z-10 flex items-center justify-center p-6 bg-transparent pointer-events-none">
                  <div className="text-center px-10 py-12 border-2 border-dashed border-amber-900/25 rounded-md bg-[#fff8ee]/95 max-w-md shadow-sm pointer-events-auto">
                    <p className="text-lg font-medium text-amber-950">AI image stream</p>
                    <p className="text-base text-amber-900/70 mt-2">
                      When Fal returns frames, the picture shows up here in full size.
                    </p>
                  </div>
                </div>
              ) : null}
            </div>
          </div>
        </div>
      </div>

      <div className="mb-4 mt-8">
        <p className="text-xl mb-2">
          Play sound, sketch in Excalidraw on the left; the right panel follows over a Fal realtime
          WebSocket (same idea as{' '}
          <a
            href="https://github.com/dabit3/falai-lcm-turbo-app"
            className="underline text-amber-900"
            target="_blank"
            rel="noreferrer"
          >
            dabit3/falai-lcm-turbo-app
          </a>
          ). Default model:{' '}
          <a
            href="https://fal.ai/models/fal-ai/flux-2/klein/realtime"
            className="underline text-amber-900"
            target="_blank"
            rel="noreferrer"
          >
            fal-ai/flux-2/klein/realtime
          </a>
          ; override with{' '}
          <span className="font-mono text-sm bg-amber-100/80 px-1 rounded">
            NEXT_PUBLIC_FAL_REALTIME_APP
          </span>
          .
        </p>
        <p className="text-xl mb-2">
          concept, generative design, programming and music by{' '}
          <a
            href="https://linktr.ee/marlonbarriososolano"
            target="_blank"
            rel="noreferrer"
            className="underline text-amber-900"
          >
            Marlon Barrios Solano
          </a>
        </p>
      </div>
    </main>
  );
}
