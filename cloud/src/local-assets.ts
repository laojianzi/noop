const types: Record<string, string> = {
  html: "text/html; charset=utf-8", js: "text/javascript; charset=utf-8", mjs: "text/javascript; charset=utf-8",
  css: "text/css; charset=utf-8", wasm: "application/wasm", json: "application/json", webmanifest: "application/manifest+json",
  png: "image/png", svg: "image/svg+xml", txt: "text/plain; charset=utf-8",
};

export default {
  async fetch(req: Request, env: { FILES: { fetch(request: Request): Promise<Response> } }) {
    const url = new URL(req.url);
    if (url.pathname === "/") url.pathname = "/index.html";
    let res = await env.FILES.fetch(new Request(url, req));
    if (res.status === 404 && req.headers.get("accept")?.includes("text/html")) {
      url.pathname = "/index.html";
      res = await env.FILES.fetch(new Request(url, req));
    }
    if (!res.ok) return res;
    const headers = new Headers(res.headers);
    headers.set("content-type", types[url.pathname.split(".").at(-1) || ""] || "application/octet-stream");
    return new Response(res.body, { status: res.status, headers });
  },
};
