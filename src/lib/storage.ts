import { env } from "cloudflare:workers";

// Se valida por los primeros bytes, no por el Content-Type que manda el cliente:
// el bucket es público y no debe servir otra cosa que imágenes.
const FORMATS = [
  { ext: "jpg", mime: "image/jpeg", is: (b: Uint8Array) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { ext: "png", mime: "image/png", is: (b: Uint8Array) => ascii(b, 1, 4) === "PNG" && b[0] === 0x89 },
  { ext: "webp", mime: "image/webp", is: (b: Uint8Array) => ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 12) === "WEBP" },
] as const;

const ascii = (b: Uint8Array, from: number, to: number) => String.fromCharCode(...b.subarray(from, to));

/** Formato de las llaves que genera savePhoto(). POST /reports solo acepta estas. */
export const PHOTO_KEY_PATTERN =
  "^fotos/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\.(jpg|png|webp)$";

export const photoUrl = (key: string) => `${(process.env.R2_PUBLIC_URL ?? "").replace(/\/+$/, "")}/${key}`;

/** Guarda la imagen en R2. Devuelve null si no es JPG, PNG ni WebP. */
export async function savePhoto(file: File): Promise<{ key: string; url: string } | null> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const format = FORMATS.find((f) => f.is(bytes));
  if (!format) return null;

  const key = `fotos/${crypto.randomUUID()}.${format.ext}`;
  await env.FOTOS.put(key, bytes, {
    httpMetadata: { contentType: format.mime, cacheControl: "public, max-age=31536000, immutable" },
  });
  return { key, url: photoUrl(key) };
}
