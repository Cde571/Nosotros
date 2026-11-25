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
]);
const mime = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "text/javascript",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".png": "image/png",
  ".woff2": "font/woff2",
};
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
    const full = path.resolve(root, relative);
    if (
      !full.startsWith(root + path.sep) ||
      (!allowed.has(relative) && !relative.startsWith("assets/"))
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
