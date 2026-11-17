/**
 * The session JWT does not carry an email. Cursor's dashboard GetMe does.
 */
import { h2Request } from "./h2.js";

export async function fetchCursorEmail(token: string, proxyUrl: string | undefined): Promise<string> {
  const res = await h2Request({
    baseUrl: "https://api2.cursor.sh",
    path: "/aiserver.v1.DashboardService/GetMe",
    proxyUrl,
    timeoutMs: 12_000,
    body: Buffer.from("{}"),
    headers: {
      ":method": "POST",
      authorization: `Bearer ${token}`,
      accept: "application/json",
      "content-type": "application/json",
      "connect-protocol-version": "1",
      "x-cursor-client-type": "ide",
    },
  });
  if (res.status < 200 || res.status >= 300) return "";
  try {
    const parsed = JSON.parse(res.body.toString("utf8")) as { email?: unknown };
    return typeof parsed.email === "string" ? parsed.email.trim() : "";
  } catch {
    return "";
  }
}
