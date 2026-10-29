// The part of `renox:modules` the shop uses: auth's currentUser (#241).
// `renox dev` writes the complete, generated types to .renox/types/ (#236);
// this file keeps `bun run check` working without them.
declare module "renox:modules" {
  export const auth: {
    currentUser(): Promise<{ id: string; email: string; display_name: string; created_at: number } | null>;
  };
}
