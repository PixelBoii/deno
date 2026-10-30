// Copyright 2018-2026 the Deno authors. MIT license.

(function () {
const { core, primordials } = __bootstrap;
const { op_now, op_time_origin } = core.ops;
const {
  ArrayPrototypeFilter,
  ArrayPrototypeIncludes,
  ArrayPrototypeIndexOf,
  ArrayPrototypePush,
  ArrayPrototypeSlice,
  ArrayPrototypeSort,
  ArrayPrototypeSplice,
  MathFloor,
  ObjectKeys,
  ObjectFreeze,
  ObjectPrototypeIsPrototypeOf,
  queueMicrotask,
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
let performanceEntries = [];
let timeOrigin;
let timeOriginOffset = 0;
let timePrecision = 0;
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
  op_time_origin(hrU8);
  timeOrigin = hr[0] * 1000 + hr[1] / 1e6;
  timeOriginOffset = 0;
  timePrecision = options?.precision ?? 0;
  if (options?.reset) {
    op_now(hrU8);
    timeOriginOffset = hr[0] * 1000 + hr[1] / 1e6 - (options.elapsed ?? 0);
    timeOrigin += timeOriginOffset;
  }
  if (timePrecision) {
    timeOrigin = MathFloor(timeOrigin / timePrecision) * timePrecision;
  }
}

function now() {
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
  entry[_duration] = duration;
}

function recordPerformanceEntry(entry, notify = true) {
  webidl.assertBranded(entry, PerformanceEntryPrototype);
  // Observers still receive entries when the resource timeline buffer is full.
  if (notify) queuePerformanceEntry(entry);
  if (entry.entryType === "resource") {
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
  return ArrayPrototypeSort(ArrayPrototypeSlice(entries), (a, b) => a.startTime - b.startTime);
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
    if (entry.name === name && entry.entryType === type) {
      return entry;
    }
  }
}

function convertMarkToTimestamp(mark) {
  if (typeof mark === "string") {
    const entry = findMostRecent(mark, "mark");
    if (!entry) {
      throw new DOMException(
        `Cannot find mark: "${mark}"`,
        "SyntaxError",
      );
    }
    return entry.startTime;
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
      (name !== undefined ? entry.name === name : true) &&
      (type !== undefined ? entry.entryType === type : true),
  ));
}

const _name = Symbol("[[name]]");
const _entryType = Symbol("[[entryType]]");
const _startTime = Symbol("[[startTime]]");
const _duration = Symbol("[[duration]]");
class PerformanceEntry {
  [_name] = "";
  [_entryType] = "";
  [_startTime] = 0;
  [_duration] = 0;

  get name() {
    webidl.assertBranded(this, PerformanceEntryPrototype);
    return this[_name];
  }

  get entryType() {
    webidl.assertBranded(this, PerformanceEntryPrototype);
    return this[_entryType];
  }

  get startTime() {
    webidl.assertBranded(this, PerformanceEntryPrototype);
    return this[_startTime];
  }

  get duration() {
    webidl.assertBranded(this, PerformanceEntryPrototype);
    return this[_duration];
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
    this[webidl.brand] = webidl.brand;

    this[_name] = name;
    this[_entryType] = entryType;
    this[_startTime] = startTime;
    this[_duration] = duration;
  }

  toJSON() {
    webidl.assertBranded(this, PerformanceEntryPrototype);
    return {
      name: this[_name],
      entryType: this[_entryType],
      startTime: this[_startTime],
      duration: this[_duration],
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

const _detail = Symbol("[[detail]]");
class PerformanceMark extends PerformanceEntry {
  [_detail] = null;

  get detail() {
    webidl.assertBranded(this, PerformanceMarkPrototype);
    return this[_detail];
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
    this[webidl.brand] = webidl.brand;
    if (startTime < 0) {
      throw new TypeError(
        `Cannot construct PerformanceMark: startTime cannot be negative, received ${startTime}`,
      );
    }
    this[_detail] = getStructuredClone()(detail);
  }

  toJSON() {
    webidl.assertBranded(this, PerformanceMarkPrototype);
    return {
      name: this.name,
      entryType: this.entryType,
      startTime: this.startTime,
      duration: this.duration,
      detail: this.detail,
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
class PerformanceMeasure extends PerformanceEntry {
  [_detail] = null;

  get detail() {
    webidl.assertBranded(this, PerformanceMeasurePrototype);
    return this[_detail];
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
    this[webidl.brand] = webidl.brand;
    this[_detail] = getStructuredClone()(detail);
  }

  toJSON() {
    webidl.assertBranded(this, PerformanceMeasurePrototype);
    return {
      name: this.name,
      entryType: this.entryType,
      startTime: this.startTime,
      duration: this.duration,
      detail: this.detail,
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

function scheduleObserverCallback(observer) {
  if (observer[_scheduled]) {
    return;
  }
  observer[_scheduled] = true;
  queueObserverTask(() => {
    observer[_scheduled] = false;
    const entries = observer[_buffer];
    observer[_buffer] = [];
    if (entries.length > 0) {
      const entryList = new PerformanceObserverEntryList(
        sortedEntries(entries),
        illegalConstructorKey,
      );
      try {
        observer[_callback].call(observer, entryList, observer, { droppedEntriesCount: 0 });
      } catch (error) {
        reportObserverError(error, observer[_callback]);
      }
    }
  });
}

function queuePerformanceEntry(entry) {
  for (let i = 0; i < performanceObservers.length; i++) {
    const observer = performanceObservers[i];
    if (ArrayPrototypeIncludes(observer[_entryTypes], entry.entryType)) {
      ArrayPrototypePush(observer[_buffer], entry);
      scheduleObserverCallback(observer);
    }
  }
}

const _entries = Symbol("[[entries]]");

class PerformanceObserverEntryList {
  [_entries] = [];

  constructor(entries, key = undefined) {
    if (key !== illegalConstructorKey) {
      webidl.illegalConstructor();
    }
    this[webidl.brand] = webidl.brand;
    this[_entries] = entries;
  }

  getEntries() {
    webidl.assertBranded(this, PerformanceObserverEntryListPrototype);
    return sortedEntries(this[_entries]);
  }

  getEntriesByType(type) {
    webidl.assertBranded(this, PerformanceObserverEntryListPrototype);
    const prefix =
      "Failed to execute 'getEntriesByType' on 'PerformanceObserverEntryList'";
    webidl.requiredArguments(arguments.length, 1, prefix);
    type = webidl.converters.DOMString(type, prefix, "Argument 1");
    return ArrayPrototypeFilter(
      this[_entries],
      (entry) => entry.entryType === type,
    );
  }

  getEntriesByName(name, type = undefined) {
    webidl.assertBranded(this, PerformanceObserverEntryListPrototype);
    const prefix =
      "Failed to execute 'getEntriesByName' on 'PerformanceObserverEntryList'";
    webidl.requiredArguments(arguments.length, 1, prefix);
    name = webidl.converters.DOMString(name, prefix, "Argument 1");
    if (type !== undefined) {
      type = webidl.converters.DOMString(type, prefix, "Argument 2");
    }
    return ArrayPrototypeFilter(
      this[_entries],
      (entry) =>
        entry.name === name && (type === undefined || entry.entryType === type),
    );
  }
}
webidl.configureInterface(PerformanceObserverEntryList);
const PerformanceObserverEntryListPrototype =
  PerformanceObserverEntryList.prototype;

const _callback = Symbol("[[callback]]");
const _entryTypes = Symbol("[[entryTypes]]");
const _buffer = Symbol("[[buffer]]");
const _scheduled = Symbol("[[scheduled]]");
const _observerType = Symbol("[[observerType]]");

class PerformanceObserver {
  static get supportedEntryTypes() {
    return supportedEntryTypes;
  }

  [_callback] = null;
  [_entryTypes] = [];
  [_buffer] = [];
  [_scheduled] = false;
  [_observerType] = undefined;

  constructor(callback) {
    const prefix = "Failed to construct 'PerformanceObserver'";
    webidl.requiredArguments(arguments.length, 1, prefix);
    if (typeof callback !== "function") {
      throw new TypeError(
        `${prefix}: The callback provided as parameter 1 is not a function.`,
      );
    }
    this[webidl.brand] = webidl.brand;
    this[_callback] = callback;
  }

  observe(options) {
    webidl.assertBranded(this, PerformanceObserverPrototype);
    const prefix = "Failed to execute 'observe' on 'PerformanceObserver'";

    webidl.requiredArguments(arguments.length, 1, prefix);
    options = options ?? {};
    let { entryTypes, type } = options;

    if (entryTypes !== undefined && type !== undefined) {
      throw new TypeError(
        `${prefix}: Cannot specify both 'entryTypes' and 'type'.`,
      );
    }

    if (entryTypes === undefined && type === undefined) {
      throw new TypeError(
        `${prefix}: Either 'entryTypes' or 'type' must be specified.`,
      );
    }

    const mode = entryTypes !== undefined ? "multiple" : "single";
    if (this[_observerType] !== undefined && this[_observerType] !== mode) {
      throw new DOMException(`${prefix}: Cannot change observer type.`, "InvalidModificationError");
    }
    this[_observerType] = mode;

    let types;
    if (entryTypes !== undefined) {
      entryTypes = webidl.converters["sequence<DOMString>"](entryTypes, prefix, "entryTypes");
      types = ArrayPrototypeFilter(
        entryTypes,
        (t) =>
          ArrayPrototypeIncludes(PerformanceObserver.supportedEntryTypes, t),
      );
      if (types.length === 0) {
        return;
      }
    } else {
      type = webidl.converters.DOMString(type, prefix, "type");
      if (
        !ArrayPrototypeIncludes(PerformanceObserver.supportedEntryTypes, type)
      ) {
        return;
      }
      types = ArrayPrototypeIncludes(this[_entryTypes], type)
        ? this[_entryTypes] : [...this[_entryTypes], type];
    }

    this[_entryTypes] = types;

    if (!ArrayPrototypeIncludes(performanceObservers, this)) {
      ArrayPrototypePush(performanceObservers, this);
    }

    // Per https://w3c.github.io/performance-timeline/#dom-performanceobserver-observe,
    // when the single-type form is used with buffered=true, prepend any
    // already-recorded entries of that type to the observer's buffer.
    if (type !== undefined && options.buffered === true) {
      let appended = false;
      for (let i = 0; i < performanceEntries.length; i++) {
        const entry = performanceEntries[i];
        if (entry.entryType === type) {
          ArrayPrototypePush(this[_buffer], entry);
          appended = true;
        }
      }
      if (appended) {
        scheduleObserverCallback(this);
      }
    }
  }

  disconnect() {
    webidl.assertBranded(this, PerformanceObserverPrototype);
    const index = ArrayPrototypeIndexOf(performanceObservers, this);
    if (index !== -1) {
      ArrayPrototypeSplice(performanceObservers, index, 1);
    }
    this[_entryTypes] = [];
    this[_buffer] = [];
  }

  takeRecords() {
    webidl.assertBranded(this, PerformanceObserverPrototype);
    const records = this[_buffer];
    this[_buffer] = [];
    return records;
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
    this[webidl.brand] = webidl.brand;
  }

  get timeOrigin() {
    webidl.assertBranded(this, PerformancePrototype);
    return timeOrigin;
  }

  clearMarks(markName = undefined) {
    webidl.assertBranded(this, PerformancePrototype);
    if (markName !== undefined) {
      markName = webidl.converters.DOMString(
        markName,
        "Failed to execute 'clearMarks' on 'Performance'",
        "Argument 1",
      );

      performanceEntries = ArrayPrototypeFilter(
        performanceEntries,
        (entry) => !(entry.name === markName && entry.entryType === "mark"),
      );
    } else {
      performanceEntries = ArrayPrototypeFilter(
        performanceEntries,
        (entry) => entry.entryType !== "mark",
      );
    }
  }

  clearMeasures(measureName = undefined) {
    webidl.assertBranded(this, PerformancePrototype);
    if (measureName !== undefined) {
      measureName = webidl.converters.DOMString(
        measureName,
        "Failed to execute 'clearMeasures' on 'Performance'",
        "Argument 1",
      );

      performanceEntries = ArrayPrototypeFilter(
        performanceEntries,
        (entry) =>
          !(entry.name === measureName && entry.entryType === "measure"),
      );
    } else {
      performanceEntries = ArrayPrototypeFilter(
        performanceEntries,
        (entry) => entry.entryType !== "measure",
      );
    }
  }

  clearResourceTimings() {
    webidl.assertBranded(this, PerformancePrototype);
    performanceEntries = ArrayPrototypeFilter(
      performanceEntries,
      (entry) => entry.entryType !== "resource",
    );
    resourceTimingCount = 0;
  }

  setResourceTimingBufferSize(maxSize) {
    webidl.assertBranded(this, PerformancePrototype);
    webidl.requiredArguments(
      arguments.length,
      1,
      "Failed to execute 'setResourceTimingBufferSize' on 'Performance'",
    );
    resourceTimingBufferSize = webidl.converters["unsigned long"](
      maxSize, "Failed to execute 'setResourceTimingBufferSize' on 'Performance'", "Argument 1",
    );
  }

  getEntries() {
    webidl.assertBranded(this, PerformancePrototype);
    return filterByNameType();
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

    return filterByNameType(name, type);
  }

  getEntriesByType(type) {
    webidl.assertBranded(this, PerformancePrototype);
    const prefix = "Failed to execute 'getEntriesByName' on 'Performance'";
    webidl.requiredArguments(arguments.length, 1, prefix);

    type = webidl.converters.DOMString(type, prefix, "Argument 1");

    return filterByNameType(undefined, type);
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

    // 3.1.1.1 If the global object is a Window object and markName uses the
    // same name as a read only attribute in the PerformanceTiming interface,
    // throw a SyntaxError. - not implemented
    const entry = new PerformanceMark(markName, markOptions);
    ArrayPrototypePush(performanceEntries, entry);
    queuePerformanceEntry(entry);
    return entry;
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
    let endTime;
    if (endMark) {
      endTime = convertMarkToTimestamp(endMark);
    } else if (
      typeof startOrMeasureOptions === "object" &&
      ReflectHas(startOrMeasureOptions, "end")
    ) {
      endTime = convertMarkToTimestamp(startOrMeasureOptions.end);
    } else if (
      typeof startOrMeasureOptions === "object" &&
      ReflectHas(startOrMeasureOptions, "start") &&
      ReflectHas(startOrMeasureOptions, "duration")
    ) {
      const start = convertMarkToTimestamp(startOrMeasureOptions.start);
      const duration = convertMarkToTimestamp(startOrMeasureOptions.duration);
      endTime = start + duration;
    } else {
      endTime = now();
    }
    let startTime;
    if (
      typeof startOrMeasureOptions === "object" &&
      ReflectHas(startOrMeasureOptions, "start")
    ) {
      startTime = convertMarkToTimestamp(startOrMeasureOptions.start);
    } else if (
      typeof startOrMeasureOptions === "object" &&
      ReflectHas(startOrMeasureOptions, "end") &&
      ReflectHas(startOrMeasureOptions, "duration")
    ) {
      const end = convertMarkToTimestamp(startOrMeasureOptions.end);
      const duration = convertMarkToTimestamp(startOrMeasureOptions.duration);
      startTime = end - duration;
    } else if (typeof startOrMeasureOptions === "string") {
      startTime = convertMarkToTimestamp(startOrMeasureOptions);
    } else {
      startTime = 0;
    }
    const entry = new PerformanceMeasure(
      measureName,
      startTime,
      endTime - startTime,
      typeof startOrMeasureOptions === "object"
        ? startOrMeasureOptions.detail ?? null
        : null,
      illegalConstructorKey,
    );
    ArrayPrototypePush(performanceEntries, entry);
    queuePerformanceEntry(entry);
    return entry;
  }

  now() {
    webidl.assertBranded(this, PerformancePrototype);
    return now();
  }

  toJSON() {
    webidl.assertBranded(this, PerformancePrototype);
    return {
      timeOrigin: this.timeOrigin,
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
  configurePerformanceTimeline,
  createPerformanceEntry,
  updatePerformanceEntry,
  recordPerformanceEntry,
  queuePerformanceEntry,
};
})();
