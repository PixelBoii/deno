// Copyright 2018-2026 the Deno authors. MIT license.

(function () {
"use strict";
const { core, primordials } = __bootstrap;
const { op_now, op_time_origin, op_performance_object_bind,
  op_performance_object_data, op_performance_observer_register_factory,
  op_performance_observer_callback_factory } = core.ops;
const {
  ArrayPrototypeFilter,
  ArrayPrototypeIncludes,
  ArrayPrototypeIndexOf,
  ArrayPrototypePush,
  ArrayPrototypeSlice,
  ArrayPrototypeSort,
  ArrayPrototypeSplice,
  MathFloor,
  ObjectCreate,
  ObjectKeys,
  ObjectFreeze,
  ObjectPrototypeIsPrototypeOf,
  queueMicrotask,
  ReflectApply,
  ReflectHas,
  Symbol,
  SymbolFor,
  TypeError,
  TypedArrayPrototypeGetBuffer,
  Uint8Array,
  Uint32Array,
} = primordials;

const webidl = core.loadExtScript("ext:deno_webidl/00_webidl.js");

// Lazy-load structuredClone from 02_structured_clone
let _structuredClone;
function getStructuredClone() {
  if (!_structuredClone) {
    _structuredClone = core.loadExtScript(
      "ext:deno_web/02_structured_clone.js",
    ).structuredClone;
  }
  return _structuredClone;
}

// Lazy-load createFilteredInspectProxy from console
let _createFilteredInspectProxy;
function getCreateFilteredInspectProxy() {
  if (!_createFilteredInspectProxy) {
    _createFilteredInspectProxy = core.loadExtScript(
      "ext:deno_web/01_console.js",
    ).createFilteredInspectProxy;
  }
  return _createFilteredInspectProxy;
}

const { EventTarget, Event, defineEventHandler, dispatch, setIsTrusted } = core.loadExtScript("ext:deno_web/02_event.js");
const { DOMException } = core.loadExtScript("ext:deno_web/01_dom_exception.js");

const illegalConstructorKey = Symbol("illegalConstructorKey");
const performanceBacking = value => core.hostInterfaceData(value, "Performance");
const entryBacking = value => core.hostInterfaceData(value, "PerformanceEntry");
let performanceEntries = [];
let timeOrigin;
let timeOriginOffset = 0;
let timePrecision = 0;
let sharedClock;
let sharedTimeOrigin = 0;
let coarseSharedTimeOrigin = 0;
const performanceObservers = [];
let supportedEntryTypes = ObjectFreeze(["mark", "measure"]);
let queueObserverTask = queueMicrotask;
let reportObserverError = (error) => core.reportUnhandledException(error);
let resourceTimingBufferSize = 250;
let resourceTimingCount = 0;
let resourceTimingTaskQueued = false;
let resourceTimingSecondaryBuffer = [];

const hrU8 = new Uint8Array(8);
const hr = new Uint32Array(TypedArrayPrototypeGetBuffer(hrU8));

function setTimeOrigin(options = undefined) {
  if (options?.clock) sharedClock = options.clock;
  timePrecision = options?.precision ?? 0;
  if (sharedClock) {
    const current = sharedClock.now();
    const elapsed = options?.reset ? options.elapsed ?? 0 : sharedClock.elapsed();
    sharedTimeOrigin = current - elapsed;
    coarseSharedTimeOrigin = coarsenTime(sharedTimeOrigin);
    timeOrigin = coarsenTime(sharedClock.unixOffset() + sharedTimeOrigin);
    return;
  }
  op_time_origin(hrU8);
  timeOrigin = hr[0] * 1000 + hr[1] / 1e6;
  timeOriginOffset = 0;
  if (options?.reset) {
    op_now(hrU8);
    timeOriginOffset = hr[0] * 1000 + hr[1] / 1e6 - (options.elapsed ?? 0);
    timeOrigin += timeOriginOffset;
  }
  if (timePrecision) {
    timeOrigin = MathFloor(timeOrigin / timePrecision) * timePrecision;
  }
}

function coarsenTime(value) {
  return timePrecision ? MathFloor(value / timePrecision) * timePrecision : value;
}

// First coarsen the shared timestamp, then express it relative to this realm.
// Deno realms without an embedding clock keep their existing elapsed clock.
function coarsenRelativeTime(value) {
  return sharedClock
    ? coarsenTime(sharedTimeOrigin + value) - coarseSharedTimeOrigin
    : coarsenTime(value);
}

function now() {
  if (sharedClock) {
    const value = coarsenTime(sharedClock.now()) - coarseSharedTimeOrigin;
    return value < 0 ? 0 : value;
  }
  op_now(hrU8);
  const value = hr[0] * 1000 + hr[1] / 1e6 - timeOriginOffset;
  return timePrecision ? MathFloor(value / timePrecision) * timePrecision : value;
}

// Embedders can supply their event loop and additional entry types. Deno keeps
// its existing defaults when these hooks are not installed.
function configurePerformanceTimeline(options) {
  supportedEntryTypes = ObjectFreeze(ArrayPrototypeSort([...options.entryTypes]));
  queueObserverTask = options.queueTask;
  reportObserverError = options.reportError;
}

function createPerformanceEntry(name, type, startTime, duration) {
  return new PerformanceEntry(name, type, startTime, duration, illegalConstructorKey);
}

function updatePerformanceEntry(entry, duration) {
  webidl.assertBranded(entry, PerformanceEntryPrototype);
  entryBacking(entry).duration = duration;
}

// A reused initial Window receives a new document navigation, while keeping
// its Performance object, clock, observers, and other timeline entries.
function replacePerformanceEntry(previous, next) {
  webidl.assertBranded(previous, PerformanceEntryPrototype);
  webidl.assertBranded(next, PerformanceEntryPrototype);
  if (entryBacking(previous).entryType !== entryBacking(next).entryType) {
    throw new TypeError("Replacement performance entry must have the same type");
  }
  const index = ArrayPrototypeIndexOf(performanceEntries, previous);
  if (index < 0) throw new TypeError("Performance entry is not in the timeline");
  performanceEntries[index] = next;
}

function recordPerformanceEntry(entry, notify = true) {
  webidl.assertBranded(entry, PerformanceEntryPrototype);
  // Observers still receive entries when the resource timeline buffer is full.
  if (notify) queuePerformanceEntry(entry);
  if (entryBacking(entry).entryType === "resource") {
    if (resourceTimingCount >= resourceTimingBufferSize || resourceTimingTaskQueued) {
      ArrayPrototypePush(resourceTimingSecondaryBuffer, entry);
      if (!resourceTimingTaskQueued) {
        resourceTimingTaskQueued = true;
        queueObserverTask(drainResourceTimingBuffer);
      }
      return;
    }
    resourceTimingCount++;
  }
  ArrayPrototypePush(performanceEntries, entry);
}

function drainResourceTimingBuffer() {
  while (resourceTimingSecondaryBuffer.length > 0) {
    const before = resourceTimingSecondaryBuffer.length;
    if (resourceTimingCount >= resourceTimingBufferSize) {
      const event = new Event("resourcetimingbufferfull");
      setIsTrusted(event, true);
      dispatch(performance, event);
    }
    while (resourceTimingSecondaryBuffer.length && resourceTimingCount < resourceTimingBufferSize) {
      ArrayPrototypePush(performanceEntries, resourceTimingSecondaryBuffer[0]);
      ArrayPrototypeSplice(resourceTimingSecondaryBuffer, 0, 1);
      resourceTimingCount++;
    }
    // The handler did not free space. Discard overflow rather than loop forever.
    if (resourceTimingSecondaryBuffer.length >= before) resourceTimingSecondaryBuffer = [];
  }
  resourceTimingTaskQueued = false;
}

function sortedEntries(entries) {
  return ArrayPrototypeSort(copyObserverEntries(entries), (a, b) => entryBacking(a).startTime - entryBacking(b).startTime);
}

webidl.converters["PerformanceMarkOptions"] = webidl
  .createDictionaryConverter(
    "PerformanceMarkOptions",
    [
      {
        key: "detail",
        converter: webidl.converters.any,
      },
      {
        key: "startTime",
        converter: webidl.converters.DOMHighResTimeStamp,
      },
    ],
  );

webidl.converters["DOMString or DOMHighResTimeStamp"] = (
  V,
  prefix,
  context,
  opts,
) => {
  if (webidl.type(V) === "Number" && V !== null) {
    return webidl.converters.DOMHighResTimeStamp(V, prefix, context, opts);
  }
  return webidl.converters.DOMString(V, prefix, context, opts);
};

webidl.converters["PerformanceMeasureOptions"] = webidl
  .createDictionaryConverter(
    "PerformanceMeasureOptions",
    [
      {
        key: "detail",
        converter: webidl.converters.any,
      },
      {
        key: "start",
        converter: webidl.converters["DOMString or DOMHighResTimeStamp"],
      },
      {
        key: "duration",
        converter: webidl.converters.DOMHighResTimeStamp,
      },
      {
        key: "end",
        converter: webidl.converters["DOMString or DOMHighResTimeStamp"],
      },
    ],
  );

webidl.converters["DOMString or PerformanceMeasureOptions"] = (
  V,
  prefix,
  context,
  opts,
) => {
  if (webidl.type(V) === "Object" && V !== null) {
    return webidl.converters["PerformanceMeasureOptions"](
      V,
      prefix,
      context,
      opts,
    );
  }
  return webidl.converters.DOMString(V, prefix, context, opts);
};

function findMostRecent(
  name,
  type,
) {
  for (let i = performanceEntries.length - 1; i >= 0; --i) {
    const entry = performanceEntries[i];
    if (entryBacking(entry).name === name && entryBacking(entry).entryType === type) {
      return entry;
    }
  }
}

function convertMarkToTimestamp(mark, state = undefined) {
  if (typeof mark === "string") {
    const entry = state ? state.findMark(mark) : findMostRecent(mark, "mark");
    if (!entry) {
      throw new DOMException(
        `Cannot find mark: "${mark}"`,
        "SyntaxError",
      );
    }
    return entryBacking(entry).startTime;
  }
  if (mark < 0) {
    throw new TypeError(`Mark cannot be negative: received ${mark}`);
  }
  return mark;
}

function filterByNameType(
  name,
  type,
) {
  return sortedEntries(ArrayPrototypeFilter(
    performanceEntries,
    (entry) =>
      (name !== undefined ? entryBacking(entry).name === name : true) &&
      (type !== undefined ? entryBacking(entry).entryType === type : true),
  ));
}

class PerformanceEntry {
  get name() {
    webidl.assertBranded(this, PerformanceEntryPrototype);
    return entryBacking(this).name;
  }

  get entryType() {
    webidl.assertBranded(this, PerformanceEntryPrototype);
    return entryBacking(this).entryType;
  }

  get startTime() {
    webidl.assertBranded(this, PerformanceEntryPrototype);
    return entryBacking(this).startTime;
  }

  get duration() {
    webidl.assertBranded(this, PerformanceEntryPrototype);
    return entryBacking(this).duration;
  }

  constructor(
    name = null,
    entryType = null,
    startTime = null,
    duration = null,
    key = undefined,
  ) {
    if (key !== illegalConstructorKey) {
      webidl.illegalConstructor();
    }
    core.markHostInterface(this, "PerformanceEntry");
    core.markUnserializableHostObject(this);

    entryBacking(this).name = name;
    entryBacking(this).entryType = entryType;
    entryBacking(this).startTime = startTime;
    entryBacking(this).duration = duration;
  }

  toJSON() {
    webidl.assertBranded(this, PerformanceEntryPrototype);
    return {
      name: entryBacking(this).name,
      entryType: entryBacking(this).entryType,
      startTime: entryBacking(this).startTime,
      duration: entryBacking(this).duration,
    };
  }

  [SymbolFor("Deno.privateCustomInspect")](inspect, inspectOptions) {
    return inspect(
      getCreateFilteredInspectProxy()({
        object: this,
        evaluate: ObjectPrototypeIsPrototypeOf(
          PerformanceEntryPrototype,
          this,
        ),
        keys: [
          "name",
          "entryType",
          "startTime",
          "duration",
        ],
      }),
      inspectOptions,
    );
  }
}
webidl.configureInterface(PerformanceEntry);
const PerformanceEntryPrototype = PerformanceEntry.prototype;
webidl.registerInterfaceBrand(PerformanceEntryPrototype, value => core.hasHostInterface(value, "PerformanceEntry"));

class PerformanceMark extends PerformanceEntry {

  get detail() {
    webidl.assertBranded(this, PerformanceMarkPrototype);
    return entryBacking(this).detail;
  }

  get entryType() {
    webidl.assertBranded(this, PerformanceMarkPrototype);
    return "mark";
  }

  constructor(
    name,
    options = { __proto__: null },
  ) {
    const prefix = "Failed to construct 'PerformanceMark'";
    webidl.requiredArguments(arguments.length, 1, prefix);

    name = webidl.converters.DOMString(name, prefix, "Argument 1");

    options = webidl.converters.PerformanceMarkOptions(
      options,
      prefix,
      "Argument 2",
    );

    const { detail = null, startTime = now() } = options;

    super(name, "mark", startTime, 0, illegalConstructorKey);
    core.markHostInterface(this, "PerformanceMark");
    if (startTime < 0) {
      throw new TypeError(
        `Cannot construct PerformanceMark: startTime cannot be negative, received ${startTime}`,
      );
    }
    entryBacking(this).detail = getStructuredClone()(detail);
  }

  toJSON() {
    webidl.assertBranded(this, PerformanceMarkPrototype);
    return {
      name: entryBacking(this).name,
      entryType: entryBacking(this).entryType,
      startTime: entryBacking(this).startTime,
      duration: entryBacking(this).duration,
      detail: entryBacking(this).detail,
    };
  }

  [SymbolFor("Deno.privateCustomInspect")](inspect, inspectOptions) {
    return inspect(
      getCreateFilteredInspectProxy()({
        object: this,
        evaluate: ObjectPrototypeIsPrototypeOf(PerformanceMarkPrototype, this),
        keys: [
          "name",
          "entryType",
          "startTime",
          "duration",
          "detail",
        ],
      }),
      inspectOptions,
    );
  }
}
webidl.configureInterface(PerformanceMark);
const PerformanceMarkPrototype = PerformanceMark.prototype;
webidl.registerInterfaceBrand(PerformanceMarkPrototype, value => core.hasHostInterface(value, "PerformanceMark"));
class PerformanceMeasure extends PerformanceEntry {

  get detail() {
    webidl.assertBranded(this, PerformanceMeasurePrototype);
    return entryBacking(this).detail;
  }

  get entryType() {
    webidl.assertBranded(this, PerformanceMeasurePrototype);
    return "measure";
  }

  constructor(
    name = null,
    startTime = null,
    duration = null,
    detail = null,
    key = undefined,
  ) {
    if (key !== illegalConstructorKey) {
      webidl.illegalConstructor();
    }

    super(name, "measure", startTime, duration, key);
    core.markHostInterface(this, "PerformanceMeasure");
    entryBacking(this).detail = getStructuredClone()(detail);
  }

  toJSON() {
    webidl.assertBranded(this, PerformanceMeasurePrototype);
    return {
      name: entryBacking(this).name,
      entryType: entryBacking(this).entryType,
      startTime: entryBacking(this).startTime,
      duration: entryBacking(this).duration,
      detail: entryBacking(this).detail,
    };
  }

  [SymbolFor("Deno.privateCustomInspect")](inspect, inspectOptions) {
    return inspect(
      getCreateFilteredInspectProxy()({
        object: this,
        evaluate: ObjectPrototypeIsPrototypeOf(
          PerformanceMeasurePrototype,
          this,
        ),
        keys: [
          "name",
          "entryType",
          "startTime",
          "duration",
          "detail",
        ],
      }),
      inspectOptions,
    );
  }
}
webidl.configureInterface(PerformanceMeasure);
const PerformanceMeasurePrototype = PerformanceMeasure.prototype;
webidl.registerInterfaceBrand(PerformanceMeasurePrototype, value => core.hasHostInterface(value, "PerformanceMeasure"));

// Opaque host state is shared across same-isolate realms. Backend operations
// retain their creating timeline, even when a foreign prototype method is used.
const observerData = object => op_performance_object_data(object, 0);
const entryListData = object => op_performance_object_data(object, 1);

function copyObserverEntries(entries) {
  const result = [];
  for (let i = 0; i < entries.length; i++) ArrayPrototypePush(result, entries[i]);
  return result;
}

function scheduleObserverCallback(observer) {
  const state = observerData(observer);
  if (state.scheduled) return;
  state.scheduled = true;
  if (core.ops.op_create_performance_observer_callback) {
    const prepare = () => {
      state.scheduled = false;
      const entries = state.buffer;
      state.buffer = [];
      if (entries.length > 0) return state.factory(sortedEntries(entries));
    };
    queueObserverTask(core.ops.op_create_performance_observer_callback(observer, prepare, state.callback, reportObserverError));
    return;
  }
  queueObserverTask(() => {
    state.scheduled = false;
    const entries = state.buffer;
    state.buffer = [];
    if (entries.length > 0) {
      const delivery = state.factory(sortedEntries(entries));
      try {
        ReflectApply(state.callback, observer, [delivery.list, observer, delivery.options]);
      } catch (error) {
        reportObserverError(error, state.callback);
      }
    }
  });
}

function queuePerformanceEntry(entry) {
  for (let i = 0; i < performanceObservers.length; i++) {
    const observer = performanceObservers[i];
    const state = observerData(observer);
    if (ArrayPrototypeIncludes(state.entryTypes, entryBacking(entry).entryType)) {
      ArrayPrototypePush(state.buffer, entry);
      scheduleObserverCallback(observer);
    }
  }
}

function observerEntries(entries) {
  return sortedEntries(copyObserverEntries(entries));
}
function observerEntriesByType(entries, type, count) {
  const prefix = "Failed to execute 'getEntriesByType' on 'PerformanceObserverEntryList'";
  webidl.requiredArguments(count, 1, prefix);
  type = webidl.converters.DOMString(type, prefix, "Argument 1");
  const result = [];
  for (let i = 0; i < entries.length; i++) {
    if (entries[i].entryType === type) ArrayPrototypePush(result, entries[i]);
  }
  return result;
}
function observerEntriesByName(entries, name, type, count) {
  const prefix = "Failed to execute 'getEntriesByName' on 'PerformanceObserverEntryList'";
  webidl.requiredArguments(count, 1, prefix);
  name = webidl.converters.DOMString(name, prefix, "Argument 1");
  if (type !== undefined) type = webidl.converters.DOMString(type, prefix, "Argument 2");
  const result = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (entryBacking(entry).name === name && (type === undefined || entryBacking(entry).entryType === type)) {
      ArrayPrototypePush(result, entry);
    }
  }
  return result;
}

class PerformanceObserverEntryList {
  constructor(entries, key = undefined) {
    if (key !== illegalConstructorKey) webidl.illegalConstructor();
    const state = ObjectCreate(null);
    state.entries = copyObserverEntries(entries);
    state.getEntries = observerEntries;
    state.getEntriesByType = observerEntriesByType;
    state.getEntriesByName = observerEntriesByName;
    op_performance_object_bind(this, state, 1);
    core.markHostInterface(this, "PerformanceObserverEntryList");
  }
  getEntries() {
    const state = entryListData(this);
    return state.getEntries(state.entries);
  }
  getEntriesByType(type) {
    const state = entryListData(this);
    return state.getEntriesByType(state.entries, type, arguments.length);
  }
  getEntriesByName(name, type = undefined) {
    const state = entryListData(this);
    return state.getEntriesByName(state.entries, name, type, arguments.length);
  }
}
webidl.configureInterface(PerformanceObserverEntryList);
const PerformanceObserverEntryListPrototype = PerformanceObserverEntryList.prototype;

// The entry-list wrapper and callback options belong to the callback's realm.
function createObserverDelivery(entries) {
  return {
    list: new PerformanceObserverEntryList(entries, illegalConstructorKey),
    options: { droppedEntriesCount: 0 },
  };
}
op_performance_observer_register_factory(createObserverDelivery);

webidl.converters.PerformanceObserverInit = webidl.createDictionaryConverter(
  "PerformanceObserverInit",
  [
    { key: "buffered", converter: webidl.converters.boolean },
    { key: "durationThreshold", converter: webidl.converters.DOMHighResTimeStamp },
    { key: "entryTypes", converter: webidl.converters["sequence<DOMString>"] },
    { key: "type", converter: webidl.converters.DOMString },
  ],
);

function observePerformance(observer, options) {
  const state = observerData(observer);
  const { entryTypes, type } = options;
  let types;
  if (entryTypes !== undefined) {
    types = [];
    for (let i = 0; i < entryTypes.length; i++) {
      if (ArrayPrototypeIncludes(supportedEntryTypes, entryTypes[i])) ArrayPrototypePush(types, entryTypes[i]);
    }
    if (types.length === 0) return;
  } else {
    if (!ArrayPrototypeIncludes(supportedEntryTypes, type)) return;
    types = copyObserverEntries(state.entryTypes);
    if (!ArrayPrototypeIncludes(types, type)) ArrayPrototypePush(types, type);
  }
  state.entryTypes = types;
  if (!ArrayPrototypeIncludes(performanceObservers, observer)) ArrayPrototypePush(performanceObservers, observer);
  if (type !== undefined && options.buffered === true) {
    let appended = false;
    for (let i = 0; i < performanceEntries.length; i++) {
      const entry = performanceEntries[i];
      if (entryBacking(entry).entryType === type) {
        ArrayPrototypePush(state.buffer, entry);
        appended = true;
      }
    }
    if (appended) scheduleObserverCallback(observer);
  }
}
function disconnectPerformance(observer) {
  const state = observerData(observer);
  const index = ArrayPrototypeIndexOf(performanceObservers, observer);
  if (index !== -1) ArrayPrototypeSplice(performanceObservers, index, 1);
  state.entryTypes = [];
  state.buffer = [];
}
function takePerformanceRecords(observer) {
  const state = observerData(observer);
  const records = state.buffer;
  state.buffer = [];
  return records;
}

class PerformanceObserver {
  static get supportedEntryTypes() { return supportedEntryTypes; }
  constructor(callback) {
    const prefix = "Failed to construct 'PerformanceObserver'";
    webidl.requiredArguments(arguments.length, 1, prefix);
    if (typeof callback !== "function") {
      throw new TypeError(`${prefix}: The callback provided as parameter 1 is not a function.`);
    }
    const state = ObjectCreate(null);
    state.callback = callback;
    state.entryTypes = [];
    state.buffer = [];
    state.scheduled = false;
    state.observerType = undefined;
    state.observe = observePerformance;
    state.disconnect = disconnectPerformance;
    state.takeRecords = takePerformanceRecords;
    // An unbootstrapped embedding realm has no entry-list interface factory.
    // Browser Window/Worker realms always register their actual local factory.
    state.factory = op_performance_observer_callback_factory(callback) ?? createObserverDelivery;
    op_performance_object_bind(this, state, 0);
    core.markHostInterface(this, "PerformanceObserver");
  }
  observe(options = undefined) {
    const state = observerData(this);
    const prefix = "Failed to execute 'observe' on 'PerformanceObserver'";
    options = webidl.converters.PerformanceObserverInit(options, prefix, "Argument 1");
    const { entryTypes, type } = options;
    if (entryTypes !== undefined && type !== undefined) {
      throw new TypeError(`${prefix}: Cannot specify both 'entryTypes' and 'type'.`);
    }
    if (entryTypes === undefined && type === undefined) {
      throw new TypeError(`${prefix}: Either 'entryTypes' or 'type' must be specified.`);
    }
    const mode = entryTypes !== undefined ? "multiple" : "single";
    if (state.observerType !== undefined && state.observerType !== mode) {
      throw new DOMException(`${prefix}: Cannot change observer type.`, "InvalidModificationError");
    }
    state.observerType = mode;
    return state.observe(this, options);
  }
  disconnect() {
    return observerData(this).disconnect(this);
  }
  takeRecords() {
    return observerData(this).takeRecords(this);
  }
}
webidl.configureInterface(PerformanceObserver);
const PerformanceObserverPrototype = PerformanceObserver.prototype;

class Performance extends EventTarget {
  constructor(key = null) {
    if (key != illegalConstructorKey) {
      webidl.illegalConstructor();
    }

    super();
    core.markHostInterface(this, "Performance");
    core.markUnserializableHostObject(this);
    const state = performanceBacking(this);
    state.timeOrigin = () => timeOrigin;
    state.now = now;
    state.entries = filterByNameType;
    state.findMark = name => findMostRecent(name, "mark");
    state.clear = (type, name) => {
      performanceEntries = ArrayPrototypeFilter(performanceEntries, entry =>
        entryBacking(entry).entryType !== type ||
        (name !== undefined && entryBacking(entry).name !== name));
      if (type === "resource") resourceTimingCount = 0;
    };
    state.setBufferSize = size => { resourceTimingBufferSize = size; };
    state.mark = (name, options) => {
      const entry = new PerformanceMark(name, options);
      ArrayPrototypePush(performanceEntries, entry);
      queuePerformanceEntry(entry);
      return entry;
    };
    state.measure = (name, start, duration, detail) => {
      const entry = new PerformanceMeasure(name, start, duration, detail, illegalConstructorKey);
      ArrayPrototypePush(performanceEntries, entry);
      queuePerformanceEntry(entry);
      return entry;
    };
  }

  get timeOrigin() {
    webidl.assertBranded(this, PerformancePrototype);
    return performanceBacking(this).timeOrigin();
  }

  clearMarks(markName = undefined) {
    webidl.assertBranded(this, PerformancePrototype);
    if (markName !== undefined) {
      markName = webidl.converters.DOMString(
        markName,
        "Failed to execute 'clearMarks' on 'Performance'",
        "Argument 1",
      );
    }
    performanceBacking(this).clear("mark", markName);
  }

  clearMeasures(measureName = undefined) {
    webidl.assertBranded(this, PerformancePrototype);
    if (measureName !== undefined) {
      measureName = webidl.converters.DOMString(
        measureName,
        "Failed to execute 'clearMeasures' on 'Performance'",
        "Argument 1",
      );
    }
    performanceBacking(this).clear("measure", measureName);
  }

  clearResourceTimings() {
    webidl.assertBranded(this, PerformancePrototype);
    performanceBacking(this).clear("resource");
  }

  setResourceTimingBufferSize(maxSize) {
    webidl.assertBranded(this, PerformancePrototype);
    webidl.requiredArguments(
      arguments.length,
      1,
      "Failed to execute 'setResourceTimingBufferSize' on 'Performance'",
    );
    const size = webidl.converters["unsigned long"](
      maxSize, "Failed to execute 'setResourceTimingBufferSize' on 'Performance'", "Argument 1",
    );
    performanceBacking(this).setBufferSize(size);
  }

  getEntries() {
    webidl.assertBranded(this, PerformancePrototype);
    return performanceBacking(this).entries();
  }

  getEntriesByName(
    name,
    type = undefined,
  ) {
    webidl.assertBranded(this, PerformancePrototype);
    const prefix = "Failed to execute 'getEntriesByName' on 'Performance'";
    webidl.requiredArguments(arguments.length, 1, prefix);

    name = webidl.converters.DOMString(name, prefix, "Argument 1");

    if (type !== undefined) {
      type = webidl.converters.DOMString(type, prefix, "Argument 2");
    }

    return performanceBacking(this).entries(name, type);
  }

  getEntriesByType(type) {
    webidl.assertBranded(this, PerformancePrototype);
    const prefix = "Failed to execute 'getEntriesByName' on 'Performance'";
    webidl.requiredArguments(arguments.length, 1, prefix);

    type = webidl.converters.DOMString(type, prefix, "Argument 1");

    return performanceBacking(this).entries(undefined, type);
  }

  mark(
    markName,
    markOptions = { __proto__: null },
  ) {
    webidl.assertBranded(this, PerformancePrototype);
    const prefix = "Failed to execute 'mark' on 'Performance'";
    webidl.requiredArguments(arguments.length, 1, prefix);

    markName = webidl.converters.DOMString(markName, prefix, "Argument 1");

    markOptions = webidl.converters.PerformanceMarkOptions(
      markOptions,
      prefix,
      "Argument 2",
    );

    if (markOptions.startTime !== undefined && markOptions.startTime < 0) {
      throw new TypeError(`${prefix}: '${markName}' cannot have a negative start time.`);
    }
    // Serialize in the operation realm, then let the genuine receiver's factory
    // create its entry and detail objects in that receiver's realm.
    if (this !== performance && markOptions.detail !== undefined) {
      markOptions.detail = getStructuredClone()(markOptions.detail);
    }
    return performanceBacking(this).mark(markName, markOptions);
  }

  measure(
    measureName,
    startOrMeasureOptions = { __proto__: null },
    endMark = undefined,
  ) {
    webidl.assertBranded(this, PerformancePrototype);
    const prefix = "Failed to execute 'measure' on 'Performance'";
    webidl.requiredArguments(arguments.length, 1, prefix);

    measureName = webidl.converters.DOMString(
      measureName,
      prefix,
      "Argument 1",
    );

    startOrMeasureOptions = webidl.converters
      ["DOMString or PerformanceMeasureOptions"](
        startOrMeasureOptions,
        prefix,
        "Argument 2",
      );

    if (endMark !== undefined) {
      endMark = webidl.converters.DOMString(endMark, prefix, "Argument 3");
    }

    if (
      startOrMeasureOptions && typeof startOrMeasureOptions === "object" &&
      ObjectKeys(startOrMeasureOptions).length > 0
    ) {
      if (endMark) {
        throw new TypeError('Options cannot be passed with "endMark"');
      }
      if (
        ReflectHas(startOrMeasureOptions, "start") &&
        ReflectHas(startOrMeasureOptions, "duration") &&
        ReflectHas(startOrMeasureOptions, "end")
      ) {
        throw new TypeError(
          'Cannot specify "start", "end", and "duration" together in options',
        );
      }
    }
    const state = performanceBacking(this);
    let endTime;
    if (endMark) {
      endTime = convertMarkToTimestamp(endMark, state);
    } else if (
      typeof startOrMeasureOptions === "object" &&
      ReflectHas(startOrMeasureOptions, "end")
    ) {
      endTime = convertMarkToTimestamp(startOrMeasureOptions.end, state);
    } else if (
      typeof startOrMeasureOptions === "object" &&
      ReflectHas(startOrMeasureOptions, "start") &&
      ReflectHas(startOrMeasureOptions, "duration")
    ) {
      const start = convertMarkToTimestamp(startOrMeasureOptions.start, state);
      const duration = convertMarkToTimestamp(startOrMeasureOptions.duration, state);
      endTime = start + duration;
    } else {
      endTime = state.now();
    }
    let startTime;
    if (
      typeof startOrMeasureOptions === "object" &&
      ReflectHas(startOrMeasureOptions, "start")
    ) {
      startTime = convertMarkToTimestamp(startOrMeasureOptions.start, state);
    } else if (
      typeof startOrMeasureOptions === "object" &&
      ReflectHas(startOrMeasureOptions, "end") &&
      ReflectHas(startOrMeasureOptions, "duration")
    ) {
      const end = convertMarkToTimestamp(startOrMeasureOptions.end, state);
      const duration = convertMarkToTimestamp(startOrMeasureOptions.duration, state);
      startTime = end - duration;
    } else if (typeof startOrMeasureOptions === "string") {
      startTime = convertMarkToTimestamp(startOrMeasureOptions, state);
    } else {
      startTime = 0;
    }
    const detail = typeof startOrMeasureOptions === "object"
      ? startOrMeasureOptions.detail ?? null : null;
    return state.measure(measureName, startTime, endTime - startTime,
      this === performance ? detail : getStructuredClone()(detail));
  }

  now() {
    webidl.assertBranded(this, PerformancePrototype);
    return performanceBacking(this).now();
  }

  toJSON() {
    webidl.assertBranded(this, PerformancePrototype);
    return {
      timeOrigin: performanceBacking(this).timeOrigin(),
    };
  }

  [SymbolFor("Deno.privateCustomInspect")](inspect, inspectOptions) {
    return inspect(
      getCreateFilteredInspectProxy()({
        object: this,
        evaluate: ObjectPrototypeIsPrototypeOf(PerformancePrototype, this),
        keys: ["timeOrigin"],
      }),
      inspectOptions,
    );
  }
}
webidl.configureInterface(Performance);
const PerformancePrototype = Performance.prototype;
webidl.registerInterfaceBrand(PerformancePrototype, value => core.hasHostInterface(value, "Performance"));
defineEventHandler(PerformancePrototype, "resourcetimingbufferfull");

webidl.converters["Performance"] = webidl.createInterfaceConverter(
  "Performance",
  PerformancePrototype,
);

const performance = new Performance(illegalConstructorKey);

return {
  Performance,
  performance,
  PerformanceEntry,
  PerformanceMark,
  PerformanceMeasure,
  PerformanceObserver,
  PerformanceObserverEntryList,
  setTimeOrigin,
  coarsenRelativeTime,
  configurePerformanceTimeline,
  createPerformanceEntry,
  updatePerformanceEntry,
  replacePerformanceEntry,
  recordPerformanceEntry,
  queuePerformanceEntry,
};
})();
