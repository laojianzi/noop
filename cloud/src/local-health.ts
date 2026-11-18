export default {
  fetch(req: Request, env: { HUB: DurableObjectNamespace }) {
    if (req.method !== "GET" || new URL(req.url).pathname !== "/api/status") return new Response(null, { status: 404 });
    return env.HUB.get(env.HUB.idFromName("hub")).fetch(req);
  },
};
