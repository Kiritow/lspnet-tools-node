import { defineConfig } from "tsup";

export default defineConfig({
    entryPoints: ["src/index.ts"],
    // format: ["cjs", "esm"],
    format: ["cjs"],
    platform: "node",
    dts: true,
    outDir: "dist",
    clean: true,
    minify: true,
    minifyIdentifiers: true,
    minifyWhitespace: true,
    minifySyntax: true,
});
