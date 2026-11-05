// The services of `renox:modules` this app calls. The type check needs
// this file until the generated module types are picked up (chapter 6).
declare module "renox:modules" {
  export const auth: {
    currentUser(): Promise<{ id: string; email: string; display_name: string } | null>;
  };
  export const org: {
    currentOrg(): Promise<{ id: string; slug: string; name: string; role: string } | null>;
    switcher(next?: string): Promise<unknown>;
  };
}
