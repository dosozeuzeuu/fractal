import manifest from '../crs-manifest.json';

async function sha256(b: Uint8Array): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', b as BufferSource);
  return Array.from(new Uint8Array(d), (x) => x.toString(16).padStart(2, '0')).join('');
}

let loaded: Promise<{ g1: Uint8Array; g2: Uint8Array }> | undefined;

/**
 * Loads the proving CRS from this app's own origin and checks it against SHA-256 hashes pinned
 * in the bundle. The prover is handed these points directly, so bb.js never contacts Aztec's
 * CDN (which would see the user's IP each time they prepare a transaction).
 */
export function loadCrs(): Promise<{ g1: Uint8Array; g2: Uint8Array }> {
  loaded ??= (async () => {
    const [g1, g2] = await Promise.all(
      ['/crs/bn254_g1.dat', '/crs/bn254_g2.dat'].map(async (u) => {
        const r = await fetch(u);
        if (!r.ok) throw new Error(`Could not load ${u}.`);
        return new Uint8Array(await r.arrayBuffer());
      }),
    );
    if ((await sha256(g1)) !== manifest.g1Sha256 || (await sha256(g2)) !== manifest.g2Sha256) {
      throw new Error('The proving parameters failed their integrity check. Reload the page.');
    }
    return { g1, g2 };
  })();
  loaded.catch(() => (loaded = undefined));
  return loaded;
}
