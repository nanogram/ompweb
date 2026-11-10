"use strict";

const http = module.require("node:http");
const { pipeline } = module.require("node:stream");
const { createGzip } = module.require("node:zlib");
const { getBrowserUrl } = module.require("./network-addresses");

function customizationPublicOrigin(value) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("UI public URL must be one HTTPS origin without credentials, path, query or fragment");
  }
  return url.origin;
}

function acceptsGzip(value) {
  let wildcard = false;
  for (const entry of value?.split(",") ?? []) {
    const [coding, ...params] = entry.split(";").map((part) => part.trim().toLowerCase());
    if (coding !== "gzip" && coding !== "*") continue;
    const q = params.find((part) => part.startsWith("q="));
    const quality = q === undefined ? 1 : Number(q.slice(2));
    const accepted = quality > 0 && quality <= 1;
    if (coding === "gzip") return accepted;
    wildcard = accepted;
  }
  return wildcard;
}

function matchesEtag(value, etag) {
  if (value?.trim() === "*") return true;
  if (typeof etag !== "string") return false;
  const current = etag.replace(/^W\//, "");
  return value?.split(",").some((candidate) => candidate.trim().replace(/^W\//, "") === current) ?? false;
}

/** Bun 1.4.4 refuses named dev hosts. Admit one trusted VPN origin, not arbitrary Host rewrites. */
async function startCustomizationProxy({ publicUrl, hostname, port, upstream }) {
  const publicOrigin = customizationPublicOrigin(publicUrl);
  const expectedHost = new URL(publicOrigin).host.toLowerCase();
  const backend = new URL(upstream);
  const sockets = new Set();
  function headers(request, upgrade) {
    if (request.headers.host?.toLowerCase() !== expectedHost) return null;
    const result = { ...request.headers };
    // Preserve original API Host/Origin for ompweb's authentication and CSRF
    // checks. Only Bun's own reserved assets/socket need loopback headers.
    if ((request.url ?? "").split("?", 1)[0].startsWith("/_bun/")) {
      if (request.headers.origin !== undefined && request.headers.origin !== publicOrigin) return null;
      if (upgrade && request.headers.origin !== publicOrigin) return null;
      result.host = backend.host;
      if (request.headers.origin !== undefined) result.origin = backend.origin;
    }
    return result;
  }
  const server = http.createServer((request, response) => {
    const forwarded = headers(request, false);
    if (!forwarded) { response.writeHead(403); response.end("Untrusted GUI preview host or origin"); return; }
    const outgoing = http.request({ hostname: backend.hostname.replace(/^\[|\]$/g, ""), port: backend.port, method: request.method, path: request.url, headers: forwarded }, (incoming) => {
      const outgoingHeaders = { ...incoming.headers };
      const pathname = (request.url ?? "").split("?", 1)[0];
      const asset = (request.method === "GET" || request.method === "HEAD") && incoming.statusCode === 200
        && (pathname.startsWith("/_bun/client/") || pathname.startsWith("/_bun/asset/"));
      let gzip = false;
      if (asset) {
        const policy = String(outgoingHeaders["cache-control"] ?? "");
        const compressible = !/\bno-transform\b/i.test(policy) && !request.headers.range
          && !outgoingHeaders["content-encoding"] && !outgoingHeaders["content-range"]
          && /^(?:text\/(?:javascript|css)|application\/javascript)(?:;|$)/i.test(outgoingHeaders["content-type"] ?? "");
        if (compressible) {
          const vary = String(outgoingHeaders.vary ?? "");
          if (!vary.split(",").some((part) => /^(?:accept-encoding|\*)$/i.test(part.trim()))) {
            outgoingHeaders.vary = vary ? `${vary}, Accept-Encoding` : "Accept-Encoding";
          }
          gzip = acceptsGzip(request.headers["accept-encoding"]);
          if (gzip) {
            outgoingHeaders["content-encoding"] = "gzip";
            delete outgoingHeaders["content-length"];
            if (typeof outgoingHeaders.etag === "string" && !outgoingHeaders.etag.startsWith("W/")) {
              outgoingHeaders.etag = `W/${outgoingHeaders.etag}`;
            }
          }
        }
        // Bun's reserved dev assets bypass our normal response finalizer and
        // currently ignore If-None-Match. Revalidate against this response's
        // live ETag, never a cached revision, so GUI edits still arrive at once.
        if (!/\bno-store\b/i.test(policy)) {
          outgoingHeaders["cache-control"] ||= "private, no-cache, max-age=0, must-revalidate";
          if (matchesEtag(request.headers["if-none-match"], outgoingHeaders.etag)) {
            delete outgoingHeaders["content-length"];
            delete outgoingHeaders["content-encoding"];
            delete outgoingHeaders["transfer-encoding"];
            response.writeHead(304, outgoingHeaders);
            response.end();
            incoming.resume();
            return;
          }
        }
      }
      response.writeHead(incoming.statusCode, outgoingHeaders);
      if (gzip && request.method !== "HEAD") {
        pipeline(incoming, createGzip(), response, (error) => { if (error) response.destroy(error); });
      } else {
        incoming.pipe(response);
      }
    });
    outgoing.on("error", () => {
      if (!response.headersSent) { response.writeHead(502); response.end("GUI preview unavailable"); }
      else response.destroy();
    });
    request.on("aborted", () => outgoing.destroy());
    response.on("close", () => { if (!response.writableEnded) outgoing.destroy(); });
    request.pipe(outgoing);
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  server.on("upgrade", (request, socket, head) => {
    const forwarded = headers(request, true);
    if (!forwarded) { socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n"); return; }
    const outgoing = http.request({ hostname: backend.hostname.replace(/^\[|\]$/g, ""), port: backend.port, method: request.method, path: request.url, headers: forwarded });
    outgoing.on("upgrade", (response, peer, upstreamHead) => {
      sockets.add(peer);
      peer.on("close", () => sockets.delete(peer));
      socket.write(`HTTP/1.1 ${response.statusCode} ${response.statusMessage}\r\n` + response.rawHeaders.reduce((text, value, index, all) => index % 2 === 0 ? text + value + ": " + all[index + 1] + "\r\n" : text, "") + "\r\n");
      if (upstreamHead.length) socket.write(upstreamHead);
      if (head.length) peer.write(head);
      socket.on("error", () => peer.destroy());
      peer.on("error", () => socket.destroy());
      socket.on("close", () => peer.destroy());
      peer.on("close", () => socket.destroy());
      peer.pipe(socket);
      socket.pipe(peer);
    });
    outgoing.on("response", (response) => {
      socket.end(`HTTP/1.1 ${response.statusCode} ${response.statusMessage}\r\nConnection: close\r\n\r\n`);
      response.resume();
    });
    outgoing.on("error", () => socket.destroy());
    socket.on("close", () => outgoing.destroy());
    socket.on("error", () => outgoing.destroy());
    outgoing.end();
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: hostname, port }, resolve);
  });
  let closing;
  return {
    origin: getBrowserUrl(hostname, server.address().port), publicOrigin,
    close: () => (closing ??= new Promise((resolve, reject) => {
      for (const socket of sockets) socket.destroy();
      server.close((error) => error ? reject(error) : resolve());
    })),
  };
}

module.exports = { customizationPublicOrigin, startCustomizationProxy };
