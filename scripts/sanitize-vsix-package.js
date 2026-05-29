const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const vsix = process.argv[2];
if (!vsix) {
  throw new Error("Usage: node scripts/sanitize-vsix-package.js <file.vsix>");
}

const absoluteVsix = path.resolve(vsix);
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "notebook-mcp-vsix-"));

try {
  execFileSync("unzip", ["-q", absoluteVsix, "-d", tempDir]);
  const packagePath = path.join(tempDir, "extension", "package.json");
  const manifest = JSON.parse(fs.readFileSync(packagePath, "utf8"));
  delete manifest.scripts;
  delete manifest.dependencies;
  delete manifest.devDependencies;
  fs.writeFileSync(packagePath, `${JSON.stringify(manifest, null, 2)}\n`);

  fs.rmSync(absoluteVsix, { force: true });
  execFileSync("zip", ["-qr", absoluteVsix, "."], { cwd: tempDir });
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}
