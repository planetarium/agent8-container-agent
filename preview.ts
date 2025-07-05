const _server = globalThis.Bun.serve({
  port: 5174,
  fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/") {
      return new Response("Hello from Main Service at 5174!");
    }
    return new Response("Not Found", { status: 404 });
  },
});
