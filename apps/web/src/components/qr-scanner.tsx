'use client';

import jsQR from 'jsqr';
import { useEffect, useRef, useState } from 'react';

type State = 'starting' | 'scanning' | 'denied' | 'unavailable';

interface DetectorLike {
  detect(source: CanvasImageSource): Promise<{ rawValue: string }[]>;
}

/** Extracts an asset tag from a ToolTrace label URL (…/t/TW-0101) or a bare tag. Never follows the URL. */
export function parseTag(raw: string): string | null {
  const text = raw.trim();
  const fromUrl = text.match(/\/t\/([A-Za-z0-9][A-Za-z0-9-]{2,31})\/?(?:[?#].*)?$/);
  const tag = (fromUrl?.[1] ?? text).toUpperCase();
  return /^[A-Z0-9][A-Z0-9-]{2,31}$/.test(tag) ? tag : null;
}

/**
 * Rear-camera QR scanner. Uses the browser's built-in BarcodeDetector where
 * it exists (fast, native), and falls back to jsQR everywhere else.
 */
export function QrScanner({ onTag, onUnknown }: { onTag: (tag: string) => void; onUnknown: (raw: string) => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const [state, setState] = useState<State>('starting');
  const done = useRef(false);

  useEffect(() => {
    let stream: MediaStream | undefined;
    let raf = 0;
    let cancelled = false;
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const Detector = (window as unknown as { BarcodeDetector?: new (o: object) => DetectorLike }).BarcodeDetector;
    const detector = Detector ? new Detector({ formats: ['qr_code'] }) : null;
    let busy = false;
    let lastUnknown = '';

    const handle = (value: string) => {
      const tag = parseTag(value);
      if (tag) {
        done.current = true;
        navigator.vibrate?.(60);
        onTag(tag);
      } else if (value !== lastUnknown) {
        lastUnknown = value;
        onUnknown(value);
      }
    };

    const tick = async () => {
      if (cancelled || done.current) return;
      const v = video.current;
      if (v && v.readyState >= v.HAVE_ENOUGH_DATA && !busy) {
        busy = true;
        try {
          if (detector) {
            const codes = await detector.detect(v);
            if (codes[0]) handle(codes[0].rawValue);
          } else if (ctx) {
            const scale = Math.min(1, 640 / v.videoWidth);
            canvas.width = Math.round(v.videoWidth * scale);
            canvas.height = Math.round(v.videoHeight * scale);
            ctx.drawImage(v, 0, 0, canvas.width, canvas.height);
            const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
            const code = jsQR(img.data, img.width, img.height, { inversionAttempts: 'dontInvert' });
            if (code?.data) handle(code.data);
          }
        } catch {
          // A single bad frame is not fatal; keep scanning.
        }
        busy = false;
      }
      raf = requestAnimationFrame(tick);
    };

    (async () => {
      if (!navigator.mediaDevices?.getUserMedia) {
        setState('unavailable');
        return;
      }
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 } },
          audio: false,
        });
        if (cancelled) return;
        const v = video.current!;
        v.srcObject = stream;
        await v.play();
        setState('scanning');
        raf = requestAnimationFrame(tick);
      } catch (e) {
        setState((e as Error).name === 'NotAllowedError' ? 'denied' : 'unavailable');
      }
    })();

    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, [onTag, onUnknown]);

  return (
    <div className="relative aspect-square w-full overflow-hidden rounded-2xl bg-[#0d1210]">
      <video ref={video} className="size-full object-cover" playsInline muted aria-label="Camera view" />
      {/* Viewfinder brackets */}
      <div className="pointer-events-none absolute inset-[14%]" aria-hidden>
        {['left-0 top-0 border-l-4 border-t-4', 'right-0 top-0 border-r-4 border-t-4', 'bottom-0 left-0 border-b-4 border-l-4', 'bottom-0 right-0 border-b-4 border-r-4'].map(
          (c) => (
            <span key={c} className={`absolute size-10 rounded-[3px] border-safety ${c}`} />
          ),
        )}
      </div>
      <p className="absolute inset-x-0 bottom-0 bg-black/55 px-4 py-3 text-center text-sm font-medium text-white" role="status">
        {state === 'starting' && 'Starting camera…'}
        {state === 'scanning' && 'Point at the QR label on the tool'}
        {state === 'denied' && 'Camera permission was blocked. Allow it in your browser settings, or type the tag below.'}
        {state === 'unavailable' && 'No camera available here. Type the asset tag below.'}
      </p>
    </div>
  );
}
