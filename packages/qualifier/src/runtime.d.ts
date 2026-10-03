// Timers and AbortController exist in every runtime Kelpie targets (workerd and Node), but this
// package compiles without DOM or Node typings to stay runtime-agnostic, so it declares what it uses.
declare function setTimeout(callback: () => void, ms: number): unknown;
declare function clearTimeout(id: unknown): void;
interface AbortSignal {
  readonly aborted: boolean;
}
declare class AbortController {
  readonly signal: AbortSignal;
  abort(reason?: unknown): void;
}
