// version.ts — how a client and a server agree on a protocol version. This file exists so the
// rule is one function both `validate` and the server call, not a comparison each rewrites. It
// must never guess what a client supports: `hello.v` is the client's MAXIMUM and the server
// learns nothing else, so the only version it can safely answer in is that one.

/** A v1 client meeting a v2 server: server answers in the highest version both support; if none, `error UNSUPPORTED_VERSION fatal supported:[…]` and close 1002. */
export function negotiate(clientVersion: number, serverVersions: readonly number[]): number | null {
  // The client announces one number — its maximum — so "highest both support" collapses to
  // "that number, if the server has it". A v3 client meeting a [1, 2] server is told `supported`
  // and re-hellos with 2 itself (LLD §5.3); the server never assumes it could.
  return serverVersions.includes(clientVersion) ? clientVersion : null;
}
