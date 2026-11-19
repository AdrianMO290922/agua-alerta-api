// Tipos mínimos de los bindings de wrangler.jsonc. No se usa @cloudflare/workers-types
// porque choca con bun-types (ambos redefinen Request, Response, fetch...).
declare module "cloudflare:workers" {
  interface R2PutOptions {
    httpMetadata?: { contentType?: string; cacheControl?: string };
  }
  interface R2Bucket {
    put(key: string, value: ArrayBuffer | ArrayBufferView | string | Blob | null, options?: R2PutOptions): Promise<unknown>;
  }
  export const env: {
    FOTOS: R2Bucket;
  };
}
