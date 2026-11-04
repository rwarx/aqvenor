"use strict";
async function readRpcResponse(response, id, maxBytes = 2 * 1024 * 1024) {
  if (!response.body) throw new Error("MCP returned no response body.");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const sse = (response.headers.get("content-type") || "").includes("text/event-stream");
  let buffer = "";
  let bytes = 0;
  const result = (frame) => {
    if (frame.id !== id) throw new Error("MCP response id does not match the request.");
    if (frame.error) throw new Error(frame.error.message || "MCP call failed.");
    return frame.result;
  };
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > maxBytes) throw new Error("MCP response exceeded the size limit.");
      buffer += decoder.decode(part.value, { stream: true });
      if (sse) {
        let boundary;
        while ((boundary = /\r?\n\r?\n/.exec(buffer))) {
          const event = buffer.slice(0, boundary.index);
          buffer = buffer.slice(boundary.index + boundary[0].length);
          const data = event.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
          if (!data) continue;
          let frame;
          try { frame = JSON.parse(data); } catch { continue; }
          if (frame.id === id) return result(frame);
        }
      }
    }
    if (sse) throw new Error("MCP stream ended without the requested response.");
    buffer += decoder.decode();
    return result(JSON.parse(buffer));
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
module.exports = { readRpcResponse };
