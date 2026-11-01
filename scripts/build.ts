export {};
const result = await Bun.build({
  entrypoints: ["./src/main.ts"],
  outdir: "./",
  naming: "main.js",
  target: "browser",
  format: "cjs",
  external: ["obsidian", "electron", "@codemirror/*", "@lezer/*"],
  minify: false,
  sourcemap: "external",
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}
console.log("built main.js");
