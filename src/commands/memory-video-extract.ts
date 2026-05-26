import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { redactSensitiveText } from "../logging/redact.js";

export const DEFAULT_VIDEO_FRAME_CAP = 8;

export type RunFfmpegResult = {
  framePaths: string[];
  audioPath?: string;
};

export type RunFfmpegDeps = {
  tempDir: string;
  frameCap: number;
};

export type ExtractVideoTextDeps = {
  runFfmpeg?: (absPath: string, deps: RunFfmpegDeps) => Promise<RunFfmpegResult>;
  describeImage?: (filePath: string) => Promise<string>;
  transcribe?: (filePath: string) => Promise<string>;
  redact?: (text: string) => string;
  frameCap?: number;
  stagingDir?: string;
};

function redactForExport(text: string): string {
  return redactSensitiveText(text, { mode: "tools" });
}

function resolveInferCliCwd(): string {
  const repoCwd = process.cwd();
  if (existsSync(path.join(repoCwd, "dist", "index.js"))) {
    return repoCwd;
  }
  if (existsSync(path.join("/app", "dist", "index.js"))) {
    return "/app";
  }
  return repoCwd;
}

async function defaultDescribeImage(filePath: string): Promise<string> {
  const result = spawnSync(
    "node",
    [
      "dist/index.js",
      "infer",
      "image",
      "describe",
      "--file",
      filePath,
      "--model",
      "openai-codex/gpt-5.4-mini",
      "--json",
    ],
    {
      cwd: resolveInferCliCwd(),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(
      typeof result.stderr === "string" && result.stderr.trim() !== ""
        ? result.stderr.trim()
        : `infer image describe failed with status ${result.status ?? "unknown"}`,
    );
  }
  const parsed = JSON.parse(result.stdout || "{}") as {
    outputs?: Array<{ text?: unknown }>;
  };
  const outputText = parsed.outputs?.find((output) => typeof output.text === "string")?.text;
  if (typeof outputText !== "string") {
    throw new Error("infer image describe did not return a string text output");
  }
  return outputText;
}

async function defaultTranscribe(filePath: string): Promise<string> {
  const result = spawnSync(
    "node",
    [
      "dist/index.js",
      "infer",
      "audio",
      "transcribe",
      "--file",
      filePath,
      "--model",
      "openai/gpt-4o-transcribe",
      "--json",
    ],
    {
      cwd: resolveInferCliCwd(),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(
      typeof result.stderr === "string" && result.stderr.trim() !== ""
        ? result.stderr.trim()
        : `infer audio transcribe failed with status ${result.status ?? "unknown"}`,
    );
  }
  const parsed = JSON.parse(result.stdout || "{}") as {
    outputs?: Array<{ text?: unknown }>;
  };
  const outputText = parsed.outputs?.find((output) => typeof output.text === "string")?.text;
  if (typeof outputText !== "string") {
    throw new Error("infer audio transcribe did not return a string text output");
  }
  return outputText;
}

function runFfmpegCommand(args: string[]): void {
  const result = spawnSync(
    "nice",
    ["-n", "15", "ionice", "-c3", "ffmpeg", "-threads", "1", ...args],
    {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(
      typeof result.stderr === "string" && result.stderr.trim() !== ""
        ? result.stderr.trim()
        : `ffmpeg failed with status ${result.status ?? "unknown"}`,
    );
  }
}

export async function runFfmpeg(absPath: string, deps: RunFfmpegDeps): Promise<RunFfmpegResult> {
  const framePattern = path.join(deps.tempDir, "frame_%05d.jpg");
  const audioPath = path.join(deps.tempDir, "audio.wav");

  await fs.mkdir(deps.tempDir, { recursive: true });

  runFfmpegCommand([
    "-i",
    absPath,
    "-vf",
    "fps=1/30,scale='min(1280,iw)':-2",
    "-frames:v",
    String(deps.frameCap),
    framePattern,
  ]);

  runFfmpegCommand(["-i", absPath, "-vn", "-ac", "1", "-ar", "16000", audioPath]);

  const framePaths = (await fs.readdir(deps.tempDir))
    .filter((entry) => /^frame_\d+\.jpg$/.test(entry))
    .sort()
    .map((entry) => path.join(deps.tempDir, entry));

  return {
    framePaths,
    audioPath,
  };
}

export async function extractVideoText(
  absPath: string,
  deps: ExtractVideoTextDeps = {},
): Promise<string> {
  const redact = deps.redact ?? redactForExport;
  const describeImage = deps.describeImage ?? defaultDescribeImage;
  const transcribe = deps.transcribe ?? defaultTranscribe;
  const executeFfmpeg = deps.runFfmpeg ?? runFfmpeg;
  const frameCap = deps.frameCap ?? DEFAULT_VIDEO_FRAME_CAP;
  const tempDir = path.join(deps.stagingDir ?? path.dirname(absPath), crypto.randomUUID());

  try {
    const result = await executeFfmpeg(absPath, { tempDir, frameCap });
    const frameDescriptions: string[] = [];
    for (const framePath of result.framePaths.slice(0, frameCap)) {
      frameDescriptions.push(redact(await describeImage(framePath)));
    }

    const parts: string[] = [];
    if (frameDescriptions.length > 0) {
      parts.push(`[video frames: ${frameDescriptions.join(" | ")}]`);
    }
    if (result.audioPath) {
      parts.push(`[video audio: ${redact(await transcribe(result.audioPath))}]`);
    }
    return parts.join("\n");
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}
