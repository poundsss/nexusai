// TEMPORARY streaming probe for the multi-frame bridge verification. Returns a native Response
// wrapping a ReadableStream of timed text chunks — the platform delivers it incrementally
// through functions.fetch (live-confirmed pattern).
export default async function (req) {
  const enc = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      for (const c of ["alpha|", "beta|", "gamma|", "done"]) {
        controller.enqueue(enc.encode(c));
        await new Promise((r) => setTimeout(r, 250));
      }
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { "Content-Type": "text/plain" } });
}