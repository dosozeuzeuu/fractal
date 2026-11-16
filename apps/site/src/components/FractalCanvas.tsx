import type React from 'react';
import { Fragment, useEffect, useRef, useState } from 'react';

// 8×8 Bayer matrix: ordered dithering turns the fractal's shading into manga-style screentone dots.
const BAYER = [
  0, 32, 8, 40, 2, 34, 10, 42, 48, 16, 56, 24, 50, 18, 58, 26, 12, 44, 4, 36, 14, 46, 6, 38, 60, 28, 52, 20, 62, 30, 54, 22,
  3, 35, 11, 43, 1, 33, 9, 41, 51, 19, 59, 27, 49, 17, 57, 25, 15, 47, 7, 39, 13, 45, 5, 37, 63, 31, 55, 23, 61, 29, 53, 21,
].map((v) => (v + 0.5) / 64);

const BASE_CR = -0.7269;
const BASE_CI = 0.1889;
const reducedMotion = () => typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * A full-bleed Julia set, ordered-dithered to pure black and white and scaled up with crisp pixels.
 * Moving the pointer reshapes it (the Julia constant follows the cursor), and a HUD reticle reads out
 * the constant. It drifts slowly on its own; static for reduced motion; paused off-screen.
 */
export function HeroFractal() {
  const host = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const reticle = useRef<HTMLDivElement>(null);
  const readout = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current!;
    const el = host.current!.parentElement!;
    const ctx = canvas.getContext('2d', { alpha: false })!;
    const reduced = reducedMotion();
    let visible = true;
    let raf = 0;
    let last = 0;
    let target = { x: 0.5, y: 0.5 };
    let cur = { x: 0.5, y: 0.5 };
    const t0 = performance.now();

    const size = () => {
      const r = canvas.getBoundingClientRect();
      const scale = r.width < 700 ? 4 : 3; // each fractal pixel is a 3×3 (or 4×4) block on screen
      canvas.width = Math.max(80, Math.round(r.width / scale));
      canvas.height = Math.max(80, Math.round(r.height / scale));
    };
    size();
    const ro = new ResizeObserver(() => { size(); if (reduced) draw(0); });
    ro.observe(canvas);
    const io = new IntersectionObserver(([e]) => (visible = e.isIntersecting));
    io.observe(canvas);

    const onMove = (e: PointerEvent) => {
      const r = el.getBoundingClientRect();
      target = { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height };
      if (reticle.current) {
        reticle.current.style.opacity = '1';
        reticle.current.style.transform = `translate(${e.clientX - r.left}px, ${e.clientY - r.top}px)`;
      }
    };
    const onLeave = () => {
      target = { x: 0.5, y: 0.5 };
      if (reticle.current) reticle.current.style.opacity = '0';
    };
    if (!reduced) {
      el.addEventListener('pointermove', onMove);
      el.addEventListener('pointerleave', onLeave);
    }

    function draw(t: number) {
      const w = canvas.width;
      const h = canvas.height;
      const img = ctx.createImageData(w, h);
      const d = img.data;
      const phase = t / 1000;
      cur = { x: cur.x + (target.x - cur.x) * 0.08, y: cur.y + (target.y - cur.y) * 0.08 };
      const cr = BASE_CR + 0.008 * Math.cos(phase * 0.11) + (cur.x - 0.5) * 0.05;
      const ci = BASE_CI + 0.008 * Math.sin(phase * 0.09) + (cur.y - 0.5) * 0.05;
      if (readout.current) readout.current.textContent = `c = ${cr.toFixed(4)} ${ci < 0 ? '−' : '+'} ${Math.abs(ci).toFixed(4)}i`;
      const zoom = 0.9 * Math.pow(1.6, (Math.sin(phase * 0.05) + 1) / 2);
      const rot = phase * 0.015;
      const cos = Math.cos(rot);
      const sin = Math.sin(rot);
      const aspect = w / h;
      const offX = 0.18; // keep the densest structure to the right of the headline
      const maxIter = 64;
      for (let py = 0; py < h; py++) {
        for (let px = 0; px < w; px++) {
          const u = (((px / w) * 2 - 1) * aspect) / zoom - offX * aspect;
          const v = ((py / h) * 2 - 1) / zoom;
          let x = u * cos - v * sin;
          let y = u * sin + v * cos;
          let i = 0;
          let x2 = x * x;
          let y2 = y * y;
          while (i < maxIter && x2 + y2 < 16) {
            y = 2 * x * y + ci;
            x = x2 - y2 + cr;
            x2 = x * x;
            y2 = y * y;
            i++;
          }
          // Interior stays black; outside, a light screentone floor rises to solid white at the boundary.
          let shade = 0;
          if (i < maxIter) {
            const smooth = i + 1 - Math.log2(Math.log2(x2 + y2) / 2);
            shade = Math.min(1, 0.06 + Math.pow(Math.max(0, smooth) / 26, 0.8));
          }
          const on = shade > BAYER[(py & 7) * 8 + (px & 7)] ? 255 : 0;
          const o = (py * w + px) * 4;
          d[o] = d[o + 1] = d[o + 2] = on;
          d[o + 3] = 255;
        }
      }
      ctx.putImageData(img, 0, 0);
    }

    const loop = (now: number) => {
      raf = requestAnimationFrame(loop);
      if (!visible || document.hidden || now - last < 60) return;
      last = now;
      draw(now - t0);
    };
    if (reduced) draw(0);
    else raf = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      io.disconnect();
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerleave', onLeave);
    };
  }, []);

  return (
    <>
      <div className="hero-canvas" ref={host}>
        <canvas ref={canvasRef} role="img" aria-label="A black-and-white dithered Julia set fractal that reshapes as you move the pointer" />
      </div>
      <div className="reticle" ref={reticle} style={{ opacity: 0 }} aria-hidden="true">
        <span className="box" />
        <span className="readout" ref={readout} />
      </div>
    </>
  );
}

