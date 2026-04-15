// Re-export from the implementation module. The indirection exists so that
// vitest's dynamic `import("../store?t=" + Math.random())` cache-bust — which
// under Vite 8 + oxc strips the `.ts` extension hint and parses the module
// as plain JS — can still load this file (only `export *` syntax, valid as
// both TS and JS) while the real implementation keeps its TypeScript types.
export * from "./store.impl";
