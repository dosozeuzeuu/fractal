import type React from 'react';
import { useEffect, useMemo, useState } from 'react';

type Phase = 'wait' | 'in' | 'title' | 'tag' | 'slash' | 'out';

// Milliseconds from start. The screen is cut along a diagonal and the halves part to reveal the site.
const T = { title: 520, tag: 1150, slash: 2050, out: 2230, end: 2950 };

function AccentLines() {
  const lines = useMemo(() => {
    const out: React.JSX.Element[] = [];
    let seed = 11;
    const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    for (let i = 0; i < 96; i++) {
      const a = (i / 96) * Math.PI * 2 + rnd() * 0.04;
      const inner = 14 + rnd() * 22;
      out.push(
        <line key={i} x1={50 + Math.cos(a) * inner} y1={50 + Math.sin(a) * inner} x2={50 + Math.cos(a) * 120} y2={50 + Math.sin(a) * 120} strokeWidth={0.12 + rnd() * 0.55} />,
      );
    }
    return out;
  }, []);
  return (
    <svg className="ld-lines" viewBox="0 0 100 100" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
      {lines}
    </svg>
  );
}

function Layer({ phase, pct, side }: { phase: Phase; pct: number; side: 'a' | 'b' }) {
  return (
    <div className={`ld-layer ld-${side}`} aria-hidden={side === 'b'}>
      <AccentLines />
      <span className="ld-kata" aria-hidden="true">フラクタル</span>
      <div className="ld-center">
        <div className="ld-title" aria-hidden="true">
          <span className="ld-ta">FRACTAL</span>
          <span className="ld-tb">FRACTAL</span>
        </div>
        <p className="ld-tag">The privacy world, for you</p>
        <p className="ld-jp" aria-hidden="true">あなたのためのプライバシーの世界</p>
      </div>
      <div className="ld-foot" aria-hidden="true">
        <span>読み込み中</span>
        <span className="ld-bar"><i style={{ transform: `scaleX(${pct / 100})` }} /></span>
        <span>{String(pct).padStart(3, '0')}</span>
      </div>
      {side === 'a' && phase !== 'wait' && <span className="ld-flash" aria-hidden="true" />}
    </div>
  );
}

/**
 * Black-and-lime intro: speed lines, a katakana stamp, FRACTAL cut in two and joined, then a lime slash
 * splits the screen and the halves part. Runs once per browser session; skipped for reduced motion.
 */
export function Loader({ onDone }: { onDone: () => void }) {
  const [phase, setPhase] = useState<Phase>('wait');
  const [pct, setPct] = useState(0);
  const [skip, setSkip] = useState(false);

  useEffect(() => {
    document.documentElement.classList.add('ld-lock');
    let raf = 0;
    const timers: ReturnType<typeof setTimeout>[] = [];
    let start = 0;
    const tick = (now: number) => {
      const p = Math.min(100, Math.round(((now - start) / (T.slash - 150)) * 100));
      setPct(p);
      if (p < 100) raf = requestAnimationFrame(tick);
    };
    // Wait for the display fonts (at most 700 ms) so the title doesn't swap mid-animation.
    const fonts = (document as Document & { fonts?: FontFaceSet }).fonts;
    const ready = Promise.race([fonts ? fonts.ready : Promise.resolve(), new Promise((r) => setTimeout(r, 700))]);
    ready.then(() => {
      start = performance.now();
      setPhase('in');
      raf = requestAnimationFrame(tick);
      timers.push(setTimeout(() => setPhase('title'), T.title));
      timers.push(setTimeout(() => setPhase('tag'), T.tag));
      timers.push(setTimeout(() => setPhase('slash'), T.slash));
      timers.push(setTimeout(() => setPhase('out'), T.out));
      timers.push(setTimeout(() => finish(), T.end));
    });
    const finish = () => {
      document.documentElement.classList.remove('ld-lock');
      onDone();
    };
    return () => {
      cancelAnimationFrame(raf);
      timers.forEach(clearTimeout);
      document.documentElement.classList.remove('ld-lock');
    };
    // onDone is stable for the component's life.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!skip) return;
    setPct(100);
    setPhase('out');
    const t = setTimeout(() => {
      document.documentElement.classList.remove('ld-lock');
      onDone();
    }, 700);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [skip]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' || e.key === 'Enter' || e.key === ' ') setSkip(true);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div className="loader" data-phase={phase} role="status" aria-label="Loading fractal">
      <Layer phase={phase} pct={pct} side="a" />
      <Layer phase={phase} pct={pct} side="b" />
      <svg className="ld-slash" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
        <line x1="0" y1="64" x2="100" y2="36" pathLength={1} />
      </svg>
      <button className="ld-skip" onClick={() => setSkip(true)}>Skip intro</button>
    </div>
  );
}

/** Whether the intro should play: once per session, never for reduced motion. */
export function shouldPlayIntro(): boolean {
  if (typeof window === 'undefined') return false;
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return false;
  try {
    if (sessionStorage.getItem('fx-intro')) return false;
    sessionStorage.setItem('fx-intro', '1');
  } catch {
    /* storage blocked: play it */
  }
  return true;
}
