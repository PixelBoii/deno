// Copyright 2018-2026 the Deno authors. MIT license.

// @ts-check
/// <reference path="../../core/internal.d.ts" />

(function () {
const { core, primordials } = __bootstrap;
const {
  ArrayIsArray,
  ArrayPrototypePush,
  FunctionPrototypeApply,
  ObjectPrototypeIsPrototypeOf,
  SafeFinalizationRegistry,
  SafeSet,
  SafeSetIterator,
  SafeWeakRef,
  SetPrototypeAdd,
  SetPrototypeDelete,
  Symbol,
  SymbolFor,
  TypeError,
  TypeErrorPrototype,
  WeakRefPrototypeDeref,
} = primordials;

const webidl = core.loadExtScript("ext:deno_webidl/00_webidl.js");
const { assert } = core.loadExtScript("ext:deno_web/00_infra.js");
const { createFilteredInspectProxy } = core.loadExtScript(
  "ext:deno_web/01_console.js",
);
const {
  defineEventHandler,
  dispatch,
  Event,
  EventTarget,
  listenerCount,
  setIsTrusted,
} = core.loadExtScript("ext:deno_web/02_event.js");

const abortReason = "abortReason";
const abortAlgos = "abortAlgos";
const dependent = "dependent";
const sourceSignals = "sourceSignals";
const dependentSignals = "dependentSignals";
const controllerSignal = "signal";
const timerId = "timerId";
const activeDependents = "activeDependents";

const illegalConstructorKey = Symbol("illegalConstructorKey");
const signalSlots = value => core.hostInterfaceData(value, "AbortSignal");
const controllerSlots = value => core.hostInterfaceData(value, "AbortController");
const { DOMException } = core.loadExtScript("ext:deno_web/01_dom_exception.js");
function isAbortSignal(value) { return core.hasHostInterface(value, "AbortSignal"); }
function isAborted(value) { return signalSlots(value)[abortReason] !== undefined; }
function getAbortReason(value) { return signalSlots(value)[abortReason]; }
function throwIfAborted(value) { if (isAborted(value)) throw getAbortReason(value); }
function addAbortAlgorithm(signal, algorithm) {
  if (isAborted(signal)) {
    return;
  }
  signalSlots(signal)[abortAlgos] ??= new SafeSet();
  SetPrototypeAdd(signalSlots(signal)[abortAlgos], algorithm);
}

function signalAbort(signal, reason = new DOMException("The signal has been aborted", "AbortError")) {
  if (isAborted(signal)) {
    return;
  }
  signalSlots(signal)[abortReason] = reason;

  const dependentSignalsToAbort = [];
  if (signalSlots(signal)[dependentSignals] !== null) {
    for (const weakRef of new SafeSetIterator(signalSlots(signal)[dependentSignals])) {
      const dependentSignal = WeakRefPrototypeDeref(weakRef);
      if (
        dependentSignal !== undefined &&
        signalSlots(dependentSignal)[abortReason] === undefined
      ) {
        signalSlots(dependentSignal)[abortReason] = signalSlots(signal)[abortReason];
        ArrayPrototypePush(dependentSignalsToAbort, dependentSignal);
      }
    }
  }

  runAbortSteps(signal);

  if (dependentSignalsToAbort.length !== 0) {
    for (let i = 0; i < dependentSignalsToAbort.length; ++i) {
      const dependentSignal = dependentSignalsToAbort[i];
      runAbortSteps(dependentSignal);
    }
  }
}

function runAbortSteps(signal) {
  const algos = signalSlots(signal)[abortAlgos];
  signalSlots(signal)[abortAlgos] = null;

  if (algos !== null) {
    for (const algorithm of new SafeSetIterator(algos)) {
      algorithm();
    }
  }

  if (listenerCount(signal, "abort") > 0) {
    const event = new Event("abort");
    setIsTrusted(event, true);
    dispatch(signal, event);
  }

  // release strong references from source signals now that abort has been delivered
  if (signalSlots(signal)[sourceSignals] !== null) {
    for (const weakRef of new SafeSetIterator(signalSlots(signal)[sourceSignals])) {
      const sourceSignal = WeakRefPrototypeDeref(weakRef);
      if (sourceSignal !== undefined && signalSlots(sourceSignal)[activeDependents]) {
        SetPrototypeDelete(signalSlots(sourceSignal)[activeDependents], signal);
      }
    }
  }
}

function removeAbortAlgorithm(signal, algorithm) {
  signalSlots(signal)[abortAlgos] && SetPrototypeDelete(signalSlots(signal)[abortAlgos], algorithm);
}

// When a dependent signal created by AbortSignal.any() is GC'd, clean up
// its WeakRef from each source signal's dependentSignals set.
// This prevents unbounded growth of the set when .any() is called in a loop.
const dependentSignalCleanupRegistry = new SafeFinalizationRegistry(
  (prevent) => {
    const sourceSignal = WeakRefPrototypeDeref(prevent.ref);
    if (sourceSignal === undefined) return;
    const deps = signalSlots(sourceSignal)[dependentSignals];
    if (deps === null) return;
    SetPrototypeDelete(deps, prevent.weak);
  },
);

class AbortSignal extends EventTarget {
  static any(signals) {
    const prefix = "Failed to execute 'AbortSignal.any'";
    // Node tags these validation errors with `ERR_INVALID_ARG_TYPE`; the
    // WebIDL machinery otherwise throws plain (code-less) TypeErrors.
    try {
      webidl.requiredArguments(arguments.length, 1, prefix);
    } catch (e) {
      e.code = "ERR_INVALID_ARG_TYPE";
      throw e;
    }
    // Validate array elements up front so a non-AbortSignal member reports
    // Node's `signals[i] is not of type AbortSignal.` message. Non-array
    // iterables fall through to the sequence converter below.
    if (ArrayIsArray(signals)) {
      for (let i = 0; i < signals.length; i++) {
        if (!isAbortSignal(signals[i])) {
          const err = new TypeError(
            `signals[${i}] is not of type AbortSignal.`,
          );
          err.code = "ERR_INVALID_ARG_TYPE";
          throw err;
        }
      }
    }
    try {
      return createDependentAbortSignal(signals, prefix);
    } catch (e) {
      if (
        ObjectPrototypeIsPrototypeOf(TypeErrorPrototype, e) &&
        e.code === undefined
      ) {
        e.code = "ERR_INVALID_ARG_TYPE";
      }
      throw e;
    }
  }

  static abort(reason = undefined) {
    if (reason !== undefined) {
      reason = webidl.converters.any(reason);
    }
    const signal = new AbortSignal(illegalConstructorKey);
    signalAbort(signal, reason);
    return signal;
  }

  static timeout(millis) {
    const prefix = "Failed to execute 'AbortSignal.timeout'";
    webidl.requiredArguments(arguments.length, 1, prefix);
    millis = webidl.converters["unsigned long long"](
      millis,
      prefix,
      "Argument 1",
      {
        enforceRange: true,
      },
    );

    const signal = new AbortSignal(illegalConstructorKey);
    signalSlots(signal)[timerId] = core.createSystemTimer(
      () => {
        core.cancelTimer(signalSlots(signal)[timerId]);
        signalSlots(signal)[timerId] = null;
        signalAbort(signal, new DOMException(
          "The operation was aborted due to timeout",
          "TimeoutError",
        ));
      },
      millis,
      false, // start unrefed (like Node.js)
    );
    return signal;
  }

  constructor(key = null) {
    if (key !== illegalConstructorKey) {
      throw new TypeError("Illegal constructor");
    }
    super();
    core.markHostInterface(this, "AbortSignal");
    core.markUnserializableHostObject(this);
    signalSlots(this)[abortReason] = undefined;
    signalSlots(this)[abortAlgos] = null;
    signalSlots(this)[dependent] = false;
    signalSlots(this)[sourceSignals] = null;
    signalSlots(this)[dependentSignals] = null;
    signalSlots(this)[timerId] = null;
  }

  get aborted() {
    webidl.assertBranded(this, AbortSignalPrototype);
    return signalSlots(this)[abortReason] !== undefined;
  }

  get reason() {
    webidl.assertBranded(this, AbortSignalPrototype);
    return signalSlots(this)[abortReason];
  }

  throwIfAborted() {
    webidl.assertBranded(this, AbortSignalPrototype);
    if (signalSlots(this)[abortReason] !== undefined) {
      throw signalSlots(this)[abortReason];
    }
  }

  // `addEventListener` and `removeEventListener` have to be overridden in
  // order to have the timer block the event loop while there are listeners.
  // Private add/remove algorithms do not ref or unref the timer because they can
  // only be used by Deno internals, which use it to essentially cancel async
  // ops which would block the event loop.
  addEventListener() {
    FunctionPrototypeApply(super.addEventListener, this, arguments);
    if (listenerCount(this, "abort") > 0) {
      if (signalSlots(this)[timerId] !== null) {
        core.refTimer(signalSlots(this)[timerId]);
      } else if (signalSlots(this)[sourceSignals] !== null) {
        // While this dependent signal has 'abort' listeners, keep it strongly
        // reachable from each source signal so that an upstream abort can
        // still reach us. The source-to-dependent edge stored in
        // `dependentSignals` is a WeakRef; without this strong backref,
        // a GC between `AbortSignal.any(...)` and `source.abort()` will
        // collect us and the abort silently fails to propagate.
        for (const weakRef of new SafeSetIterator(signalSlots(this)[sourceSignals])) {
          const sourceSignal = WeakRefPrototypeDeref(weakRef);
          if (sourceSignal === undefined) continue;
          signalSlots(sourceSignal)[activeDependents] ??= new SafeSet();
          SetPrototypeAdd(signalSlots(sourceSignal)[activeDependents], this);
          if (signalSlots(sourceSignal)[timerId] !== null) {
            // For timer sources, also keep the event loop alive.
            core.refTimer(signalSlots(sourceSignal)[timerId]);
          }
        }
      }
    }
  }

  removeEventListener() {
    FunctionPrototypeApply(super.removeEventListener, this, arguments);
    if (listenerCount(this, "abort") === 0) {
      if (signalSlots(this)[timerId] !== null) {
        core.unrefTimer(signalSlots(this)[timerId]);
      } else if (signalSlots(this)[sourceSignals] !== null) {
        for (const weakRef of new SafeSetIterator(signalSlots(this)[sourceSignals])) {
          const sourceSignal = WeakRefPrototypeDeref(weakRef);
          if (sourceSignal === undefined) continue;
          // Release the strong backref that addEventListener installed; the
          // dependent is now free to be GC'd if nothing else holds it.
          if (signalSlots(sourceSignal)[activeDependents]) {
            SetPrototypeDelete(signalSlots(sourceSignal)[activeDependents], this);
          }
          if (signalSlots(sourceSignal)[timerId] !== null) {
            // Timer source: stop refing the event loop only if no other
            // dependent of this timer still has listeners.
            let allInactive = true;
            if (signalSlots(sourceSignal)[dependentSignals] !== null) {
              for (
                const depRef of new SafeSetIterator(
                  signalSlots(sourceSignal)[dependentSignals],
                )
              ) {
                const dep = WeakRefPrototypeDeref(depRef);
                if (
                  dep !== undefined && dep !== this &&
                  listenerCount(dep, "abort") > 0
                ) {
                  allInactive = false;
                  break;
                }
              }
            }
            if (allInactive) {
              core.unrefTimer(signalSlots(sourceSignal)[timerId]);
            }
          }
        }
      }
    }
  }

  [SymbolFor("Deno.privateCustomInspect")](inspect, inspectOptions) {
    return inspect(
      createFilteredInspectProxy({
        object: this,
        evaluate: ObjectPrototypeIsPrototypeOf(AbortSignalPrototype, this),
        keys: [
          "aborted",
          "reason",
          "onabort",
        ],
      }),
      inspectOptions,
    );
  }
}
defineEventHandler(AbortSignal.prototype, "abort");

webidl.configureInterface(AbortSignal);
const AbortSignalPrototype = AbortSignal.prototype;
webidl.registerInterfaceBrand(AbortSignalPrototype, isAbortSignal);

class AbortController {
  constructor() {
    core.markHostInterface(this, "AbortController");
    core.markUnserializableHostObject(this);
    controllerSlots(this)[controllerSignal] = new AbortSignal(illegalConstructorKey);
  }

  get signal() {
    webidl.assertBranded(this, AbortControllerPrototype);
    return controllerSlots(this)[controllerSignal];
  }

  abort(reason) {
    webidl.assertBranded(this, AbortControllerPrototype);
    signalAbort(controllerSlots(this)[controllerSignal], reason);
  }

  [SymbolFor("Deno.privateCustomInspect")](inspect, inspectOptions) {
    return inspect(
      createFilteredInspectProxy({
        object: this,
        evaluate: ObjectPrototypeIsPrototypeOf(AbortControllerPrototype, this),
        keys: [
          "signal",
        ],
      }),
      inspectOptions,
    );
  }
}

webidl.configureInterface(AbortController);
const AbortControllerPrototype = AbortController.prototype;
webidl.registerInterfaceBrand(AbortControllerPrototype, value => core.hasHostInterface(value, "AbortController"));

webidl.converters.AbortSignal = webidl.createInterfaceConverter(
  "AbortSignal",
  AbortSignal.prototype,
);
webidl.converters["sequence<AbortSignal>"] = webidl.createSequenceConverter(
  webidl.converters.AbortSignal,
);

function newSignal() {
  return new AbortSignal(illegalConstructorKey);
}

function createDependentAbortSignal(signals, prefix) {
  signals = webidl.converters["sequence<AbortSignal>"](
    signals,
    prefix,
    "Argument 1",
  );

  const resultSignal = new AbortSignal(illegalConstructorKey);
  for (let i = 0; i < signals.length; ++i) {
    const signal = signals[i];
    if (signalSlots(signal)[abortReason] !== undefined) {
      signalSlots(resultSignal)[abortReason] = signalSlots(signal)[abortReason];
      return resultSignal;
    }
  }

  signalSlots(resultSignal)[dependent] = true;
  signalSlots(resultSignal)[sourceSignals] = new SafeSet();
  for (let i = 0; i < signals.length; ++i) {
    const signal = signals[i];
    if (!signalSlots(signal)[dependent]) {
      signalSlots(signal)[dependentSignals] ??= new SafeSet();
      const signalRef = new SafeWeakRef(signal);
      const resultRef = new SafeWeakRef(resultSignal);
      SetPrototypeAdd(signalSlots(resultSignal)[sourceSignals], signalRef);
      SetPrototypeAdd(signalSlots(signal)[dependentSignals], resultRef);
      // When resultSignal is GC'd, remove its WeakRef from signal's dependentSignals
      dependentSignalCleanupRegistry.register(resultSignal, {
        ref: signalRef,
        weak: resultRef,
      });
    } else {
      for (
        const sourceSignalRef of new SafeSetIterator(
          signalSlots(signal)[sourceSignals],
        )
      ) {
        const sourceSignal = WeakRefPrototypeDeref(sourceSignalRef);
        if (sourceSignal === undefined) continue;
        assert(signalSlots(sourceSignal)[abortReason] === undefined);
        assert(!signalSlots(sourceSignal)[dependent]);

        // Check if already tracking this source
        let alreadyTracked = false;
        for (
          const existingRef of new SafeSetIterator(
            signalSlots(resultSignal)[sourceSignals],
          )
        ) {
          if (WeakRefPrototypeDeref(existingRef) === sourceSignal) {
            alreadyTracked = true;
            break;
          }
        }
        if (alreadyTracked) continue;

        signalSlots(sourceSignal)[dependentSignals] ??= new SafeSet();
        const newSourceRef = new SafeWeakRef(sourceSignal);
        const resultRef = new SafeWeakRef(resultSignal);
        SetPrototypeAdd(signalSlots(resultSignal)[sourceSignals], newSourceRef);
        SetPrototypeAdd(signalSlots(sourceSignal)[dependentSignals], resultRef);
        dependentSignalCleanupRegistry.register(resultSignal, {
          ref: newSourceRef,
          weak: resultRef,
        });
      }
    }
  }

  return resultSignal;
}

return {
  AbortController,
  AbortSignal,
  AbortSignalPrototype,
  addAbortAlgorithm,
  createDependentAbortSignal,
  newSignal,
  removeAbortAlgorithm,
  signalAbort,
  isAbortSignal,
  isAborted,
  getAbortReason,
  throwIfAborted,
};
})();
