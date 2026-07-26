import { describe, expect, it } from "vitest";
import { PROJECT_IMAGE_MAX_INPUT_PIXELS } from "../lib/request-limits.js";
import { processUploadToWebP } from "./image.js";

describe("uploaded image processing", () => {
  it("rejects compressed inputs whose declared dimensions exceed the pixel ceiling", async () => {
    const width = 6_000;
    const height = Math.floor(PROJECT_IMAGE_MAX_INPUT_PIXELS / width) + 1;
    const svg = Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"></svg>`,
    );

    await expect(processUploadToWebP(svg, PROJECT_IMAGE_MAX_INPUT_PIXELS)).rejects.toThrow(
      /pixel limit/i,
    );
  });
});
