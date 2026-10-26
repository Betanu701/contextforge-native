import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { stripTypeScriptTypes } from "node:module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const distRoot = path.join(root, "dist");
const distSrc = path.join(distRoot, "src");
fs.mkdirSync(distSrc, { recursive: true });

function compileFile(relPath) {
  const srcPath = path.join(root, relPath);
  const outPath = path.join(distRoot, relPath.replace(/\.ts$/, ".js"));
  const code = fs.readFileSync(srcPath, "utf8");
  let js = stripTypeScriptTypes(code, { mode: "transform", sourceUrl: relPath });
  js = js.replace(/(from\s+["']\.?\.\/[^"']+)\.ts(["'])/g, "$1.js$2");
  fs.writeFileSync(outPath, js, "utf8");
}

compileFile("index.ts");
for (const f of fs.readdirSync(path.join(root, "src"))) {
  if (f.endsWith(".ts")) compileFile(path.join("src", f));
}
console.log("Built dist/index.js and dist/src/*.js successfully.");
