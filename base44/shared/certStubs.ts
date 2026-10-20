// Shared helper for certification harnesses: a JSON Response builder so every stubbed API
// boundary in every cert builds its responses identically.
export const apiJson = (status, obj) => new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });