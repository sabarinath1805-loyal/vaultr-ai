import { createServer, type RequestListener, type Server } from "node:http";
import request from "supertest";

/**
 * Give one integration-test file one ephemeral HTTP listener. Supertest's
 * `request(app)` creates and closes a server for every request; under a busy
 * parallel suite, high-volume route tests can otherwise churn hundreds of
 * listeners and sockets while unrelated files are also making requests.
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
