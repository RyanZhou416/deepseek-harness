/**
 * Illustration imports become watched base64 data URLs inside a lazily
 * imported artwork module, so the account bundle's startup chunk stays small.
 */
declare module '*.webp' {
  const url: string
  export default url
}
declare module '*.svg' {
  const url: string
  export default url
}
