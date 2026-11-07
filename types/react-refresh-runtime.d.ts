// What the live code editor uses of `react-refresh/runtime` (react-refresh 0.18, a package without declarations): the registry
// of component families, the hook that renderers register with, and the refresh that re-renders the families an edit changed.
declare module 'react-refresh/runtime' {
  /** The record of what an edit changed, as `performReactRefresh` returns it (null when there was nothing to do). */
  export interface RefreshUpdate {
    readonly updatedFamilies: ReadonlySet<unknown>;
    readonly staleFamilies: ReadonlySet<unknown>;
  }
  /** Installs `__REACT_DEVTOOLS_GLOBAL_HOOK__` on `globalObject`, or wraps the one there, so the next renderer to load registers with it. */
  export function injectIntoGlobalHook(globalObject: object): void;
  /** Records `type` as the current implementation of the component family `id`. Applied by the next `performReactRefresh`. */
  export function register(type: unknown, id: string): void;
  /** The `$RefreshSig$` of a module: called once as `_s()` in a component's body and once as `_s(Component, signature)` after it. */
  export function createSignatureFunctionForTransform(): <Type>(type?: Type, key?: string, forceReset?: boolean, getCustomHooks?: () => unknown[]) => Type | undefined;
  /** Re-renders the mounted components of the families that `register` changed since the last call, keeping state where hooks match. */
  export function performReactRefresh(): RefreshUpdate | null;
  export function isLikelyComponentType(type: unknown): boolean;
  export function hasUnrecoverableErrors(): boolean;
}
