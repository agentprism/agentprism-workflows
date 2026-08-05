/**
 * Type-check fixture simulating a published-package consumer.
 *
 * Imports the engine's PUBLIC declarations (`dist`) under the
 * repository's non-DOM lib (the tsconfig.base lib `ES2022` +
 * `ESNext.Disposable` — the latter is required by the public
 * `[Symbol.dispose]` methods, same as quickjs-wasi's own) with
 * `skipLibCheck: false` and no ambient `@types`. The public type graph
 * must be fully self-contained: every type the API references must be
 * declared inside the package itself.
 *
 * Regression (review): `ReplVmOptions.wasm`, `WorkspaceOptions.wasm` and
 * `WorkspaceRegistryOptions.wasm` referenced `BufferSource` /
 * `WebAssembly.Module`, whose only declarations lived in an unpublished
 * source ambient (`src/wasm-ambient.d.ts`, never emitted — the published
 * package ships `dist` only). This configuration failed with seven
 * missing-type errors across `dist/vm.d.ts` and `dist/workspace.d.ts`.
 *
 * Note: this file is intentionally NOT part of the package's own
 * typecheck (the package tsconfig covers src only); it is compiled by
 * `test/public-types.test.ts` against the built `dist` declarations.
 */
import {
  ReplVm,
  Workspace,
  WorkspaceRegistry,
  loadShippedWasm,
  DrainJobError,
  type ReplVmOptions,
  type ReplEvalOptions,
  type ReplEvalOutcome,
  type WorkspaceOptions,
  type WorkspaceRegistryOptions,
  type EvalErrorInfo,
  type WasmInput,
  type WasmModule,
} from '../../../dist/index.js';

async function exercise(): Promise<void> {
  // The shipped binary compiles to the self-contained `WasmModule` type
  // and round-trips into every option position that used to name the
  // (undeclared) `WebAssembly.Module` / `BufferSource` globals.
  const module: WasmModule = await loadShippedWasm();
  const vmOptions: ReplVmOptions = { wasm: module, memoryLimit: 1024 };
  const vm = await ReplVm.create(vmOptions);
  const evalOptions: ReplEvalOptions = {
    filename: 'consumer.js',
    interruptHandler: () => false,
  };
  const outcome: ReplEvalOutcome = await vm.evalCode('1 + 1', evalOptions);
  if (outcome.kind === 'error') {
    const info: EvalErrorInfo = outcome.error;
    info.interrupted satisfies boolean;
    info.outOfMemory satisfies boolean;
  }
  const wsOptions: WorkspaceOptions = { wasm: module };
  const ws = await Workspace.create('/tmp/project', wsOptions);
  const registryOptions: WorkspaceRegistryOptions = { wasm: module, memoryLimit: 4096 };
  const registry = new WorkspaceRegistry(registryOptions);
  const got: Workspace = await registry.get('/tmp/project', wsOptions);
  const bytes = new Uint8Array([0, 97, 115, 109]);
  const asBytes: WasmInput = bytes;
  const asArrayBuffer: WasmInput = new ArrayBuffer(4);
  let maybeDrainError: DrainJobError | undefined;
  if (maybeDrainError) {
    maybeDrainError.info satisfies EvalErrorInfo;
  }
  ws.dispose();
  got.dispose();
  registry.disposeAll();
  vm.dispose();
}

// Negative cases — the public boundary must reject accidental values.
// Review regression: `WasmModule` was an empty interface, so `{ wasm: 42 }`
// type-checked (every non-null value satisfies an empty interface) and
// failed only at runtime. The branded opaque module type must make all of
// these compile-time errors; the `@ts-expect-error` directives fail the
// fixture build if any line stops erroring.

// @ts-expect-error a bare number is not a wasm input
const badNumber: WasmInput = 42;

// @ts-expect-error a bare object is not a compiled module (opaque brand)
const badModule: WasmModule = {};

// @ts-expect-error a string is not a wasm input
const badString: WasmInput = 'quickjs.wasm';

// @ts-expect-error `{ wasm: 42 }` must not type-check as VM options
const badVmOptions: ReplVmOptions = { wasm: 42 };

// @ts-expect-error `{ wasm: 42 }` must not type-check as workspace options
const badWsOptions: WorkspaceOptions = { wasm: 42 };

// @ts-expect-error a boolean is not a wasm input
const badBoolean: WasmInput = true;
