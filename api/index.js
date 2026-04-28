// Tell Vercel to run this function on the Edge runtime (closer to users, lower latency)
export const runtimeConfig = { runtime: "edge" };

// Read the target backend domain from environment variables and strip any trailing slash
const upstreamOrigin = (process.env.TARGET_DOMAIN || "").replace(/\/$/, "");

// Headers that should NOT be forwarded to the upstream — they're hop-by-hop or Vercel-specific metadata
const blockedHeaders = new Set([
  "host",
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "forwarded",
  "x-forwarded-host",
  "x-forwarded-proto",
  "x-forwarded-port",
]);

// Main request handler — proxies every incoming request to the upstream server
export default async function relay(req) {
  // Guard: if TARGET_DOMAIN wasn't configured, return a 500 immediately
  if (!upstreamOrigin) {
    return new Response("Misconfigured: TARGET_DOMAIN is not set", { status: 500 });
  }

  try {
    // Find where the path starts (after "https://host"), defaulting to "/" if absent
    const slashIndex = req.url.indexOf("/", 8);

    // Build the full upstream URL by combining the origin with the original request path+query
    const forwardUrl =
      slashIndex === -1
        ? upstreamOrigin + "/"
        : upstreamOrigin + req.url.slice(slashIndex);

    // Container for the cleaned-up headers we will forward upstream
    const cleanHeaders = new Headers();

    // Track the real client IP so we can inject it as X-Forwarded-For
    let visitorIp = null;

    // Loop through every incoming header and decide what to keep, drop, or capture
    for (const [headerName, headerValue] of req.headers) {
      // Drop hop-by-hop and Vercel infrastructure headers
      if (blockedHeaders.has(headerName)) continue;

      // Drop any internal Vercel metadata headers (e.g. x-vercel-id, x-vercel-deployment-url)
      if (headerName.startsWith("x-vercel-")) continue;

      // Capture the real IP from x-real-ip (highest priority) and skip forwarding it raw
      if (headerName === "x-real-ip") {
        visitorIp = headerValue;
        continue;
      }

      // Fall back to x-forwarded-for if we haven't found the real IP yet
      if (headerName === "x-forwarded-for") {
        if (!visitorIp) visitorIp = headerValue;
        continue; // We'll re-inject this below in a controlled way
      }

      // All other headers pass through unchanged
      cleanHeaders.set(headerName, headerValue);
    }

    // Re-inject the client IP as X-Forwarded-For so the upstream knows the origin
    if (visitorIp) cleanHeaders.set("x-forwarded-for", visitorIp);

    // Determine HTTP verb for the upstream request
    const httpVerb = req.method;

    // Only stream a body for methods that can carry one (POST, PUT, PATCH, DELETE, etc.)
    const requestHasBody = httpVerb !== "GET" && httpVerb !== "HEAD";

    // Proxy the request — manual redirect mode means we pass 3xx responses back as-is
    return await fetch(forwardUrl, {
      method: httpVerb,
      headers: cleanHeaders,
      body: requestHasBody ? req.body : undefined,
      duplex: "half",       // Required for streaming request bodies in the Fetch API
      redirect: "manual",   // Don't auto-follow redirects; let the client handle them
    });

  } catch (proxyErr) {
    // Log the error server-side and return a 502 Bad Gateway to the client
    console.error("relay error:", proxyErr);
    return new Response("Bad Gateway: Tunnel Failed", { status: 502 });
  }
}
