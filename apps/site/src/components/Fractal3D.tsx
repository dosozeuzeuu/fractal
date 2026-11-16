import { useEffect, useRef } from 'react';
import * as THREE from 'three';

/**
 * A Sierpinski tetrahedron, cel-shaded with an ink outline like an anime render. It flies together
 * from scattered pieces when `start` turns true, tilts toward the pointer and drifts apart as the hero
 * scrolls away. One piece is lime green: a note hiding in the pattern, which hops to a new place every few
 * seconds. Static for reduced motion; paused off-screen; renders nothing without WebGL.
 */
export default function Fractal3D({ start }: { start: boolean }) {
  const host = useRef<HTMLDivElement>(null);
  const startRef = useRef(start);
  startRef.current = start;

  useEffect(() => {
    const el = host.current!;
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const small = window.innerWidth < 760;

    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'low-power' });
    } catch {
      el.dataset.fallback = 'true';
      return;
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setClearColor(0x000000, 0);
    el.appendChild(renderer.domElement);
    renderer.domElement.setAttribute('aria-hidden', 'true');

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(32, 1, 0.1, 100);
    camera.position.set(0, 0.15, 7.2);

    // Corners of a regular tetrahedron, matching three's TetrahedronGeometry orientation.
    const R = 1.75;
    const corners = [new THREE.Vector3(1, 1, 1), new THREE.Vector3(-1, -1, 1), new THREE.Vector3(-1, 1, -1), new THREE.Vector3(1, -1, -1)].map((v) =>
      v.normalize().multiplyScalar(R),
    );
    const level = small ? 3 : 4;
    const centers: THREE.Vector3[] = [];
    const subdivide = (c: THREE.Vector3, s: number, l: number) => {
      if (l === 0) return void centers.push(c);
      for (const k of corners) subdivide(c.clone().addScaledVector(k, s / 2), s / 2, l - 1);
    };
    subdivide(new THREE.Vector3(), 1, level);
    const leaf = 1 / 2 ** level;
    const N = centers.length;

    const geom = new THREE.TetrahedronGeometry(R * leaf * 0.94);
    const tones = new THREE.DataTexture(new Uint8Array([40, 120, 205, 255]), 4, 1, THREE.RedFormat);
    tones.minFilter = tones.magFilter = THREE.NearestFilter;
    tones.generateMipmaps = false;
    tones.needsUpdate = true;
    const body = new THREE.InstancedMesh(geom, new THREE.MeshToonMaterial({ color: 0xffffff, gradientMap: tones }), N);
    const ink = new THREE.InstancedMesh(geom, new THREE.MeshBasicMaterial({ color: 0x000000, side: THREE.BackSide }), N);
    body.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    ink.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    const group = new THREE.Group();
    group.add(ink, body);
    group.rotation.set(0.55, -1.0, 0.08);
    scene.add(group);

    const white = new THREE.Color(0xffffff);
    const accent = new THREE.Color(0xa6ff00);
    let noteIndex = Math.floor(N * 0.61);
    for (let i = 0; i < N; i++) body.setColorAt(i, i === noteIndex ? accent : white);
    body.instanceColor!.needsUpdate = true;

    scene.add(new THREE.AmbientLight(0xffffff, 0.55));
    const key = new THREE.DirectionalLight(0xffffff, 2.4);
    key.position.set(-3, 4, 5);
    scene.add(key);
    const rim = new THREE.DirectionalLight(0xffffff, 0.8);
    rim.position.set(4, -2, -3);
    scene.add(rim);

    // Scattered starting state for the fly-in.
    let seed = 3;
    const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    const scatter = centers.map((c) =>
      c.clone().normalize().multiplyScalar(3 + rnd() * 4).add(new THREE.Vector3((rnd() - 0.5) * 3, (rnd() - 0.5) * 3, (rnd() - 0.5) * 3)),
    );
    const spin = centers.map(() => new THREE.Quaternion().setFromEuler(new THREE.Euler(rnd() * 6.3, rnd() * 6.3, rnd() * 6.3)));
    const drift = centers.map((c) => c.clone().normalize());
    const idQ = new THREE.Quaternion();

    const m = new THREE.Matrix4();
    const p = new THREE.Vector3();
    const q = new THREE.Quaternion();
    const one = new THREE.Vector3(1, 1, 1);
    const fat = new THREE.Vector3(1.14, 1.14, 1.14);
    const big = new THREE.Vector3(1.4, 1.4, 1.4);
    const bigFat = new THREE.Vector3(1.58, 1.58, 1.58);
    const place = (assembled: number, spread: number) => {
      const a = 1 - assembled;
      for (let i = 0; i < N; i++) {
        const hidden = i === noteIndex;
        // The coloured note sits a little proud of the pattern so it reads at any size.
        p.copy(centers[i]).multiplyScalar(1 + spread).addScaledVector(drift[i], spread * 0.6 + (hidden ? 0.14 * assembled : 0));
        p.lerp(scatter[i], a);
        q.copy(idQ).slerp(spin[i], a);
        m.compose(p, q, hidden ? big : one);
        body.setMatrixAt(i, m);
        m.compose(p, q, hidden ? bigFat : fat);
        ink.setMatrixAt(i, m);
      }
      body.instanceMatrix.needsUpdate = true;
      ink.instanceMatrix.needsUpdate = true;
    };

    const resize = () => {
      const w = el.clientWidth;
      const h = el.clientHeight;
      if (!w || !h) return;
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      // Keep the whole shape in frame on tall, narrow screens.
      const tall = w / h < 0.8;
      camera.position.z = tall ? 9.4 : 8;
      // On wide screens, sit the shape right of centre, clear of the headline.
      group.position.x = tall ? 0 : 0.45;
      camera.updateProjectionMatrix();
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(el);

    let visible = true;
    const io = new IntersectionObserver(([e]) => (visible = e.isIntersecting));
    io.observe(el);

    const pointer = { x: 0, y: 0 };
    const tilt = { x: 0, y: 0 };
    const onMove = (e: PointerEvent) => {
      pointer.x = (e.clientX / window.innerWidth) * 2 - 1;
      pointer.y = (e.clientY / window.innerHeight) * 2 - 1;
    };
    window.addEventListener('pointermove', onMove, { passive: true });

    if (reduced) {
      place(1, 0);
      renderer.render(scene, camera);
      return () => {
        ro.disconnect();
        io.disconnect();
        window.removeEventListener('pointermove', onMove);
        renderer.dispose();
        geom.dispose();
        tones.dispose();
        el.removeChild(renderer.domElement);
      };
    }

    let raf = 0;
    let assembleStart = -1;
    let lastHop = 0;
    let spread = 0;
    const clock = performance.now();
    const ease = (t: number) => (t >= 1 ? 1 : 1 - Math.pow(2, -10 * t));
    place(0, 0);

    const loop = (now: number) => {
      raf = requestAnimationFrame(loop);
      if (!visible || document.hidden) return;
      if (startRef.current && assembleStart < 0) assembleStart = now;
      const assembled = assembleStart < 0 ? 0 : ease((now - assembleStart) / 1700);

      const hero = el.parentElement!.getBoundingClientRect();
      const scrolled = Math.min(1, Math.max(0, -hero.top / Math.max(1, hero.height)));
      spread += (scrolled * 0.9 - spread) * 0.08;

      tilt.x += (pointer.y * 0.22 - tilt.x) * 0.05;
      tilt.y += (pointer.x * 0.35 - tilt.y) * 0.05;
      const t = (now - clock) / 1000;
      group.rotation.set(0.55 + tilt.x, -1.0 + t * 0.12 + tilt.y, 0.08);

      if (assembled > 0.98 && now - lastHop > 2600) {
        lastHop = now;
        body.setColorAt(noteIndex, white);
        noteIndex = (noteIndex + 1 + Math.floor(rnd() * (N - 1))) % N;
        body.setColorAt(noteIndex, accent);
        body.instanceColor!.needsUpdate = true;
      }
      place(assembled, spread);
      renderer.render(scene, camera);
    };
    raf = requestAnimationFrame(loop);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      io.disconnect();
      window.removeEventListener('pointermove', onMove);
      renderer.dispose();
      geom.dispose();
      tones.dispose();
      (body.material as THREE.Material).dispose();
      (ink.material as THREE.Material).dispose();
      el.removeChild(renderer.domElement);
    };
  }, []);

  return <div className="hero-3d" ref={host} />;
}
