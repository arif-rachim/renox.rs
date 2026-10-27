export function GET() { return new Response("one"); }
export async function DELETE() { return new Response(null, { status: 204 }); }
