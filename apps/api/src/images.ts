import sharp from "sharp";
import { fail } from "./service.js";
export const MAX_BYTES = 10 * 1024 * 1024;
export async function normalizeImage(buffer: Buffer, outputLimit = MAX_BYTES) {
  if (buffer.length > MAX_BYTES)
    fail(413, "INPUT_TOO_LARGE", "原始图片超过10MiB");
  try {
    const source = sharp(buffer, {
      limitInputPixels: 20_000_000,
      animated: true,
    });
    const meta = await source.metadata();
    if (!["png", "jpeg", "webp"].includes(meta.format || ""))
      fail(415, "UNSUPPORTED_IMAGE", "只接受PNG、JPEG或静态WebP图片");
    if ((meta.pages || 1) > 1)
      fail(415, "ANIMATED_IMAGE", "暂不支持动画或多帧图片");
    const { data, info } = await source
      .rotate()
      .toBuffer({ resolveWithObject: true });
    if (data.length > outputLimit)
      fail(413, "OUTPUT_TOO_LARGE", "处理后图片超过体积限制（10MiB）");
    return {
      data,
      width: info.width,
      height: info.height,
      mime: `image/${info.format}`,
    };
  } catch (e: any) {
    if (e.status) throw e;
    if (/pixel limit/i.test(e.message))
      fail(413, "PIXEL_LIMIT", "图片超过2000万像素");
    fail(415, "INVALID_IMAGE", "图片无法解码，请检查文件是否损坏");
  }
}
