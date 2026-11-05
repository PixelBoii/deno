// Copyright 2018-2026 the Deno authors. MIT license.

// deno-lint-ignore-file

(function () {
const { core } = __bootstrap;


const transferMode = Symbol("kTransferMode");
const kCloneable = 1;
const kTransferable = 2;
const kDisallowCloneAndTransfer = 4;

const kClone = Symbol.for("nodejs.messaging.kClone");
const kDeserialize = Symbol.for("nodejs.messaging.kDeserialize");
// Generic Node transfer hooks remain separate from native stream registrations.
const kTransfer = Symbol.for("nodejs.messaging.kTransfer");
const kTransferList = Symbol.for("nodejs.messaging.kTransferList");

function markTransferMode(obj, cloneable = false, transferable = false) {
  if ((typeof obj !== "object" && typeof obj !== "function") || obj === null) {
    return;
  }
  let mode = kDisallowCloneAndTransfer;
  if (cloneable) mode |= kCloneable;
  if (transferable) mode |= kTransferable;
  obj[transferMode] = mode;
}

function setup() {}

function structuredClone(value, options) {
  return globalThis.structuredClone(value, options);
}

return {
  markTransferMode,
  setup,
  structuredClone,
  kClone,
  kDeserialize,
  kTransfer,
  kTransferList,
};
})();
