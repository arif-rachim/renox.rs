// SQL files imported as text (`with { type: "text" }`), bundled by `renox build`.
declare module "*.sql" {
  const text: string;
  export default text;
}
