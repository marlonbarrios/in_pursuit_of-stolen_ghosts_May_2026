'use client';

import '@excalidraw/excalidraw/index.css';
import dynamic from 'next/dynamic';
import {
  forwardRef,
  useImperativeHandle,
  useRef,
} from 'react';
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types';

const Excalidraw = dynamic(
  async () => (await import('@excalidraw/excalidraw')).Excalidraw,
  { ssr: false },
);

/** Fal realtime: JPEG data URI; cap longest side ~704px. Never return a 0×0 canvas (toBlob would fail). */
function exportRealtimeSketchBlob(api: ExcalidrawImperativeAPI) {
  const elements = api.getSceneElements().filter((el) => !el.isDeleted);
  if (elements.length === 0) {
    return Promise.reject(new Error('No drawable elements to export'));
  }

  return import('@excalidraw/excalidraw').then(({ exportToBlob }) =>
    exportToBlob({
      elements,
      appState: {
        ...api.getAppState(),
        exportBackground: true,
      },
      files: api.getFiles(),
      mimeType: 'image/jpeg',
      quality: 0.5,
      exportPadding: 10,
      /** When bounds are empty or tiny, still produce a valid canvas (avoids "couldn't export to blob"). */
      getDimensions: (width, height) => {
        const pad = 20;
        const bw = Math.max(1, width) + pad;
        const bh = Math.max(1, height) + pad;
        const cap = 704;
        const m = Math.max(bw, bh);
        const s = m > cap ? cap / m : 1;
        return {
          width: Math.max(8, Math.ceil(bw * s)),
          height: Math.max(8, Math.ceil(bh * s)),
        };
      },
    }),
  );
}

export type DrawingPanelHandle = {
  /** True if the scene has at least one non-deleted element (user actually drew). */
  hasDrawableContent: () => boolean;
  /** JPEG blob (realtime-friendly size); `@fal-ai/client` can still upload Blobs via storage where needed. */
  getExportBlob: () => Promise<Blob | null>;
  getDataUrl: () => Promise<string | null>;
};

type DrawingPanelProps = {
  onReadyChange?: (ready: boolean) => void;
  /** Fires when elements, app state, or embedded files change (pointer moves while drawing, edits, pan/zoom, etc.). */
  onSceneChange?: () => void;
};

export const DrawingPanel = forwardRef<
  DrawingPanelHandle,
  DrawingPanelProps
>(function DrawingPanel({ onReadyChange, onSceneChange }, ref) {
  const apiRef = useRef<ExcalidrawImperativeAPI | null>(null);
  const lastSerializedRef = useRef<string | null>(null);

  useImperativeHandle(ref, () => ({
    hasDrawableContent() {
      const api = apiRef.current;
      if (!api) return false;
      return api.getSceneElements().some((el) => !el.isDeleted);
    },
    async getExportBlob() {
      const api = apiRef.current;
      if (!api) return null;
      return exportRealtimeSketchBlob(api);
    },
    async getDataUrl() {
      const api = apiRef.current;
      if (!api) return null;
      const blob = await exportRealtimeSketchBlob(api);
      return new Promise<string | null>((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve(reader.result as string);
        reader.onerror = reject;
        reader.readAsDataURL(blob);
      });
    },
  }));

  return (
    <div className="drawing-panel-root h-[600px] w-[600px] overflow-hidden rounded-sm border-2 border-amber-900/40 bg-[#fff1c8] shadow-md ring-2 ring-amber-200/60">
      <Excalidraw
        excalidrawAPI={(api) => {
          apiRef.current = api;
          onReadyChange?.(true);
        }}
        onChange={(elements, appState, files) => {
          void import('@excalidraw/excalidraw').then(({ serializeAsJSON }) => {
            const json = serializeAsJSON(elements, appState, files, 'local');
            if (json !== lastSerializedRef.current) {
              lastSerializedRef.current = json;
              onSceneChange?.();
            }
          });
        }}
        initialData={{
          appState: {
            viewBackgroundColor: '#fff1c8',
            currentItemStrokeColor: '#2d2416',
            currentItemBackgroundColor: '#c9982d',
          },
        }}
      />
    </div>
  );
});
