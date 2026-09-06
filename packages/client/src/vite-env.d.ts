// vite-env.d.ts — the one build-time setting the shell reads, typed so a typo is a compile error
// rather than an undefined that silently falls back to the default URL.
interface ImportMetaEnv {
  readonly VITE_WEFT_WS?: string;
}
