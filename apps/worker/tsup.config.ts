import { defineConfig } from "tsup";

// Bundle workspace packages (they export TypeScript source) into a single
// deployable ESM entrypoint; third-party dependencies stay external.
export default defineConfig({
  entry: ["src/main.ts", "src/migrate.ts"],
  format: ["esm"],
  platform: "node",
  target: "node22",
  outDir: "dist",
  clean: true,
  sourcemap: true,
  splitting: false,
  noExternal: [/^@zeptly-social\//],
});
