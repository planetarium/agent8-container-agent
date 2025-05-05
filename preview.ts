const server = globalThis.Bun.serve({
  port: 5174,
  fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/") {
      return new Response("Hello from Main Service at 5174!");
    }
    return new Response("Not Found", { status: 404 });
  },
});

// 10초 뒤에 서버 종료
setTimeout(() => {
  console.log("⏳ 10초 경과. 서버를 종료합니다.");
  server.stop(); // Bun v1.0 이상에서 지원
  // 또는 process.exit(0);
}, 10_000);