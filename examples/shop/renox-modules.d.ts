// The part of `renox:modules` the shop uses: auth's currentUser (#241),
// org's currentOrg and switcher (#242).
// `renox dev` writes the complete, generated types to .renox/types/ (#236);
// this file keeps `bun run check` working without them.
declare module "renox:modules" {
  export const auth: {
    currentUser(): Promise<{ id: string; email: string; display_name: string; created_at: number } | null>;
  };
  export const org: {
    currentOrg(): Promise<{ id: string; slug: string; name: string; role: string; scope: { org_id: string; role: string } } | null>;
    switcher(next?: string): Promise<Record<string, unknown> | null>;
  };
}
