/**
 * Minimal ambient types for the WebAssembly surface this package touches.
 *
 * The repo's base tsconfig lib is `ES2022 + ESNext.Disposable` (no DOM), so
 * TypeScript provides neither the global `WebAssembly` namespace nor the
 * `BufferSource` type here. `quickjs-wasi`'s own declarations reference
 * both, but dependency declarations are skipped (`skipLibCheck`), while
 * this package's checked code uses them directly — so this file declares
 * just the pieces we use instead of pulling the entire DOM lib in. At
 * runtime the `WebAssembly` global is provided by Node.
 */

type BufferSource = ArrayBufferView | ArrayBuffer;

declare namespace WebAssembly {
  interface Module {}
  function compile(bytes: BufferSource): Promise<Module>;
}
