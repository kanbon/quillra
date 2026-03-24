import sharp from "sharp";

const maxEdge = 1200;
const quality = 80;

export async function processUploadToWebP(input: Buffer): Promise<Buffer> {
  return sharp(input)
    .rotate()
    .resize(maxEdge, maxEdge, { fit: "inside", withoutEnlargement: true })
    .webp({ quality })
    .toBuffer();
}
