import { useEffect, useRef, useState } from 'react';

const reducedMotion = () => typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * A heading cut along a diagonal into two halves that slide in from opposite sides and lock together
 * on a lime seam, like an anime title card. Plays when scrolled into view, or when `play` turns true.
 * The real text sits in a visually hidden span, so assistive tech reads it once.
 */
export function SplitText({
  text,
  as: Tag = 'h2',
  className = '',
  play,
}: {
  text: string;
  as?: 'h1' | 'h2' | 'p' | 'span';
  className?: string;
  play?: boolean;
}) {
  const ref = useRef<HTMLElement>(null);
  const [state, setState] = useState<'idle' | 'run' | 'done'>(() => (reducedMotion() ? 'done' : 'idle'));

  useEffect(() => {
    if (state !== 'idle') return;
    if (play === false) return;
    if (play === true) {
      setState('run');
      return;
    }
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(
      ([e]) => {
        if (e.isIntersecting) {
          setState('run');
          io.disconnect();
        }
      },
      { threshold: 0.35 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [play, state]);

  useEffect(() => {
    if (state !== 'run') return;
    const t = setTimeout(() => setState('done'), 1100);
    return () => clearTimeout(t);
  }, [state]);

  return (
    <Tag ref={ref as never} className={`split ${className}`} data-state={state}>
      <span className="vh">{text}</span>
      <span className="split-a" aria-hidden="true">{text}</span>
      <span className="split-b" aria-hidden="true">{text}</span>
      <svg className="split-seam" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
        <line x1="-2" y1="66" x2="102" y2="34" />
      </svg>
    </Tag>
  );
}
