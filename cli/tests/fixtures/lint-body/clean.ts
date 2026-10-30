// unvalidated-body fixture (#275): nothing here is flagged.
import { type Ctx, validate } from "renox";
import { z } from "zod";

const Note = z.object({ text: z.string().max(500) });

export async function POST({ req }: Ctx): Promise<Response> {
  const note = await validate(Note, req);
  return Response.json(note);
}

export async function PUT({ req }: Ctx): Promise<Response> {
  const body = await req.json();
  const note = Note.parse(body);
  return Response.json(note);
}

export async function PATCH({ req }: Ctx): Promise<Response> {
  const note = await validate(Note, await req.json());
  return Response.json(note);
}

export async function DELETE({ req }: Ctx): Promise<Response> {
  const form = await req.formData();
  const r = Note.safeParse({ text: form.get("text") });
  void r;
  const checked = Note.safeParse(form);
  return Response.json(checked);
}

export async function GET(): Promise<Response> {
  // req.json() in a comment, and in a string: 'await req.json()'
  const upstream = await fetch("https://api.example.com/x");
  return Response.json(await upstream.json());
}
