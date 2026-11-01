import * as esbuild from "esbuild";

const watch = process.argv.includes("--watch");

/** Bundle the browser client to public/app.js (the node server serves it statically). */
const ctx = await esbuild.context({
  entryPoints: ["src/client/main.ts"],
  outfile: "public/app.js",
  bundle: true,
  format: "esm",
  target: "es2022",
  sourcemap: true,
  logLevel: "info",
});

if (watch) {
  await ctx.watch();
  console.log("esbuild watching…");
} else {
  await ctx.rebuild();
  await ctx.dispose();
}
