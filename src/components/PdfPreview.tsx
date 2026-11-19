import { useEffect, useRef, useState } from 'react';
import type { PDFDocumentLoadingTask, PDFDocumentProxy } from 'pdfjs-dist';

/**
 * A PDF shown on the page, one page at a time, with previous and next. `href` is any URL
 * the browser can fetch: a file in /public, a blob URL, or an API route on this origin.
 */
export function PdfPreview({ href }: { href: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const documentRef = useRef<PDFDocumentProxy | null>(null);
  const loadingTaskRef = useRef<PDFDocumentLoadingTask | null>(null);
  const [page, setPage] = useState(1);
  const [pages, setPages] = useState(0);
  const [failed, setFailed] = useState(false);
  // Redraw when the stage width or the screen's pixel density changes (window resize, zoom, moving screens).
  const [layout, setLayout] = useState(0);
  useEffect(() => {
    let frame = 0;
    const bump = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(() => setLayout(n => n + 1)); };
    const stage = canvasRef.current?.parentElement;
    // Only a change of width needs a redraw; the page's own height change must not loop.
    let width = stage?.clientWidth ?? 0;
    const onResize = () => {
      const next = stage?.clientWidth ?? 0;
      if (next === width) return;
      width = next;
      bump();
    };
    const observer = typeof ResizeObserver === 'undefined' || !stage ? null : new ResizeObserver(onResize);
    if (observer && stage) observer.observe(stage);
    let media: MediaQueryList | null = null;
    const watchDensity = () => {
      media?.removeEventListener('change', onDensity);
      media = window.matchMedia?.(`(resolution: ${window.devicePixelRatio}dppx)`) ?? null;
      media?.addEventListener('change', onDensity);
    };
    function onDensity() { watchDensity(); bump(); }
    watchDensity();
    return () => {
      cancelAnimationFrame(frame);
      observer?.disconnect();
      media?.removeEventListener('change', onDensity);
    };
  }, [pages]);

  useEffect(() => {
    let cancelled = false;
    setFailed(false);
    setPage(1);
    setPages(0);
    void (async () => {
      const pdfjs = await import('pdfjs-dist');
      const worker = await import('pdfjs-dist/build/pdf.worker.min.mjs?url');
      pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
      const response = await fetch(href, { credentials: 'include' });
      if (!response.ok) throw new Error('The document could not be opened.');
      const data = new Uint8Array(await response.arrayBuffer());
      const task = pdfjs.getDocument({ data });
      loadingTaskRef.current = task;
      const document = await task.promise;
      if (cancelled) return;
      documentRef.current = document;
      setPages(document.numPages);
    })().catch(() => { if (!cancelled) setFailed(true); });
    return () => {
      cancelled = true;
      const task = loadingTaskRef.current;
      loadingTaskRef.current = null;
      documentRef.current = null;
      if (task && typeof task.destroy === 'function') void task.destroy().catch(() => undefined);
    };
  }, [href]);

  useEffect(() => {
    const document = documentRef.current;
    const canvas = canvasRef.current;
    if (!document || !canvas || pages < 1) return;
    let cancelled = false;
    let cancelRender = () => {};
    void (async () => {
      const pdfPage = await document.getPage(page);
      if (cancelled) return;
      const stage = canvas.parentElement;
      const maxWidth = Math.max((stage?.clientWidth ?? 800) - 32, 280);
      const base = pdfPage.getViewport({ scale: 1 });
      // FB-06: draw at the screen's real pixel density, then show at CSS size, so text stays sharp.
      const density = Math.min(Math.max(window.devicePixelRatio || 1, 1), 3);
      const viewport = pdfPage.getViewport({ scale: (maxWidth / base.width) * density });
      const context = canvas.getContext('2d');
      if (!context) return;
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      canvas.style.maxWidth = `${Math.floor(viewport.width / density)}px`;
      const task = pdfPage.render({ canvasContext: context, canvas, viewport });
      cancelRender = () => task.cancel();
      await task.promise;
    })().catch(() => undefined);
    return () => {
      cancelled = true;
      try { cancelRender(); } catch { /* a finished page has nothing left to cancel */ }
    };
  }, [page, pages, layout]);

  if (failed) return <p className="pharmsmart-guide__preview-status">This document could not be opened here. Download it instead.</p>;
  return (
    <div className="onboarding-pdf">
      <div className="onboarding-pdf__toolbar">
        <button type="button" onClick={() => setPage(current => Math.max(1, current - 1))} disabled={page <= 1}>Previous page</button>
        <span>{pages ? `Page ${page} of ${pages}` : 'Opening…'}</span>
        <button type="button" onClick={() => setPage(current => Math.min(pages || current, current + 1))} disabled={!pages || page >= pages}>Next page</button>
      </div>
      <div className="onboarding-pdf__stage">
        <canvas ref={canvasRef} aria-label={pages ? `Page ${page} of ${pages}` : 'Opening document'} />
      </div>
    </div>
  );
}

