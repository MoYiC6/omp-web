import { NextResponse } from "next/server";
import { isApiRequestAllowed } from "@/lib/request-security";
import { requireVisibleSession } from "@/lib/web-session-guard";
import { isReadableInternalUrl } from "@/lib/internal-url-web";
import { readSessionInternalUrl } from "@/lib/internal-url-session";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  const { id } = await params;
  const blocked = await requireVisibleSession(req, id);
  if (blocked) return blocked;
  const url = new URL(req.url).searchParams.get("url");
  if (!isReadableInternalUrl(url)) {
    return NextResponse.json({ error: "Unsupported internal URL" }, { status: 400 });
  }
  try {
    const resource = await readSessionInternalUrl(id, url, req.signal);
    if (!resource) return NextResponse.json({ error: "Session not found" }, { status: 404 });
    return NextResponse.json(resource, { headers: { "Cache-Control": "no-store" } });
  } catch {
    // SDK diagnostics can contain other resource names and filesystem paths.
    return NextResponse.json({ error: "Internal resource unavailable" }, { status: 404 });
  }
}
