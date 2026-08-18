import { lookup } from "node:dns/promises";
import { request } from "node:https";
import { isPublicWebhookAddress } from "./endpoint-security.js";

export async function postPublicWebhook(input: {
  url: string;
  headers: Record<string, string>;
  body: string;
  signal: AbortSignal;
}): Promise<{ ok: boolean; status: number }> {
  const endpoint = new URL(input.url);
  const addresses = await lookup(endpoint.hostname, { all: true, verbatim: true });
  if (
    addresses.length === 0
    || addresses.some((address) => !isPublicWebhookAddress(address.address))
  ) throw new Error("Webhook endpoint did not resolve exclusively to public addresses");
  const selected = addresses[0]!;
  return new Promise((resolve, reject) => {
    const outgoing = request(endpoint, {
      method: "POST",
      headers: {
        ...input.headers,
        "content-length": String(Buffer.byteLength(input.body, "utf8"))
      },
      signal: input.signal,
      lookup: (_hostname, _options, callback) => {
        callback(null, selected.address, selected.family);
      }
    }, (response) => {
      response.resume();
      const status = response.statusCode ?? 0;
      resolve({ ok: status >= 200 && status < 300, status });
    });
    outgoing.once("error", reject);
    outgoing.end(input.body);
  });
}
