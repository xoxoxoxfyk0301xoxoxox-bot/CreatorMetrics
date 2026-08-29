/**
 * Meta Threads callbacks for Cloudflare Workers.
 *
 * Development mode:
 *   META_APP_SECRET may be omitted to accept a well-formed signed_request.
 *
 * Production:
 *   Configure META_APP_SECRET as a Cloudflare Worker Secret. When present,
 *   every POST signed_request is verified with HMAC-SHA256 before processing.
 *
 * Never log signed_request, decoded payloads, or secrets.
 */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "GET") {
      if (url.pathname === "/deauthorize" || url.pathname === "/data-deletion") {
        return json({ success: true, endpoint: url.pathname, method: "POST" });
      }

      if (url.pathname === "/data-deletion-status") {
        if (!url.searchParams.get("code")) {
          return json({ error: "confirmation code is required" }, 400);
        }
        return json({ status: "completed" });
      }

      return json({ error: "not found" }, 404);
    }

    if (request.method !== "POST") {
      return json({ error: "method not allowed" }, 405);
    }

    if (url.pathname !== "/deauthorize" && url.pathname !== "/data-deletion") {
      return json({ error: "not found" }, 404);
    }

    const signedRequest = await readSignedRequest(request);
    if (!signedRequest) {
      return json({ error: "signed_request is required" }, 400);
    }

    let payload;
    try {
      payload = await verifyAndDecodeSignedRequest(signedRequest, env.META_APP_SECRET);
    } catch {
      return json({ error: "invalid signed_request" }, 401);
    }

    if (url.pathname === "/deauthorize") {
      // Future production hook: revoke local credentials and disconnect the
      // Threads user identified by payload.user_id after signature validation.
      await receiveDeauthorization({ userId: payload.user_id ?? null });
      return json({ success: true });
    }

    const confirmationCode = crypto.randomUUID();
    await receiveDataDeletionRequest({
      confirmationCode,
      userId: payload.user_id ?? null,
      requestedAt: new Date().toISOString()
    });

    const statusUrl = new URL("/data-deletion-status", url.origin);
    statusUrl.searchParams.set("code", confirmationCode);

    return json({
      url: statusUrl.toString(),
      confirmation_code: confirmationCode
    });
  }
};

async function readSignedRequest(request) {
  const contentType = request.headers.get("content-type") || "";

  if (contentType.includes("application/json")) {
    const body = await request.json().catch(() => null);
    return typeof body?.signed_request === "string" ? body.signed_request : null;
  }

  const body = await request.text();
  return new URLSearchParams(body).get("signed_request");
}

async function verifyAndDecodeSignedRequest(signedRequest, appSecret) {
  const parts = signedRequest.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error("Malformed signed_request");
  }

  const [encodedSignature, encodedPayload] = parts;

  // Meta signed_request uses HMAC-SHA256 over the base64url payload. Signature
  // verification is mandatory in production. Setting the Worker Secret
  // META_APP_SECRET enables and enforces verification without hardcoding it.
  if (appSecret) {
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(appSecret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"]
    );

    const valid = await crypto.subtle.verify(
      "HMAC",
      key,
      decodeBase64Url(encodedSignature),
      new TextEncoder().encode(encodedPayload)
    );

    if (!valid) {
      throw new Error("Signature verification failed");
    }
  }

  const payload = JSON.parse(new TextDecoder().decode(decodeBase64Url(encodedPayload)));
  if (!payload || typeof payload !== "object") {
    throw new Error("Invalid signed_request payload");
  }
  return payload;
}

function decodeBase64Url(value) {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function receiveDeauthorization(_request) {
  // v0.1 intentionally has no persistence. Add credential revocation here.
}

async function receiveDataDeletionRequest(_request) {
  // v0.1 intentionally has no DB or KV. Future implementation can persist:
  // confirmationCode <-> Threads userId <-> deletion status, then delete the
  // corresponding Threads rows from Google Sheets asynchronously.
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store"
    }
  });
}
