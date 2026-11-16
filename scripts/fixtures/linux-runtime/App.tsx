import { mount, Text } from "nsh";

// The shipped runner must generate IDs, make HTTP requests and exchange WebSocket messages.
const id = crypto.randomUUID();
if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id)) {
  throw new Error("Invalid message UUID");
}
console.log("NOOP_LINUX_RUNTIME_OK");
mount(() => <Text>Runtime OK</Text>);

void (async () => {
  const response = await fetch("http://127.0.0.1:__NOOP_PORT__/health");
  if (!response.ok || await response.text() !== "ok") throw new Error("HTTP response did not match");
  console.log("NOOP_LINUX_RUNTIME_HTTP_OK");
  const ws = new WebSocket("ws://127.0.0.1:__NOOP_PORT__/ws");
  ws.onopen = () => ws.send("ping");
  ws.onmessage = (event) => {
    if (event.data !== "pong") throw new Error("WebSocket response did not match");
    console.log("NOOP_LINUX_RUNTIME_WS_OK");
    ws.close();
  };
  ws.onerror = () => console.error("NOOP_LINUX_RUNTIME_WS_FAILED");
})().catch((error) => console.error("NOOP_LINUX_RUNTIME_NETWORK_FAILED", String(error)));
