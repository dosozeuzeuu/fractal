import type React from 'react';
/** The fractal mark: a Sierpinski triangle drawn as a 16×16 pixel grid (cell on when x & y == 0). */
export function LogoMark({ size = 26 }: { size?: number }) {
  const cells: React.JSX.Element[] = [];
  for (let y = 0; y < 16; y++) {
    for (let x = 0; x <= y; x++) {
      if ((x & (y - x)) === 0) cells.push(<rect key={`${x}-${y}`} x={x + (15 - y) / 2} y={y} width={1} height={1} />);
    }
  }
  return (
    <svg className="brand-mark" width={size} height={size} viewBox="0 0 16 16" aria-hidden="true" fill="#fff" shapeRendering="crispEdges">
      {cells}
    </svg>
  );
}

export function Brand() {
  return (
    <a className="brand" href="/" aria-label="fractal home">
      <LogoMark />
      <span className="brand-word">fractal</span>
    </a>
  );
}