const KATA = 'アイウエオカキクケコサシスセソタチツテトナニヌネノハヒフヘホマミムメモヤユヨラリルレロワヲン';
const rk = () => KATA[(Math.random() * KATA.length) | 0];

/** Text that decodes from random katakana into its final characters, once, on mount. */
export function Scramble({ text, as: Tag = 'span', className }: { text: string; as?: 'span' | 'h1'; className?: string }) {
  const [chars, setChars] = useState(() => (reducedMotion() ? [...text].map((c) => ({ c, s: false })) : [...text].map((c) => ({ c: c === ' ' ? ' ' : rk(), s: c !== ' ' }))));
  useEffect(() => {
    if (reducedMotion()) return;
    const start = performance.now();
    let raf = 0;
    const tick = (now: number) => {
      const el = now - start;
      let busy = false;
      setChars([...text].map((c, i) => {
        const settle = 250 + i * 55;
        if (c === ' ' || el >= settle) return { c, s: false };
        busy = true;
        return { c: rk(), s: true };
      }));
      if (busy) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [text]);
  // Letters are grouped per word so a line only ever breaks between words.
  const words: { c: string; s: boolean; i: number }[][] = [[]];
  [...text].forEach((c, i) => {
    if (c === ' ') words.push([]);
    else words[words.length - 1].push({ ...chars[i], i });
  });
  return (
    <Tag className={className} aria-label={text}>
      {words.map((w, wi) => (
        <Fragment key={wi}>
          {wi > 0 && ' '}
          <span className="word" aria-hidden="true">
            {w.map((ch) => (
              <span key={ch.i} className={`ch${ch.s ? ' scrambling' : ''}`}>{ch.c}</span>
            ))}
          </span>
        </Fragment>
      ))}
    </Tag>
  );
}

const ROWS: [string, string][] = [
  ['From', '0x51d0…77be'],
  ['To', '0x9a3c…e210'],
  ['Amount', '1.25 ETH'],
  ['Sender holds', '4.21 ETH'],
  ['History', '312 payments, linked'],
];

/** A transfer that scrambles into the pattern when the visitor runs it through fractal. */
export function ChainDemo() {
  const [hidden, setHidden] = useState(false);
  const [vals, setVals] = useState(ROWS.map(([, v]) => v));
  const [scrambling, setScrambling] = useState(false);

  const flip = () => {
    const next = !hidden;
    setHidden(next);
    const finals = ROWS.map(([, v]) => (next ? '▚▞▚▞▚▞▚▞' : v));
    if (reducedMotion()) return setVals(finals);
    setScrambling(true);
    const start = performance.now();
    const tick = (now: number) => {
      const t = now - start;
      setVals(finals.map((f, i) => (t > 380 + i * 110 ? f : Array.from({ length: Math.max(6, f.length) }, rk).join(''))));
      if (t < 380 + ROWS.length * 110) requestAnimationFrame(tick);
      else setScrambling(false);
    };
    requestAnimationFrame(tick);
  };

  return (
    <div className="panel tx-card">
      <div className="tx-head">
        <h3 style={{ fontSize: 20 }}>A payment on Robinhood Chain</h3>
        <span className={`state ${hidden ? 'on' : ''}`}>{hidden ? 'chain checks: proof ✓' : 'public transfer'}</span>
      </div>
      <dl aria-live="polite">
        {ROWS.map(([k], i) => (
          <div className="tx-row" key={k}>
            <dt>{k}</dt>
            <dd className={hidden || scrambling ? 'hidden' : ''}>{hidden && !scrambling ? <span aria-label="hidden">{vals[i]}</span> : vals[i]}</dd>
          </div>
        ))}
      </dl>
      <button className="btn wide" style={{ marginTop: 22 }} onClick={flip} disabled={scrambling}>
        {hidden ? 'Show the public version' : 'Send it through fractal'}
      </button>
    </div>
  );
}

/** Anime speed lines radiating from a focal point, drawn once as SVG. */
export function SpeedLines({ fx = 0.82, fy = 0.12, count = 72 }: { fx?: number; fy?: number; count?: number }) {
  const lines: React.JSX.Element[] = [];
  let seed = 7;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  for (let i = 0; i < count; i++) {
    const a = (i / count) * Math.PI * 2 + rnd() * 0.05;
    const inner = 18 + rnd() * 26;
    lines.push(
      <line key={i} x1={fx * 100 + Math.cos(a) * inner} y1={fy * 100 + Math.sin(a) * inner} x2={fx * 100 + Math.cos(a) * 160} y2={fy * 100 + Math.sin(a) * 160} strokeWidth={0.15 + rnd() * 0.5} />,
    );
  }
  return (
    <svg className="speedlines" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true" stroke="#fff" strokeOpacity="0.13">
      {lines}
    </svg>
  );
}
