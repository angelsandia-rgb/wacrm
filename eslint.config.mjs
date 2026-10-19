import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    rules: {
      // Turned on as an error by eslint-plugin-react-hooks 7.1. It flags
      // ~80 existing effects (fetch-on-mount, form reset on prop change,
      // localStorage hydration) that work today; rewriting them is a
      // behavioural refactor to do area by area, not in a lint bump.
      // Kept visible as a warning so new code can avoid the pattern.
      "react-hooks/set-state-in-effect": "warn",
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Separate Git worktrees have their own lint configuration.
    ".claude/worktrees/**",
    // Vendored minified opus-recorder encoder worker (served statically).
    "public/opus/**",
  ]),
]);

export default eslintConfig;
