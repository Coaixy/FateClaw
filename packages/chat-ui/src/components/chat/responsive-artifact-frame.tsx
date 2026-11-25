'use client';

import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { getArtifactHeightBudget } from './artifact-layout';

interface ArtifactSize {
  width: number;
  height: number;
  scale: number;
}

export function ResponsiveArtifactFrame({
  children,
  fitViewportHeight = false,
  zoom,
  minContentWidth = 0,
  layoutAspectRatio,
}: {
  children: ReactNode;
  fitViewportHeight?: boolean;
  zoom?: number;
  minContentWidth?: number;
  layoutAspectRatio?: number;
}) {
  const shellRef = useRef<HTMLDivElement>(null);
  const boardRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<ArtifactSize | null>(null);

  useLayoutEffect(() => {
    const shell = shellRef.current;
    const board = boardRef.current;
    if (!shell || !board) return;

    const viewport = shell.closest<HTMLElement>('[data-artifact-viewport]');
    const updateSize = () => {
      const viewportStyle = viewport ? getComputedStyle(viewport) : null;
      const paddingTop = parseFloat(viewportStyle?.paddingTop || '0');
      const paddingBottom = parseFloat(viewportStyle?.paddingBottom || '0');
      const availableHeight = getArtifactHeightBudget(
        {
          height:
            viewport?.clientHeight ??
            window.visualViewport?.height ??
            window.innerHeight,
          top: viewport?.getBoundingClientRect().top ?? 0,
          paddingTop,
          paddingBottom,
          borderTop: viewport?.clientTop ?? 0,
          scrollTop: viewport?.scrollTop ?? 0,
        },
        fitViewportHeight && viewport
          ? shell.getBoundingClientRect().top
          : undefined,
      );
      const layoutWidth =
        zoom === undefined && layoutAspectRatio
          ? Math.max(
              minContentWidth,
              Math.min(shell.clientWidth, availableHeight * layoutAspectRatio),
            )
          : Math.max(shell.clientWidth, minContentWidth);
      // Width belongs to the live container, never to a previous measurement or transform.
      board.style.width = `${layoutWidth}px`;
      const width = Math.max(board.offsetWidth, board.scrollWidth);
      const height = board.scrollHeight;
      if (!width || !height) return;
      const readingDetails = Boolean(
        board.querySelector('details[data-artifact-details][open]'),
      );
      const scale =
        zoom ??
        Math.min(
          1,
          shell.clientWidth / width,
          readingDetails ? 1 : availableHeight / height,
        );
      const next = { width, height, scale };
      setSize((previous) =>
        previous &&
        Math.abs(previous.width - width) < 0.5 &&
        Math.abs(previous.height - height) < 0.5 &&
        Math.abs(previous.scale - scale) < 0.0001
          ? previous
          : next,
      );
    };

    updateSize();
    let animationFrame = 0;
    const scheduleUpdate = () => {
      if (animationFrame) return;
      // Resizing a fitted wrapper during ResizeObserver delivery can start another delivery loop.
      animationFrame = window.requestAnimationFrame(() => {
        animationFrame = 0;
        updateSize();
      });
    };
    const observer =
      typeof ResizeObserver === 'undefined'
        ? null
        : new ResizeObserver(scheduleUpdate);
    observer?.observe(shell);
    observer?.observe(board);
    if (viewport) observer?.observe(viewport);
    window.addEventListener('resize', scheduleUpdate);
    window.visualViewport?.addEventListener('resize', scheduleUpdate);

    return () => {
      observer?.disconnect();
      window.cancelAnimationFrame(animationFrame);
      window.removeEventListener('resize', scheduleUpdate);
      window.visualViewport?.removeEventListener('resize', scheduleUpdate);
    };
  }, [fitViewportHeight, layoutAspectRatio, minContentWidth, zoom]);

  return (
    <div
      ref={shellRef}
      data-artifact-frame
      className="relative w-full min-w-0"
      style={{ height: size ? size.height * size.scale : undefined }}
    >
      <div
        className="relative mx-auto overflow-hidden"
        style={{
          width: size ? size.width * size.scale : '100%',
          height: size ? size.height * size.scale : undefined,
        }}
      >
        <div
          ref={boardRef}
          className="@container/artifact w-full origin-top-left"
          style={{
            transform:
              size && size.scale !== 1 ? `scale(${size.scale})` : undefined,
          }}
        >
          {children}
        </div>
      </div>
    </div>
  );
}
