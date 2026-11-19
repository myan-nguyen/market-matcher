import { NextResponse } from "next/server";
import { parseRequest, runSearch } from "@/lib/search";

export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  const parsed = parseRequest(body);
  if (!parsed) {
    return NextResponse.json(
      { error: "A main search phrase and cohort description are required." },
      { status: 400 },
    );
  }
  return NextResponse.json(await runSearch(parsed));
}
