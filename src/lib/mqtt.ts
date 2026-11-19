// Aviso en tiempo real por el broker MQTT público (decisiones-tecnicas §3).
// Es solo el "timbre": el payload no trae datos y el dashboard revalida con
// GET /admin/leaks. Nada depende de esto: si el broker falla, solo se registra.
//
// mqtt.js funciona dentro del Worker: wrangler empaqueta su build de navegador y,
// como el global del Worker es un *WorkerGlobalScope, usa el WebSocket nativo.
import mqtt from "mqtt";
import { waitUntil } from "cloudflare:workers";

export type LeakEvent = { tipo: "created" | "confirmed"; leak_id: string };

const CONNECT_TIMEOUT_MS = 3_000;
// Tope total (conectar + publicar + cerrar) para no dejar el Worker colgado.
const TOTAL_TIMEOUT_MS = 6_000;

/** Conecta, publica (QoS 0, sin retain) y cierra. Nunca lanza: devuelve si se publicó. */
export async function publishLeakEvent(event: LeakEvent): Promise<boolean> {
  const url = process.env.MQTT_URL;
  const topic = process.env.MQTT_TOPIC;
  if (!url || !topic) return false;

  let client: mqtt.MqttClient | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const publish = async () => {
      // allowRetries = false: si se cierra antes del CONNACK, rechaza en vez de esperar.
      client = await mqtt.connectAsync(
        url,
        {
          clientId: `agua-alerta-api-${crypto.randomUUID()}`,
          connectTimeout: CONNECT_TIMEOUT_MS,
          reconnectPeriod: 0,
          clean: true,
        },
        false,
      );
      await client.publishAsync(topic, JSON.stringify(event), { qos: 0, retain: false });
      await client.endAsync();
    };
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`sin respuesta en ${TOTAL_TIMEOUT_MS} ms`)), TOTAL_TIMEOUT_MS);
    });
    await Promise.race([publish(), timeout]);
    return true;
  } catch (e) {
    console.error(`MQTT: no se pudo publicar ${event.tipo} ${event.leak_id}:`, e instanceof Error ? e.message : e);
    client?.end(true);
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Publica sin retrasar la respuesta: el Worker la manda de inmediato y sigue
 * vivo hasta que termine la publicación (equivale a ctx.waitUntil, que Elysia
 * no expone con el adapter de Workers).
 */
export function notifyLeakEvent(event: LeakEvent): void {
  waitUntil(publishLeakEvent(event));
}
