import net from "node:net";

export async function getFreePort(host = "127.0.0.1") {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", reject);
    server.listen({ host, port: 0, exclusive: true }, () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : null;
      if (!port) {
        server.close(() => reject(new Error("failed to allocate an ephemeral port")));
        return;
      }
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

export async function getFreePorts(count, host = "127.0.0.1") {
  const ports = [];
  while (ports.length < count) {
    const port = await getFreePort(host);
    if (!ports.includes(port)) ports.push(port);
  }
  return ports;
}
