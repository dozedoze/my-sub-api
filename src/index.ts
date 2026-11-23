import { adminHtml } from "./admin-ui";
import { adminApi, requireAdmin } from "./admin-api";
import faviconSvg from "./admin/favicon.svg";
import { quotaBoard } from "./durable";
import {
  adminSessionClearCookie,
  adminSessionSetCookie,
  clientIp,
  corsHeaders,
  GATE,
  GatewayError,
  isAdminShellPath,
  mintAdminSession,
  openaiError,
  throwIfAdmitFailed,
  upstreamRestPath,
} from "./lib";
import { proxy } from "./proxy";

export { ChatSession, QuotaBoard } from "./durable";

export default {
  async fetch(request, env, ctx): Promise<Response> {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }
    try {
      return await handle(request, env, ctx);
    } catch (err) {
      if (err instanceof GatewayError) return openaiError(err.status, err.code, err.message);
      console.error(JSON.stringify({ message: "unhandled", error: err instanceof Error ? err.message : String(err) }));
      return openaiError(500, "internal_error", "Internal server error");
    }
  },
} satisfies ExportedHandler<Env>;

async function handle(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";

  if (request.method === "GET" && path === "/health") {
    return Response.json({ ok: true }, { headers: corsHeaders() });
  }
  if (request.method === "GET" && (path === "/favicon.ico" || path === "/favicon.svg")) {
    return new Response(faviconSvg, {
      headers: {
        "content-type": "image/svg+xml; charset=utf-8",
        "cache-control": "public, max-age=86400",
      },
    });
  }
  if (request.method === "GET" && path === "/") {
    return Response.redirect(new URL("/admin", url.origin).href, 302);
  }
  if (path.startsWith("/admin/api")) {
    if (request.method === "POST" && path === "/admin/api/logout") {
      return new Response(JSON.stringify({ ok: true }), {
        headers: {
          ...corsHeaders(),
          "content-type": "application/json",
          "set-cookie": adminSessionClearCookie(request.url),
        },
      });
    }
    let viaBearer: boolean;
    try {
      viaBearer = await requireAdmin(request, env);
    } catch (err) {
      if (err instanceof GatewayError && err.status === 401) {
        throwIfAdmitFailed(
          await quotaBoard(env).admit(`admin:${clientIp(request)}`, {
            quota: 0,
            maxRpm: GATE.adminRpm,
            maxInflight: GATE.keyInflight,
            takeInflight: false,
          }),
        );
      }
      throw err;
    }
    const res = await adminApi(request, env, path);
    if (!viaBearer) return res;
    const headers = new Headers(res.headers);
    headers.append("set-cookie", adminSessionSetCookie(await mintAdminSession(env.ADMIN_TOKEN.trim()), request.url));
    return new Response(res.body, { status: res.status, headers });
  }
  if (request.method === "GET" && isAdminShellPath(path)) {
    return new Response(adminHtml(url.origin), { headers: { "content-type": "text/html; charset=utf-8" } });
  }

  const rest = upstreamRestPath(path);
  if (!rest) return openaiError(404, "not_found", "Not found");
  if (request.method !== "GET" && request.method !== "POST") {
    return openaiError(405, "method_not_allowed", "Method not allowed");
  }
  return proxy(request, env, ctx, rest);
}

