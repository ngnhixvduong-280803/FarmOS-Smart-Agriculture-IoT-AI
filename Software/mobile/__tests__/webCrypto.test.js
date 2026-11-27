/* global globalThis */

test('provides SHA-256 WebCrypto digest for PKCE S256', async () => {
  require('../src/polyfills/webCrypto');
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new Uint8Array([97, 98, 99]));
  const hex = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
  expect(hex).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});
