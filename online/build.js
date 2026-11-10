const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const serverPath = path.join(root, "server.js");
const adapterPath = path.join(__dirname, "adapter.js");
const outDir = path.join(__dirname, "dist");

const server = fs.readFileSync(serverPath, "utf8");
const cut = server.indexOf('if (typeof module !== "undefined") module.exports = GDCore;');
if (cut < 0) throw new Error("GDCore non trovato in server.js");
const core = server.slice(0, cut);
const adapter = fs.readFileSync(adapterPath, "utf8");
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, "worker.js"), core + "\n" + adapter + "\n");

const manifest = {
  entrypoint: "worker.js",
  compatibilityDate: new Date().toISOString().slice(0, 10),
  modules: [{ name: "worker.js", type: "esm", path: "./worker.js" }]
};
fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
console.log("Worker generato:", path.join(outDir, "worker.js"));
console.log("Manifest:", path.join(outDir, "manifest.json"));
