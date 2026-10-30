// Markdown and TOML files imported as text (`with { type: "text" }`), bundled by `renox build`.
declare module "*.md" {
  const text: string;
  export default text;
}
declare module "*.toml" {
  const text: string;
  export default text;
}
