const http = require("node:http");
const net = require("node:net");
const { writeFile } = require("node:fs/promises");
const { isLoopbackHost } = require("./test-network-guard.cjs");

function originLabel(host, port) {
  return `${String(host).toLowerCase()}:${String(port || 80)}`;
}

function increment(map, key) {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function targetFromRequest(request) {
  let target;
  try {
    target = new URL(request.url);
  } catch {
    target = new URL(`http://${request.headers.host ?? ""}${request.url}`);
  }
  const port = Number(target.port || (target.protocol === "https:" ? 443 : 80));
  return { host: target.hostname.replace(/^\[|\]$/g, ""), port, target };
}

function proxyResponse(request, response, counts) {
  let destination;
  try {
    destination = targetFromRequest(request);
  } catch {
    increment(counts.blocked, "<invalid-target>");
    response.writeHead(400, { "content-type": "text/plain", connection: "close" });
    response.end("Blocked by the local-only E2E network guard.");
    return;
  }

  const label = originLabel(destination.host, destination.port);
  if (!isLoopbackHost(destination.host)) {
    increment(counts.blocked, label);
    response.writeHead(403, { "content-type": "text/plain", connection: "close" });
    response.end("Blocked by the local-only E2E network guard.");
    return;
  }

  increment(counts.allowed, label);
  const headers = { ...request.headers, host: destination.target.host };
  delete headers["proxy-authorization"];
  delete headers["proxy-connection"];
  const upstream = http.request(
    {
      hostname: destination.host,
      port: destination.port,
      method: request.method,
      path: `${destination.target.pathname}${destination.target.search}`,
      headers,
    },
    (upstreamResponse) => {
      response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
      upstreamResponse.pipe(response);
    },
  );
  upstream.on("error", () => {
    if (!response.headersSent) response.writeHead(502, { connection: "close" });
    response.end();
  });
  request.pipe(upstream);
}

function proxyConnect(request, client, head, counts) {
  let target;
  try {
    target = new URL(`http://${request.url}`);
  } catch {
    increment(counts.blocked, "<invalid-target>");
    client.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
    return;
  }
  const host = target.hostname.replace(/^\[|\]$/g, "");
  const port = Number(target.port);
  const label = originLabel(host, port);
  if (!isLoopbackHost(host) || !Number.isInteger(port) || port < 1 || port > 65535) {
    increment(counts.blocked, label);
    client.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
    return;
  }

  increment(counts.allowed, label);
  const upstream = net.connect(port, host, () => {
    client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (head.length) upstream.write(head);
    upstream.pipe(client);
    client.pipe(upstream);
  });
  upstream.on("error", () => client.destroy());
  client.on("error", () => upstream.destroy());
}

function proxyUpgrade(request, client, head, counts) {
  let destination;
  try {
    destination = targetFromRequest(request);
  } catch {
    increment(counts.blocked, "<invalid-target>");
    client.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
    return;
  }
  const label = originLabel(destination.host, destination.port);
  if (!isLoopbackHost(destination.host)) {
    increment(counts.blocked, label);
    client.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
    return;
  }

  increment(counts.allowed, label);
  const upstream = net.connect(destination.port, destination.host, () => {
    const requestPath = `${destination.target.pathname}${destination.target.search}`;
    const headers = Object.entries(request.headers)
      .filter(([name]) => !["proxy-authorization", "proxy-connection"].includes(name.toLowerCase()))
      .map(([name, value]) => `${name}: ${Array.isArray(value) ? value.join(", ") : value}`)
      .join("\r\n");
    upstream.write(`${request.method} ${requestPath} HTTP/${request.httpVersion}\r\n${headers}\r\n\r\n`);
    if (head.length) upstream.write(head);
    upstream.pipe(client);
    client.pipe(upstream);
  });
  upstream.on("error", () => client.destroy());
  client.on("error", () => upstream.destroy());
}

function summary(counts) {
  const entries = (map) => [...map].map(([target, count]) => ({ target, count }));
  return {
    allowedLoopbackRequests: [...counts.allowed.values()].reduce((sum, value) => sum + value, 0),
    allowedLoopbackTargets: entries(counts.allowed),
    blockedExternalRequests: [...counts.blocked.values()].reduce((sum, value) => sum + value, 0),
    blockedExternalTargets: entries(counts.blocked),
  };
}

async function startLocalEgressGuard({ host = "127.0.0.1", port = 0 } = {}) {
  const counts = { allowed: new Map(), blocked: new Map() };
  const server = http.createServer((request, response) => proxyResponse(request, response, counts));
  server.on("connect", (request, client, head) => proxyConnect(request, client, head, counts));
  server.on("upgrade", (request, client, head) => proxyUpgrade(request, client, head, counts));

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Local egress guard did not bind a TCP port");

  let closed = false;
  return {
    serverUrl: `http://${host}:${address.port}`,
    getSummary: () => summary(counts),
    close: async () => {
      if (!closed) {
        closed = true;
        await new Promise((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
      }
      return summary(counts);
    },
  };
}

async function playwrightGlobalSetup() {
  const port = Number(process.env.PLAYWRIGHT_LOCAL_EGRESS_PORT);
  const label = process.env.PLAYWRIGHT_LOCAL_EGRESS_LABEL ?? "browser";
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("PLAYWRIGHT_LOCAL_EGRESS_PORT must be a valid fixed local port");
  }
  return createPlaywrightEgressSetup({ port, label })();
}

function createPlaywrightEgressSetup({ port, label }) {
  return async function setupLocalEgressGuard() {
    const guard = await startLocalEgressGuard({ port });
    const configuredProxyPort = new URL(guard.serverUrl).port;
    if (configuredProxyPort !== String(port)) {
      await guard.close();
      throw new Error(`${label} local-only proxy bound an unexpected port`);
    }
    console.log(`[${label} egress guard] browser requests use loopback-only proxy ${guard.serverUrl}`);
    return async () => {
      const result = await guard.close();
      const reportPath = process.env.PLAYWRIGHT_LOCAL_EGRESS_REPORT;
      if (reportPath) await writeFile(reportPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
      console.log(
        `[${label} egress guard] ${result.allowedLoopbackRequests} loopback request(s), ${result.blockedExternalRequests} blocked external request(s)`,
      );
      if (result.blockedExternalRequests > 0) {
        const targets = result.blockedExternalTargets.map(({ target }) => target).join(", ");
        throw new Error(`${label} E2E attempted non-loopback browser egress; blocked target(s): ${targets}`);
      }
    };
  };
}

module.exports = playwrightGlobalSetup;
module.exports.createPlaywrightEgressSetup = createPlaywrightEgressSetup;
module.exports.startLocalEgressGuard = startLocalEgressGuard;
