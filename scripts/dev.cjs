const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const esbuild = require("esbuild");
const root = path.resolve(__dirname, "..");
const allowed = new Set([
  "index.html",
  "style.css",
  "app.js",
  "cloud-config.js",
  "bridge.js",
  "icons.svg",
  "together.js",
  "catalog.js",
  "youtube-player.js",
  "journey.js",
]);
const mime = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "text/javascript",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".mjs": "text/javascript",
  ".wasm": "application/wasm",
};
const pdfFiles =
  /^(?:build\/(?:pdf|pdf\.worker)\.mjs|(?:cmaps|standard_fonts|wasm)\/[A-Za-z0-9_.-]+)$/;
(async () => {
  const context = await esbuild.context({
    entryPoints: [path.join(root, "browser-bridge.js")],
    bundle: true,
    platform: "browser",
    outfile: path.join(root, "bridge.js"),
    logLevel: "warning",
  });
  await context.watch();
  await context.rebuild();
  const server = http.createServer((req, res) => {
    const relative =
      decodeURIComponent(new URL(req.url, "http://localhost").pathname).replace(
        /^\//,
        "",
      ) || "index.html";
    const pdf = relative.startsWith("pdfjs/") ? relative.slice(6) : null;
    const isPdfAsset = pdf !== null && pdfFiles.test(pdf);
    const full = isPdfAsset
      ? path.join(root, "node_modules", "pdfjs-dist", pdf)
      : path.resolve(root, relative);
    if (
      !full.startsWith(root + path.sep) ||
      (!allowed.has(relative) && !relative.startsWith("assets/") && !isPdfAsset)
    ) {
      res.writeHead(404);
      return res.end("No encontrado");
    }
    fs.readFile(full, (error, bytes) => {
      res.writeHead(error ? 404 : 200, {
        "Content-Type": mime[path.extname(full)] || "application/octet-stream",
        "Cache-Control": "no-store",
      });
      res.end(error ? "No encontrado" : bytes);
    });
  });
  server.listen(4173, "127.0.0.1", () =>
    console.log("NOSOTROS local: http://127.0.0.1:4173"),
  );
  process.on("SIGINT", async () => {
    await context.dispose();
    server.close();
    process.exit();
  });
})();
