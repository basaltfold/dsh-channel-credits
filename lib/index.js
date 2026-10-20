/**
 * Host half of dsh-channel-credits.
 *
 * Deliberately inert: every byte of behaviour lives in the browser half
 * (./client.js), which talks to the already-registered `channel-pack` RPC
 * service owned by dsh-our-free-model. This entry exists only so the loader
 * carries a row named after the package (the client module graph binds the
 * browser half to that row).
 */

export const name = 'channel-credits'

export function apply() {}
