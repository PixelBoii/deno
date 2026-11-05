// Copyright 2018-2026 the Deno authors. MIT license.

// @ts-check
/// <reference path="../../core/internal.d.ts" />

(function () {
const { core } = __bootstrap;
const atob = core.ops.op_create_base64_binding(0, null);
const btoa = core.ops.op_create_base64_binding(1, null);
return { atob, btoa };
})();
