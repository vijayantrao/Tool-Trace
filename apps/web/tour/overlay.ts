/**
 * Video helpers: a visible mouse cursor (recordings don't show the real one),
 * captions, and title cards. Only used to record the product tour.
 */
import type { BrowserContext, Locator, Page } from '@playwright/test';

const CURSOR = `
(() => {
  if (window.__tourCursor) return;
  window.__tourCursor = true;
  const add = () => {
    const c = document.createElement('div');
    c.id = 'tour-cursor';
    c.innerHTML = '<svg width="26" height="26" viewBox="0 0 24 24"><path d="M4 2l16 10-7 1.5L9.5 21z" fill="#111" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg>';
    Object.assign(c.style, { position: 'fixed', left: '-40px', top: '-40px', zIndex: 2147483647, pointerEvents: 'none', transition: 'transform 60ms linear' });
    document.documentElement.appendChild(c);
    addEventListener('mousemove', (e) => { c.style.left = e.clientX - 3 + 'px'; c.style.top = e.clientY - 2 + 'px'; }, true);
    addEventListener('mousedown', (e) => {
      const r = document.createElement('div');
      Object.assign(r.style, { position: 'fixed', left: e.clientX - 18 + 'px', top: e.clientY - 18 + 'px', width: '36px', height: '36px',
        borderRadius: '50%', border: '3px solid #f2c12e', zIndex: 2147483646, pointerEvents: 'none', transition: 'all 450ms ease-out', opacity: '1' });
      document.documentElement.appendChild(r);
      requestAnimationFrame(() => { r.style.transform = 'scale(1.8)'; r.style.opacity = '0'; });
      setTimeout(() => r.remove(), 500);
    }, true);
  };
  if (document.documentElement) add(); else addEventListener('DOMContentLoaded', add);
})();`;

export async function installCursor(context: BrowserContext) {
  await context.addInitScript(CURSOR);
}

/** A caption at the bottom of the frame. Re-created after full page loads. */
export async function say(page: Page, text: string, step?: string, where: 'top' | 'bottom' = 'bottom') {
  await page.evaluate(
    ([t, s, w]) => {
      let el = document.getElementById('tour-caption');
      if (!el) {
        el = document.createElement('div');
        el.id = 'tour-caption';
        Object.assign(el.style, {
          position: 'fixed', left: '50%', bottom: '92px', transform: 'translateX(-50%)', maxWidth: '1040px', width: 'max-content',
          padding: '16px 24px', borderRadius: '14px', background: 'rgba(20, 38, 32, 0.93)', color: '#fff',
          font: '500 23px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif', zIndex: '2147483645',
          boxShadow: '0 10px 30px rgba(0,0,0,.28)', pointerEvents: 'none', transition: 'opacity 250ms',
        });
        document.documentElement.appendChild(el);
      }
      el.innerHTML = (s ? `<span style="color:#f2c12e;font-weight:700;margin-right:12px">${s}</span>` : '') + t;
      // Bottom by default (above the app's notices); top when the action happens low on the screen.
      el.style.bottom = w === 'top' ? 'auto' : '92px';
      el.style.top = w === 'top' ? '24px' : 'auto';
      el.style.opacity = '1';
    },
    [text, step ?? '', where] as const,
  );
}

export async function hideCaption(page: Page) {
  await page.evaluate(() => document.getElementById('tour-caption')?.remove());
}

/** Moves the visible cursor smoothly to the element, then clicks it. */
/** Puts the element in the middle of the screen, clear of the caption at the bottom. */
async function center(target: Locator) {
  await target.evaluate((el) => el.scrollIntoView({ block: 'center', behavior: 'instant' }));
}

export async function glideClick(page: Page, target: Locator) {
  await center(target);
  const box = await target.boundingBox();
  if (!box) throw new Error('element not visible');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 24 });
  await page.waitForTimeout(250);
  await target.click();
}

export async function glideTo(page: Page, target: Locator) {
  await center(target);
  const box = await target.boundingBox();
  if (box) await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 24 });
}

/** A full-frame title card. */
export async function card(page: Page, title: string, lines: string[], seconds: number) {
  await page.setContent(`<!doctype html><html><body style="margin:0;height:100vh;display:grid;place-items:center;
    background:radial-gradient(circle at 30% 20%, #3d6b5c, #1d3a31);color:#fff;font-family:system-ui,-apple-system,'Segoe UI',sans-serif">
    <div style="max-width:980px;padding:0 40px">
      <div style="display:flex;align-items:center;gap:18px;margin-bottom:28px">
        <svg viewBox="0 0 32 32" width="64" height="64"><rect x="2" y="7" width="28" height="18" rx="3" fill="none" stroke="#fff" stroke-width="2.2"/>
        <circle cx="7.5" cy="16" r="1.8" fill="#fff"/><circle cx="24.5" cy="16" r="1.8" fill="#fff"/>
        <path d="M12 12h8M16 12v9" stroke="#f2c12e" stroke-width="2.6" stroke-linecap="round"/></svg>
        <span style="font-size:56px;font-weight:800;letter-spacing:.5px">${title}</span>
      </div>
      ${lines.map((l, i) => `<p style="margin:${i ? 10 : 0}px 0 0;font-size:${i ? 24 : 32}px;opacity:${i ? 0.85 : 1};line-height:1.35">${l}</p>`).join('')}
    </div></body></html>`);
  await page.waitForTimeout(seconds * 1000);
}

/**
 * Records the page with Chromium's own screencast (DevTools protocol): frames arrive
 * whenever the screen changes, each with its timestamp, so playback speed is exact.
 * Encoded afterwards by tour/encode.mjs.
 */
export async function startRecording(page: Page, dir: string) {
  const { mkdir, writeFile } = await import('node:fs/promises');
  const path = await import('node:path');
  await mkdir(dir, { recursive: true });
  const cdp = await page.context().newCDPSession(page);
  const frames: { file: string; t: number }[] = [];
  const marks: Record<string, number> = {};
  const writes: Promise<void>[] = [];
  let started = 0;
  cdp.on('Page.screencastFrame', (f) => {
    const file = path.join(dir, `frame-${String(frames.length).padStart(6, '0')}.jpg`);
    frames.push({ file, t: f.metadata.timestamp ?? Date.now() / 1000 });
    writes.push(writeFile(file, Buffer.from(f.data, 'base64')));
    void cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {});
  });
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 92, maxWidth: 1280, maxHeight: 720 });
  started = Date.now() / 1000;
  return {
    /** Remember when something happens, e.g. for cutting a GIF out of the video. */
    mark(name: string) {
      marks[name] = Date.now() / 1000 - started;
    },
    async stop() {
      await page.waitForTimeout(500);
      await cdp.send('Page.stopScreencast');
      await Promise.all(writes);
      const first = frames[0]?.t ?? started;
      await writeFile(
        path.join(dir, 'frames.json'),
        JSON.stringify({ frames: frames.map((f) => ({ file: path.basename(f.file), t: f.t - first })), marks, offset: first - started }),
      );
      return frames.length;
    },
  };
}
