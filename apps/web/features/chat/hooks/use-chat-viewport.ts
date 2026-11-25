'use client';

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
} from 'react';

import type { Message } from '../api';
import { isNearBottom } from '../utils/display';

const OLDER_LOAD_THRESHOLD_PX = 120;
const SCROLL_IDLE_DELAY_MS = 1500;

export function useChatViewport({
  messages,
  isPending,
  scrollRef,
  prependAnchorRef,
  loadOlderMessages,
}: {
  messages: Message[];
  isPending: boolean;
  scrollRef: RefObject<HTMLDivElement | null>;
  prependAnchorRef: RefObject<{ height: number; top: number } | null>;
  loadOlderMessages: () => Promise<void>;
}) {
  const [followingLatest, setFollowingLatest] = useState(true);
  const [scrolling, setScrolling] = useState(false);
  const shouldAutoScrollRef = useRef(true);
  const autoScrollFrameRef = useRef<number | null>(null);

  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;

    let scrollIdleTimeout: number | undefined;
    const handleScroll = (event?: Event) => {
      const nearBottom = isNearBottom(element);
      shouldAutoScrollRef.current = nearBottom;
      setFollowingLatest((previous) =>
        previous === nearBottom ? previous : nearBottom,
      );
      if (event) {
        window.clearTimeout(scrollIdleTimeout);
        setScrolling(!nearBottom);
        if (!nearBottom) {
          scrollIdleTimeout = window.setTimeout(() => {
            setScrolling(false);
          }, SCROLL_IDLE_DELAY_MS);
        }
      }
      // 接近顶部且仍有更早消息时,自动加载上一页历史。
      if (element.scrollTop <= OLDER_LOAD_THRESHOLD_PX) {
        void loadOlderMessages();
      }
    };

    handleScroll();
    element.addEventListener('scroll', handleScroll);

    return () => {
      element.removeEventListener('scroll', handleScroll);
      window.clearTimeout(scrollIdleTimeout);
    };
  }, [loadOlderMessages, scrollRef]);

  // 上滑加载更早消息后顶部增高,这里把滚动位置补偿回原视口,避免「加载即跳动」。
  // 与下方自动贴底互斥:上滑时用户不在底部,shouldAutoScrollRef 为 false。
  useLayoutEffect(() => {
    const anchor = prependAnchorRef.current;
    if (!anchor || !scrollRef.current) return;
    prependAnchorRef.current = null;
    const element = scrollRef.current;
    // 维持「距底部距离」不变:新 scrollTop = 旧 scrollTop + 本次高度增量。
    element.scrollTop = anchor.top + (element.scrollHeight - anchor.height);
  }, [messages, prependAnchorRef, scrollRef]);

  const scheduleAutoScroll = useCallback(() => {
    if (autoScrollFrameRef.current !== null) return;

    autoScrollFrameRef.current = window.requestAnimationFrame(() => {
      autoScrollFrameRef.current = null;
      const element = scrollRef.current;
      if (!element || !shouldAutoScrollRef.current) return;
      element.scrollTop = element.scrollHeight;
    });
  }, [scrollRef]);

  useLayoutEffect(() => {
    if (!scrollRef.current || !shouldAutoScrollRef.current) return;
    scheduleAutoScroll();
  }, [messages, scheduleAutoScroll, scrollRef]);

  useEffect(() => {
    if (!isPending || !scrollRef.current || !shouldAutoScrollRef.current)
      return;
    scheduleAutoScroll();
  }, [isPending, scheduleAutoScroll, scrollRef]);

  useEffect(
    () => () => {
      if (autoScrollFrameRef.current !== null) {
        window.cancelAnimationFrame(autoScrollFrameRef.current);
        autoScrollFrameRef.current = null;
      }
    },
    [],
  );

  const resetFollowing = useCallback(() => {
    shouldAutoScrollRef.current = true;
    setFollowingLatest(true);
    setScrolling(false);
  }, []);

  const scrollToLatest = useCallback(() => {
    resetFollowing();
    const element = scrollRef.current;
    element?.scrollTo({ top: element.scrollHeight, behavior: 'instant' });
  }, [resetFollowing, scrollRef]);

  return {
    resetFollowing,
    shouldAutoScrollRef,
    followingLatest,
    showScrollToLatest: scrolling && !followingLatest,
    scrollToLatest,
  };
}
