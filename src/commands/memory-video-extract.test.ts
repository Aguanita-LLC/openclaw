import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { extractVideoText } from "./memory-video-extract.js";

describe("extractVideoText", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-memory-video-extract-"));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("runs ffmpeg, describes sparse frames up to the cap, transcribes audio, redacts, and cleans temp output", async () => {
    const inputPath = path.join(tempDir, "clip.mp4");
    await fs.writeFile(inputPath, "fake video bytes", "utf8");

    let ffmpegDir = "";
    let frame1 = "";
    let frame2 = "";
    let frame3 = "";
    let audioPath = "";

    const runFfmpeg = vi.fn(async (_absPath: string, deps: { tempDir: string }) => {
      ffmpegDir = deps.tempDir;
      frame1 = path.join(ffmpegDir, "frame_00001.jpg");
      frame2 = path.join(ffmpegDir, "frame_00002.jpg");
      frame3 = path.join(ffmpegDir, "frame_00003.jpg");
      audioPath = path.join(ffmpegDir, "audio.wav");
      await fs.mkdir(ffmpegDir, { recursive: true });
      await fs.writeFile(frame1, "frame-1", "utf8");
      await fs.writeFile(frame2, "frame-2", "utf8");
      await fs.writeFile(frame3, "frame-3", "utf8");
      await fs.writeFile(audioPath, "audio", "utf8");
      return {
        framePaths: [frame1, frame2, frame3],
        audioPath,
      };
    });
    const describeImage = vi
      .fn<Parameters<(filePath: string) => Promise<string>>, Promise<string>>()
      .mockImplementation(async (filePath) => {
        if (filePath === frame1) {
          return "first frame";
        }
        if (filePath === frame2) {
          return "second frame sk-openai-1234567890ABCDEFGH";
        }
        return "third frame";
      });
    const transcribe = vi.fn(async (_filePath: string) => "audio says sk-secret-token-1234567890");

    const result = await extractVideoText(inputPath, {
      runFfmpeg,
      describeImage,
      transcribe,
      frameCap: 2,
      stagingDir: tempDir,
    });

    expect(runFfmpeg).toHaveBeenCalledTimes(1);
    expect(describeImage).toHaveBeenCalledTimes(2);
    expect(describeImage).toHaveBeenNthCalledWith(1, frame1);
    expect(describeImage).toHaveBeenNthCalledWith(2, frame2);
    expect(transcribe).toHaveBeenCalledTimes(1);
    expect(transcribe).toHaveBeenCalledWith(audioPath);
    expect(result).toContain("[video frames: first frame | second frame ");
    expect(result).toContain("[video audio: audio says ");
    expect(result).not.toContain("sk-openai-1234567890ABCDEFGH");
    expect(result).not.toContain("sk-secret-token-1234567890");
    expect(ffmpegDir).not.toBe("");
    await expect(fs.stat(ffmpegDir)).rejects.toThrow();
  });

  it("extracts at least one frame from a short silent clip and omits audio text", async () => {
    const inputPath = path.join(tempDir, "short-silent.mp4");
    const createClip = spawnSync(
      "ffmpeg",
      [
        "-y",
        "-f",
        "lavfi",
        "-i",
        "color=c=black:s=320x240:d=2",
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        inputPath,
      ],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    expect(createClip.status).toBe(0);

    const describeImage = vi.fn(async (_filePath: string) => "dark frame");
    const transcribe = vi.fn(async (_filePath: string) => "should not run");

    const result = await extractVideoText(inputPath, {
      describeImage,
      transcribe,
      frameCap: 4,
      stagingDir: tempDir,
    });

    expect(describeImage).toHaveBeenCalledTimes(1);
    expect(transcribe).not.toHaveBeenCalled();
    expect(result).toContain("[video frames: dark frame]");
    expect(result).not.toContain("[video audio:");
  });

  it("keeps successful frame descriptions when one frame caption fails", async () => {
    const inputPath = path.join(tempDir, "partial-frames.mp4");
    await fs.writeFile(inputPath, "fake video bytes", "utf8");

    let frame1 = "";
    let frame2 = "";
    let frame3 = "";

    const runFfmpeg = vi.fn(async (_absPath: string, deps: { tempDir: string }) => {
      frame1 = path.join(deps.tempDir, "frame_00001.jpg");
      frame2 = path.join(deps.tempDir, "frame_00002.jpg");
      frame3 = path.join(deps.tempDir, "frame_00003.jpg");
      await fs.mkdir(deps.tempDir, { recursive: true });
      await fs.writeFile(frame1, "frame-1", "utf8");
      await fs.writeFile(frame2, "frame-2", "utf8");
      await fs.writeFile(frame3, "frame-3", "utf8");
      return {
        framePaths: [frame1, frame2, frame3],
      };
    });
    const describeImage = vi.fn(async (filePath: string) => {
      if (filePath === frame1) {
        return "first frame";
      }
      if (filePath === frame2) {
        throw new Error("caption failed");
      }
      return "third frame";
    });

    const result = await extractVideoText(inputPath, {
      runFfmpeg,
      describeImage,
      frameCap: 3,
      stagingDir: tempDir,
    });

    expect(result).toContain("[video frames: first frame | third frame]");
    expect(result).not.toContain("[video audio:");
  });

  it("returns frame descriptions when audio transcription fails", async () => {
    const inputPath = path.join(tempDir, "audio-failure.mp4");
    await fs.writeFile(inputPath, "fake video bytes", "utf8");

    let frame1 = "";
    let audioPath = "";

    const runFfmpeg = vi.fn(async (_absPath: string, deps: { tempDir: string }) => {
      frame1 = path.join(deps.tempDir, "frame_00001.jpg");
      audioPath = path.join(deps.tempDir, "audio.wav");
      await fs.mkdir(deps.tempDir, { recursive: true });
      await fs.writeFile(frame1, "frame-1", "utf8");
      await fs.writeFile(audioPath, "audio", "utf8");
      return {
        framePaths: [frame1],
        audioPath,
      };
    });
    const describeImage = vi.fn(async (_filePath: string) => "first frame");
    const transcribe = vi.fn(async (_filePath: string) => {
      throw new Error("transcribe failed");
    });

    const result = await extractVideoText(inputPath, {
      runFfmpeg,
      describeImage,
      transcribe,
      frameCap: 1,
      stagingDir: tempDir,
    });

    expect(result).toContain("[video frames: first frame]");
    expect(result).not.toContain("[video audio:");
  });
});
