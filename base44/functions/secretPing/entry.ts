import { secrets } from "base44:runtime";
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { http } from "../../shared/http.ts";

export default async function (req: Request): Promise<Response> {
  try {
    const user = await createClientFromRequest(req).auth.me().catch(() => null);
    if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
    if (user.role !== "admin") return Response.json({ error: "Forbidden" }, { status: 403 });
    const token = secrets.get("BACKEND_API_TEST_SECRET");
    console.log("calling upstream with declared secret, length=" + String(token ? token.length : 0));
    const res = await http("https://httpbin.org/bearer", {
      method: "GET",
      headers: { Authorization: "Bearer " + (token || "") },
    });
    // The upstream echo is compared server-side and never returned, so the secret has no route back out.
    return Response.json({
      upstream_status: res.status,
      authenticated: res.body && res.body.authenticated === true,
      token_matches_upstream_echo: !!token && !!res.body && res.body.token === token,
      secret_length_seen_by_function: token ? token.length : 0,
    }, { status: res.status === 200 ? 200 : 502 });
  } catch (error: any) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}