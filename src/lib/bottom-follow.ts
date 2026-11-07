import { useLayoutEffect, type RefObject } from "react";

export const BOTTOM_FOLLOW_THRESHOLD = 4;

export function shouldResumeBottomFollow({
  following,
  previousScrollTop,
  scrollTop,
  distanceFromBottom,
}: {
  following: boolean;
  previousScrollTop: number;
  scrollTop: number;
  distanceFromBottom: number;
}): boolean {
  return !following && scrollTop > previousScrollTop && distanceFromBottom < BOTTOM_FOLLOW_THRESHOLD;
}

interface BottomFollowScroller {
  scrollHeight: number;
  scrollTo(options?: ScrollToOptions): void;
}

export function followBottomGrowth(scroller: BottomFollowScroller, following: boolean): boolean {
  if (!following) return false;
  scroller.scrollTo({ top: scroller.scrollHeight });
  return true;
}

export function useBottomFollowResize(
  scrollRef: RefObject<HTMLElement | null>,
  transcriptRef: RefObject<HTMLElement | null>,
  followingRef: RefObject<boolean>,
  observeKey: string | null,
): void {
  useLayoutEffect(() => {
    const scroller = scrollRef.current;
    const transcript = transcriptRef.current;
    if (!scroller || !transcript || observeKey === null) return;

    const observer = new ResizeObserver(() => {
      followBottomGrowth(scroller, followingRef.current);
    });
    observer.observe(transcript);
    return () => observer.disconnect();
  }, [followingRef, observeKey, scrollRef, transcriptRef]);
}
