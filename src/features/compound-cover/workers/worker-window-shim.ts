/**
 * Worker-side `window` shim.
 *
 * Some libraries that the render engine pulls in transitively probe for
 * `window` at module load time. In a dedicated worker there is no `window`,
 * which would crash the worker before our message handler can run.
 *
 * This module is intentionally tiny and dependency-free so it evaluates
 * before any other import in the worker (ES modules evaluate dependencies
 * depth-first in declaration order; with this as the first import, its body
 * runs before the heavier render-engine module graph evaluates).
 */

type WorkerGlobalWithWindow = typeof globalThis & { window?: unknown }
const workerGlobal = globalThis as WorkerGlobalWithWindow
if (typeof workerGlobal.window === 'undefined') {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: globalThis,
  })
}

export {}
