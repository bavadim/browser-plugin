import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";
import archiver from "archiver";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const rootDir = path.resolve(__dirname, "..");
const distDir = path.join(rootDir, "dist");
const outDir = path.join(rootDir, "artifacts");

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function archiveFolder(srcDir, outFile) {
  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(outFile);
    const archive = archiver("zip", { zlib: { level: 9 } });

    output.on("close", resolve);
    output.on("error", reject);
    archive.on("warning", (err) => {
      if (err.code === "ENOENT") {
        return;
      }
      reject(err);
    });
    archive.on("error", reject);

    archive.pipe(output);
    archive.directory(srcDir, false);
    archive.finalize();
  });
}

async function main() {
  execSync("npm run build", { stdio: "inherit" });

  if (!fs.existsSync(distDir)) {
    throw new Error("dist/ not found. Build failed.");
  }

  ensureDir(outDir);

  const chromeZip = path.join(outDir, "browseragentkit-extension-chrome.zip");
  const firefoxXpi = path.join(outDir, "browseragentkit-extension-firefox.xpi");

  await archiveFolder(distDir, chromeZip);
  await archiveFolder(distDir, firefoxXpi);

  const chromeSize = fs.statSync(chromeZip).size;
  const firefoxSize = fs.statSync(firefoxXpi).size;

  console.log("Created archives:");
  console.log(`- ${path.relative(rootDir, chromeZip)} (${chromeSize} bytes)`);
  console.log(`- ${path.relative(rootDir, firefoxXpi)} (${firefoxSize} bytes)`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
