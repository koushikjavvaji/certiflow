import { config } from "./config";

export interface WhatsAppMessage {
  to: string; // E.164 phone number
  text: string;
  // The provider de-duplicates on this key, so if we retry after a timeout where the
  // message was actually delivered, the candidate still gets exactly ONE message.
  idempotencyKey: string;
}

export interface WhatsAppClient {
  send(message: WhatsAppMessage): Promise<void>; // throws on any failure or timeout
}

// Talks to the (fake) provider over HTTP. Any non-2xx response, network error or
// timeout throws, and the queue retries the job later.
export function createHttpWhatsApp(baseUrl = config.whatsappUrl, timeoutMs = 5000): WhatsAppClient {
  return {
    async send(message) {
      const res = await fetch(`${baseUrl}/messages`, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": message.idempotencyKey },
        body: JSON.stringify({ to: message.to, text: message.text }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) throw new Error(`whatsapp responded ${res.status}`);
    },
  };
}
