import { signOut } from "../services.js";
export const POST = async (ctx) => { await signOut(ctx); return new Response(null, { status: 303, headers: { location: "/" } }); };
