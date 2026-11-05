// Copyright 2018-2026 the Deno authors. MIT license.

// This file is here because to break a circular dependency between streams and
// crypto.

(function () {
const { core, primordials } = __bootstrap;
const { Symbol } = primordials;

const kKeyType = Symbol("kKeyType");

function isKeyObject(obj) {
  return (
    obj != null && obj[kKeyType] !== undefined
  );
}

let nativeCryptoKeyCheck;
function isCryptoKey(obj) {
  nativeCryptoKeyCheck ??= core.loadExtScript("ext:deno_crypto/00_crypto.js").isCryptoKey;
  return nativeCryptoKeyCheck(obj);
}

return { kKeyType, isKeyObject, isCryptoKey };
})();
