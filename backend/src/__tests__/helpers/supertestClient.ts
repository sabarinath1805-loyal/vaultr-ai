import { createServer, type RequestListener, type Server } from "node:http";
import request from "supertest";

/**
 * Give one integration-test file one IPv4 loopback listener. Supertest's
 * `request(app)` creates a wildcard listener but connects to 127.0.0.1; on
 * hosts that permit separate IPv4 and IPv6 wildcard binds on the same port,
 * that can route a test request to an unrelated local listener. Binding this
 * server explicitly to loopback also avoids per-request listener churn.
 */
export function createSupertestClient(app: RequestListener) {
  let server: Server | null = null;

  return {
    async start(): Promise<void> {
      if (server) throw new Error("Supertest client already started");
      const candidate = createServer(app);
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => reject(error);
        candidate.once("error", onError);
        candidate.listen(0, "127.0.0.1", () => {
          candidate.off("error", onError);
          server = candidate;
          resolve();
        });
      });
    },

    async close(): Promise<void> {
      const current = server;
      server = null;
      if (!current?.listening) return;
      await new Promise<void>((resolve, reject) => {
        current.close((error) => (error ? reject(error) : resolve()));
      });
    },

    request() {
      if (!server?.listening) {
        throw new Error("Supertest client has not been started");
      }
      return request(server);
    },
  };
}

export async function withSupertestClient<T>(
  app: RequestListener,
  run: (client: ReturnType<typeof createSupertestClient>) => Promise<T>,
): Promise<T> {
  const client = createSupertestClient(app);
  await client.start();
  try {
    return await run(client);
  } finally {
    await client.close();
  }
}
