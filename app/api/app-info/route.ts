import packageJson from "../../../package.json";

/** Auth-gated handshake: advertise only implemented routes and wire contracts. */
export function GET(): Response {
  return Response.json({
    name: "ompweb",
    version: packageJson.version,
    api: 1,
    capabilities: {
      heartbeatParam: true,
      notificationAnswer: true,
      notificationDismiss: true,
      presenceOptional: true,
    },
  }, { headers: { "Cache-Control": "no-store" } });
}
