#!/usr/bin/env node
import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { platform } from "node:os";
import { join } from "node:path";

const URL =
  "https://habr.com/ru/companies/timeweb/articles/985158/?utm_source=telegram_habr&utm_medium=social&utm_campaign=28319121";

const DIST_MANIFEST = join(process.cwd(), "dist", "manifest.json");

const vite = spawn("npm", ["run", "build", "--", "--watch"], {
  stdio: "inherit",
  shell: process.platform === "win32"
});

let chrome;

async function waitForDist() {
  while (true) {
    try {
      await access(DIST_MANIFEST, constants.F_OK);
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 300));
    }
  }
}

function findChromeExecutable() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;

  const candidates = [];
  const plt = platform();
  if (plt === "darwin") {
    candidates.push(
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Chromium.app/Contents/MacOS/Chromium"
    );
  } else if (plt === "win32") {
    candidates.push(
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe"
    );
  } else {
    candidates.push("google-chrome", "chromium", "chromium-browser", "chrome");
  }

  return candidates[0];
}

async function launchChrome() {
  await waitForDist();
  const chromePath = findChromeExecutable();

  chrome = spawn(
    chromePath,
    [
      `--load-extension=${join(process.cwd(), "dist")}`,
      "--new-window",
      URL
    ],
    {
      stdio: "inherit",
      shell: process.platform !== "win32" && !chromePath.includes("/")
    }
  );

  chrome.on("exit", (code) => {
    if (code && code !== 0) {
      console.error(`Chrome exited with code ${code}`);
    }
  });
}

launchChrome().catch((err) => {
  console.error("Failed to launch Chrome:", err);
});

function cleanup() {
  if (chrome && !chrome.killed) chrome.kill("SIGTERM");
  if (!vite.killed) vite.kill("SIGTERM");
}

process.on("SIGINT", () => {
  cleanup();
  process.exit(0);
});
process.on("SIGTERM", () => {
  cleanup();
  process.exit(0);
});
