import 'react-native-get-random-values';
import { sha256 } from '@noble/hashes/sha256';

/* global globalThis */

const nativeCrypto = globalThis.crypto || {};
if (!nativeCrypto.subtle) {
  Object.defineProperty(nativeCrypto, 'subtle', {
    configurable: false,
    enumerable: true,
    value: {
      async digest(algorithm, data) {
        const name = typeof algorithm === 'string' ? algorithm : algorithm?.name;
        if (String(name).toUpperCase().replace('-', '') !== 'SHA256') {
          throw new Error(`Unsupported digest algorithm: ${String(name)}`);
        }
        const input = data instanceof Uint8Array
          ? data
          : new Uint8Array(data.buffer || data, data.byteOffset || 0, data.byteLength);
        const output = sha256(input);
        return output.buffer.slice(output.byteOffset, output.byteOffset + output.byteLength);
      },
    },
  });
}
if (!globalThis.crypto) {
  Object.defineProperty(globalThis, 'crypto', { configurable: false, value: nativeCrypto });
}
