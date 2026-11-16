/// <reference types="vite/client" />
interface ImportMetaEnv {
  /** Test builds only: a localhost native prover. Never set for a real deployment. */
  readonly VITE_TEST_PROVER_URL?: string;
}
interface ImportMetaEnv {
  /** Public pre-launch build: app pages show a launch screen; no wallet or proving code is bundled. */
  readonly VITE_PREVIEW?: string;
}
