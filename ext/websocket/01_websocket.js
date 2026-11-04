// Copyright 2018-2026 the Deno authors. MIT license.

/// <reference path="../../core/internal.d.ts" />

import { core, internals, primordials } from "ext:core/mod.js";
const {
  isAnyArrayBuffer,
  isArrayBuffer,
  internalRidSymbol,
} = core;
import {
  op_ws_initialize,
  op_ws_state,
  op_ws_check_permission_and_cancel_handle,
  op_ws_close,
  op_ws_create,
  op_ws_get_buffer,
  op_ws_get_buffer_as_string,
  op_ws_get_buffered_amount,
  op_ws_get_error,
  op_ws_next_event,
  op_ws_send_binary,
  op_ws_send_binary_ab,
  op_ws_send_ping,
  op_ws_send_text,
} from "ext:core/ops";
const {
  ArrayBufferIsView,
  ArrayIsArray,
  ArrayPrototypeJoin,
  ArrayPrototypePush,
  ArrayPrototypeShift,
  ArrayPrototypeSome,
  DateNow,
  decodeURIComponent,
  Error,
  ErrorPrototypeToString,
  ObjectCreate,
  ObjectDefineProperties,
  ObjectDefineProperty,
  ObjectGetOwnPropertyDescriptor,
  ObjectPrototypeIsPrototypeOf,
  PromisePrototypeCatch,
  PromisePrototypeThen,
  PromiseReject,
  ReflectApply,
  RegExpPrototypeExec,
  SafeSet,
  SetPrototypeGetSize,
  String,
  StringPrototypeEndsWith,
  Symbol,
  SymbolFor,
  SymbolIterator,
  TypedArrayPrototypeGetByteLength,
  TypeError,
} = primordials;

const { URL } = core.loadExtScript("ext:deno_web/00_url.js");
const urlProperties = ObjectCreate(null);
for (const name of ["href", "protocol", "hash", "username", "password"]) {
  urlProperties[name] = ObjectGetOwnPropertyDescriptor(URL.prototype, name);
}
const readURL = (url, name) => ReflectApply(urlProperties[name].get, url, []);
const writeURL = (url, name, value) => ReflectApply(urlProperties[name].set, url, [value]);

// Handshake metadata is a private byte-string list, never a public Headers
// object containing browser-managed credentials. Native op conversion reads its
// own array indices directly and does not invoke JavaScript iterators.
function handshakeHeaderList(previous, prepared, authorization) {
  if (prepared === undefined) return previous;
  const list = [];
  const append = (name, value) => {
    name = byteLowerCase(name);
    const pair = [name, value];
    for (let i = 0; i < list.length; i++) {
      if (list[i][0] === name) { list[i] = pair; return; }
    }
    ObjectDefineProperty(list, list.length, { value: pair, writable: true, configurable: true, enumerable: true });
  };
  if (previous !== null) for (let i = 0; i < previous.length; i++) append(previous[i][0], previous[i][1]);
  if (authorization !== null) append("authorization", "Basic " + authorization);
  for (let i = 0; i < prepared.length; i++) append(prepared[i][0], prepared[i][1]);
  return list;
}

const webidl = core.loadExtScript("ext:deno_webidl/00_webidl.js");
const { createFilteredInspectProxy } = core.loadExtScript(
  "ext:deno_web/01_console.js",
);
const { HTTP_TOKEN_CODE_POINT_RE, byteLowerCase, forgivingBase64Encode } = core
  .loadExtScript(
    "ext:deno_web/00_infra.js",
  );
const { DOMException } = core.loadExtScript("ext:deno_web/01_dom_exception.js");
const {
  CloseEvent,
  defineEventHandler,
  dispatch,
  ErrorEvent,
  Event,
  EventTarget,
  MessageEvent,
  setIsTrusted,
} = core.loadExtScript("ext:deno_web/02_event.js");
const { Blob, BlobPrototype } = core.loadExtScript("ext:deno_web/09_file.js");
const { getLocationHref } = core.loadExtScript("ext:deno_web/12_location.js");
const {
  fillHeaders,
  headerListFromHeaders,
  headersFromHeaderList,
} = core.loadExtScript("ext:deno_fetch/20_headers.js");
const { HttpClientPrototype } = core.loadExtScript(
  "ext:deno_fetch/22_http_client.js",
);

const kNodeUndiciDispatcherOptions = SymbolFor(
  "Deno.internal.node.undici.dispatcherOptions",
);
const kNodeUndiciGlobalDispatcher = SymbolFor(
  "Deno.internal.node.undici.globalDispatcher",
);

webidl.converters["WebSocketInit"] = webidl.createDictionaryConverter(
  "WebSocketInit",
  [
    {
      key: "headers",
      converter: webidl.converters["HeadersInit"],
    },
    {
      key: "protocols",
      converter: webidl.converters["sequence<DOMString>"],
    },
    { key: "client", converter: webidl.converters.any },
    { key: "dispatcher", converter: webidl.converters.any },
  ],
);

webidl.converters["WebSocketInit or sequence<DOMString> or DOMString"] = (
  V,
  prefix,
  context,
  opts,
) => {
  // Union for (WebSocketInit or sequence<DOMString> or DOMString)
  if (V === null || V === undefined) {
    return webidl.converters["WebSocketInit"](V, prefix, context, opts);
  }
  if (webidl.type(V) === "Object" && V !== null) {
    if (V[SymbolIterator] !== undefined) {
      return webidl.converters["sequence<DOMString>"](V, prefix, context, opts);
    }
    return webidl.converters["WebSocketInit"](V, prefix, context, opts);
  }
  return webidl.converters.DOMString(V, prefix, context, opts);
};

webidl.converters["WebSocketSend"] = (V, prefix, context, opts) => {
  // Union for (Blob or ArrayBufferView or ArrayBuffer or USVString)
  if (ObjectPrototypeIsPrototypeOf(BlobPrototype, V)) {
    return webidl.converters["Blob"](V, prefix, context, opts);
  }
  if (typeof V === "object") {
    if (isAnyArrayBuffer(V)) {
      return webidl.converters["ArrayBuffer"](V, prefix, context, opts);
    }
    if (ArrayBufferIsView(V)) {
      return webidl.converters["ArrayBufferView"](V, prefix, context, opts);
    }
  }
  return webidl.converters["USVString"](V, prefix, context, opts);
};

/** role */
const SERVER = 0;
const CLIENT = 1;

/** state */
const CONNECTING = 0;
const OPEN = 1;
const CLOSING = 2;
const CLOSED = 3;

const _readyState = Symbol("[[readyState]]");
const _url = Symbol("[[url]]");
const _rid = Symbol("[[rid]]");
const _role = Symbol("[[role]]");
const _extensions = Symbol("[[extensions]]");
const _protocol = Symbol("[[protocol]]");
const _binaryType = Symbol("[[binaryType]]");
const _eventLoop = Symbol("[[eventLoop]]");
const _sendQueue = Symbol("[[sendQueue]]");
const _queueSend = Symbol("[[queueSend]]");
const _cancelHandle = Symbol("[[cancelHandle]]");

const _idleTimeoutDuration = Symbol("[[idleTimeout]]");
const _idleTimeoutTimeout = Symbol("[[idleTimeoutTimeout]]");
const _serverHandleIdleTimeout = Symbol("[[serverHandleIdleTimeout]]");

// Inspector Network domain instrumentation. The bridge is installed by
// `ext/node/polyfills/inspector.js` on `internals.__inspectorNetwork` when
// `node:inspector` is loaded; it stays null in normal runs so the cost is
// one method call per WebSocket lifecycle.
const _inspectorRequestId = Symbol("[[inspectorRequestId]]");

function getInspectorNetwork() {
  const ins = internals.__inspectorNetwork;
  if (ins && ins.isEnabled()) return ins;
  return null;
}

function emitWebSocketClosed(ws) {
  const ins = getInspectorNetwork();
  const requestId = socketState(ws).inspectorRequestId;
  if (ins === null || requestId === undefined) return;
  try {
    ins.webSocketClosed({
      requestId,
      timestamp: DateNow() / 1000,
    });
  } catch {
    // never let inspector instrumentation break a real WebSocket
  }
  socketState(ws).inspectorRequestId = undefined;
}

// Opcodes per RFC 6455 / CDP `WebSocketFrame.opcode`:
// 1 = text, 2 = binary. Per RFC 6455 client-to-server frames are masked,
// server-to-client are not - so the `mask` flag depends on direction and
// role: a CLIENT socket masks what it sends, a SERVER socket sees masked
// frames coming in.
function emitWebSocketFrame(ws, eventName, opcode, payloadData) {
  const ins = getInspectorNetwork();
  const requestId = socketState(ws).inspectorRequestId;
  if (ins === null || requestId === undefined) return;
  const sent = eventName === "frameSent";
  const mask = socketState(ws).role === SERVER ? !sent : sent;
  try {
    const params = {
      requestId,
      timestamp: DateNow() / 1000,
      response: { opcode, mask, payloadData },
    };
    if (sent) ins.webSocketFrameSent(params);
    else ins.webSocketFrameReceived(params);
  } catch {
    // never let inspector instrumentation break a real WebSocket
  }
}

// Called by ext/http's `upgradeWebSocket` after a successful handshake, so
// server-accepted sockets show up in the inspector's Network panel and
// the frame emitters in `_eventLoop` / `send` start firing for them.
// Handshake events (`willSendHandshakeRequest`, `handshakeResponseReceived`)
// are intentionally skipped here - those are client-side concepts.
function installServerInspector(ws, url) {
  const ins = getInspectorNetwork();
  if (ins === null) return;
  const requestId = ins.nextRequestId();
  socketState(ws).inspectorRequestId = requestId;
  try {
    ins.webSocketCreated({ requestId, url });
  } catch {
    // never let inspector instrumentation break a real WebSocket
  }
}

function emitWebSocketFrameError(ws, errorMessage) {
  const ins = getInspectorNetwork();
  const requestId = socketState(ws).inspectorRequestId;
  if (ins === null || requestId === undefined) return;
  try {
    ins.webSocketFrameError({
      requestId,
      timestamp: DateNow() / 1000,
      errorMessage,
    });
  } catch {
    // never let inspector instrumentation break a real WebSocket
  }
}

// Embedder policy stays private to the extension module. Browser embedders can
// supply their real origin, cookies and connect policy without exposing Deno's
// nonstandard constructor options to page scripts.
const socketState = op_ws_state;
let handshakeHooks = null;
function setWebSocketHandshakeHooks(hooks) {
  handshakeHooks = hooks;
}

function markSocketClosed(socket) {
  socketState(socket).readyState = CLOSED;
  handshakeHooks?.closed?.(socket);
}

function dispatchWebSocketEvent(socket, event) {
  setIsTrusted(event, true);
  dispatch(socket, event);
}

function socketError(error, message = ErrorPrototypeToString(error)) {
  return handshakeHooks === null
    ? new ErrorEvent("error", { error, message })
    : new Event("error");
}

function failedCloseEvent() {
  return new CloseEvent("close", handshakeHooks === null ? {} : { code: 1006 });
}

// User-agent teardown releases the actual transport/cancellation resources.
function disposeWebSocket(socket) {
  if (socketState(socket).cancelHandle !== undefined) core.tryClose(socketState(socket).cancelHandle);
  if (socketState(socket).rid !== undefined) core.tryClose(socketState(socket).rid);
  socketState(socket).cancelHandle = undefined;
  socketState(socket).rid = undefined;
  markSocketClosed(socket);
}

class WebSocket extends EventTarget {
  constructor(url, initOrProtocols) {
    super();
    op_ws_initialize(this, ObjectCreate(null));
    this[webidl.brand] = webidl.brand;
    socketState(this).rid = undefined;
    socketState(this).role = undefined;
    socketState(this).readyState = CONNECTING;
    socketState(this).extensions = "";
    socketState(this).protocol = "";
    socketState(this).url = "";
    socketState(this).binaryType = "blob";
    socketState(this).idleTimeoutDuration = 0;
    socketState(this).idleTimeoutTimeout = undefined;
    socketState(this).sendQueue = [];
    socketState(this).cancelHandle = undefined;

    const prefix = "Failed to construct 'WebSocket'";
    webidl.requiredArguments(arguments.length, 1, prefix);
    url = webidl.converters.USVString(url, prefix, "Argument 1");
    initOrProtocols = webidl.converters
      ["WebSocketInit or sequence<DOMString> or DOMString"](
        initOrProtocols,
        prefix,
        "Argument 2",
      );

    let wsURL;

    try {
      wsURL = new URL(url, getLocationHref());
    } catch (e) {
      throw new DOMException(e.message, "SyntaxError");
    }

    if (readURL(wsURL, "protocol") === "http:") {
      writeURL(wsURL, "protocol", "ws:");
    } else if (readURL(wsURL, "protocol") === "https:") {
      writeURL(wsURL, "protocol", "wss:");
    }

    if (readURL(wsURL, "protocol") !== "ws:" && readURL(wsURL, "protocol") !== "wss:") {
      throw new DOMException(
        `Only ws & wss schemes are allowed in a WebSocket URL: received ${readURL(wsURL, "protocol")}`,
        "SyntaxError",
      );
    }

    if (readURL(wsURL, "hash") !== "" || StringPrototypeEndsWith(readURL(wsURL, "href"), "#")) {
      throw new DOMException(
        "Fragments are not allowed in a WebSocket URL",
        "SyntaxError",
      );
    }

    // WHATWG WebSocket: credentials in the URL userinfo are sent as an
    // `Authorization: Basic` header during the handshake and then stripped
    // from the URL exposed via `url`. This matches browser behavior.
    let urlCredentials = null;
    if (readURL(wsURL, "username") !== "" || readURL(wsURL, "password") !== "") {
      urlCredentials = forgivingBase64Encode(
        core.encode(
          `${decodeURIComponent(readURL(wsURL, "username"))}:${
            decodeURIComponent(readURL(wsURL, "password"))
          }`,
        ),
      );
      writeURL(wsURL, "username", "");
      writeURL(wsURL, "password", "");
    }

    const requestURL = readURL(wsURL, "href");
    socketState(this).url = requestURL;
    socketState(this).role = CLIENT;

    let protocols;
    let headers = null;
    let clientRid = null;
    let caCerts = null;
    let unsafelyIgnoreCertificateErrors = false;

    if (typeof initOrProtocols === "string") {
      protocols = [initOrProtocols];
    } else if (ArrayIsArray(initOrProtocols)) {
      protocols = initOrProtocols;
    } else {
      protocols = initOrProtocols.protocols || [];

      if (initOrProtocols.headers !== undefined) {
        headers = headersFromHeaderList([], "request");
        fillHeaders(headers, initOrProtocols.headers);
      }

      // NOTE: non standard extension. This handles Deno.HttpClient parameter
      if (initOrProtocols.client !== undefined) {
        if (
          initOrProtocols.client !== null &&
          !ObjectPrototypeIsPrototypeOf(
            HttpClientPrototype,
            initOrProtocols.client,
          )
        ) {
          throw webidl.makeException(
            TypeError,
            "`client` must be a Deno.HttpClient",
            prefix,
            "Argument 2",
          );
        }
        clientRid = initOrProtocols.client?.[internalRidSymbol] ?? null;
      }

      let dispatcher = initOrProtocols.dispatcher;
      if (
        dispatcher === undefined &&
        internals[kNodeUndiciGlobalDispatcher] !== undefined
      ) {
        dispatcher = internals[kNodeUndiciGlobalDispatcher];
      }

      if (clientRid === null && dispatcher !== undefined) {
        clientRid = dispatcher?.client?.[internalRidSymbol] ?? null;
        const dispatcherOptions = dispatcher?.[kNodeUndiciDispatcherOptions];
        if (dispatcherOptions !== undefined) {
          caCerts = dispatcherOptions.caCerts ?? null;
          unsafelyIgnoreCertificateErrors =
            dispatcherOptions.unsafelyIgnoreCertificateErrors === true;
        }
      }
    }

    // Apply URL-derived Basic credentials. An explicit `Authorization` header
    // in `init.headers` takes precedence over the URL userinfo.
    if (urlCredentials !== null && handshakeHooks === null) {
      if (headers === null) {
        headers = headersFromHeaderList([], "request");
      }
      if (headers.get("Authorization") === null) {
        headers.set("Authorization", `Basic ${urlCredentials}`);
      }
    }

    if (
      protocols.length !==
        SetPrototypeGetSize(
          new SafeSet(protocols),
        )
    ) {
      throw new DOMException(
        "Cannot supply the same protocol multiple times",
        "SyntaxError",
      );
    }

    if (
      ArrayPrototypeSome(
        protocols,
        (protocol) =>
          RegExpPrototypeExec(HTTP_TOKEN_CODE_POINT_RE, protocol) === null,
      )
    ) {
      throw new DOMException(
        "Invalid protocol value",
        "SyntaxError",
      );
    }

    const preparation = handshakeHooks?.prepare(requestURL);
    const handshakeHeaders = handshakeHeaderList(
      headers ? headerListFromHeaders(headers) : null,
      preparation?.headers,
      handshakeHooks === null ? null : urlCredentials,
    );
    const cancelRid = preparation?.blocked ? undefined : op_ws_check_permission_and_cancel_handle(
      "WebSocket.abort()",
      socketState(this).url,
      true,
    );

    socketState(this).cancelHandle = cancelRid;

    // Inspector: emit `Network.webSocketCreated` before initiating the
    // handshake. The op call itself reaches deep into Rust async work, so
    // we want the "we're attempting this URL" notification to fire even if
    // the handshake later fails.
    const inspectorNetwork = getInspectorNetwork();
    if (inspectorNetwork !== null) {
      const requestId = inspectorNetwork.nextRequestId();
      socketState(this).inspectorRequestId = requestId;
      try {
        inspectorNetwork.webSocketCreated({
          requestId,
          url: socketState(this).url,
          // initiator is filled in by the inspector op using V8's stack.
        });
      } catch {
        // ignore
      }
      // `Network.webSocketWillSendHandshakeRequest` populates DevTools'
      // "Headers" panel for the request side. Tungstenite-generated headers
      // (Sec-WebSocket-Key, Sec-WebSocket-Version, Upgrade, Connection) are
      // produced in Rust and not visible here; we surface what JS knows -
      // user-supplied headers via `init.headers` plus the negotiated
      // Sec-WebSocket-Protocol. That's enough for the panel to show the
      // intent of the request; the response panel still gets the real
      // server-sent headers via `webSocketHandshakeResponseReceived`.
      const requestHeaders = { __proto__: null };
      if (headers !== null) {
        const list = headerListFromHeaders(headers);
        for (let i = 0; i < list.length; i++) {
          const name = byteLowerCase(list[i][0]);
          const value = list[i][1];
          if (requestHeaders[name] === undefined) {
            requestHeaders[name] = value;
          } else {
            requestHeaders[name] = requestHeaders[name] + ", " + value;
          }
        }
      }
      if (protocols.length > 0) {
        requestHeaders["sec-websocket-protocol"] = ArrayPrototypeJoin(
          protocols,
          ", ",
        );
      }
      try {
        inspectorNetwork.webSocketWillSendHandshakeRequest({
          requestId,
          timestamp: DateNow() / 1000,
          wallTime: DateNow() / 1000,
          request: {
            headers: requestHeaders,
          },
        });
      } catch {
        // ignore
      }
    }

    PromisePrototypeThen(
      preparation?.blocked ? PromiseReject(new DOMException("WebSocket blocked by connect policy", "NetworkError")) : op_ws_create(
        "new WebSocket()",
        requestURL,
        ArrayPrototypeJoin(protocols, ", "),
        cancelRid,
        handshakeHeaders,
        caCerts,
        unsafelyIgnoreCertificateErrors,
        clientRid,
      ),
      (create) => {
        if (socketState(this).readyState === CLOSED) {
          core.tryClose(create.rid);
          return;
        }
        handshakeHooks?.response(requestURL, create.headers);
        socketState(this).rid = create.rid;
        socketState(this).extensions = create.extensions;
        socketState(this).protocol = create.protocol;

        // Inspector: emit `Network.webSocketHandshakeResponseReceived` with
        // the real upgrade response (status, statusText, headers) returned
        // by the Rust op.
        const reqId = socketState(this).inspectorRequestId;
        if (reqId !== undefined) {
          const ins = getInspectorNetwork();
          if (ins !== null) {
            const responseHeaders = { __proto__: null };
            for (let i = 0; i < create.headers.length; i++) {
              const name = byteLowerCase(create.headers[i][0]);
              const value = create.headers[i][1];
              if (responseHeaders[name] === undefined) {
                responseHeaders[name] = value;
              } else {
                // Connection, Upgrade etc. shouldn't repeat, but be defensive.
                responseHeaders[name] = responseHeaders[name] + ", " + value;
              }
            }
            try {
              ins.webSocketHandshakeResponseReceived({
                requestId: reqId,
                timestamp: DateNow() / 1000,
                response: {
                  status: create.status,
                  statusText: create.statusText,
                  headers: responseHeaders,
                },
              });
            } catch {
              // ignore
            }
          }
        }

        if (socketState(this).readyState === CLOSING) {
          PromisePrototypeThen(
            op_ws_close(socketState(this).rid),
            () => {
              markSocketClosed(this);

              const errEvent = socketError(new Error("WebSocket closed before opening"));
              dispatchWebSocketEvent(this, errEvent);

              emitWebSocketClosed(this);
              const event = failedCloseEvent();
              dispatchWebSocketEvent(this, event);
              core.tryClose(socketState(this).rid);
            },
          );
        } else {
          socketState(this).readyState = OPEN;
          const event = new Event("open");
          dispatchWebSocketEvent(this, event);

          ReflectApply(eventLoopImpl, this, []);
        }
      },
      (err) => {
        if (socketState(this).readyState === CLOSED) return;
        markSocketClosed(this);

        const errorEv = socketError(err);
        dispatchWebSocketEvent(this, errorEv);

        if (socketState(this).cancelHandle) {
          core.tryClose(socketState(this).cancelHandle);

          socketState(this).cancelHandle = undefined;
        }

        // A policy refusal happens before a transport is opened. Chromium
        // reports its error without a transport close event in this case.
        if (preparation?.blocked) return;

        emitWebSocketClosed(this);
        const closeEv = failedCloseEvent();
        dispatchWebSocketEvent(this, closeEv);
      },
    );
  }

  get readyState() {
    socketState(this);
    return socketState(this).readyState;
  }

  get extensions() {
    socketState(this);
    return socketState(this).extensions;
  }

  get protocol() {
    socketState(this);
    return socketState(this).protocol;
  }

  get url() {
    socketState(this);
    return socketState(this).url;
  }

  get binaryType() {
    socketState(this);
    return socketState(this).binaryType;
  }
  set binaryType(value) {
    socketState(this);
    value = webidl.converters.DOMString(
      value,
      "Failed to set 'binaryType' on 'WebSocket'",
    );
    if (value === "blob" || value === "arraybuffer") {
      socketState(this).binaryType = value;
    }
  }

  get bufferedAmount() {
    socketState(this);
    if (socketState(this).readyState === OPEN) {
      return op_ws_get_buffered_amount(socketState(this).rid);
    } else {
      return 0;
    }
  }

  send(data) {
    socketState(this);
    const prefix = "Failed to execute 'send' on 'WebSocket'";

    webidl.requiredArguments(arguments.length, 1, prefix);
    data = webidl.converters.WebSocketSend(data, prefix, "Argument 1");

    if (socketState(this).readyState === CONNECTING) {
      throw new DOMException("'readyState' not OPEN", "InvalidStateError");
    }

    if (socketState(this).readyState !== OPEN) {
      return;
    }

    if (socketState(this).sendQueue.length === 0) {
      // Fast path if the send queue is empty, for example when only synchronous
      // data is being sent.
      if (ArrayBufferIsView(data)) {
        op_ws_send_binary(socketState(this).rid, data);
        emitWebSocketFrame(this, "frameSent", 2, data);
      } else if (isArrayBuffer(data)) {
        op_ws_send_binary_ab(socketState(this).rid, data);
        emitWebSocketFrame(this, "frameSent", 2, data);
      } else if (ObjectPrototypeIsPrototypeOf(BlobPrototype, data)) {
        ReflectApply(queueSendImpl, this, [data]);
      } else {
        const string = String(data);
        op_ws_send_text(
          socketState(this).rid,
          string,
        );
        emitWebSocketFrame(this, "frameSent", 1, string);
      }
    } else {
      // Slower path if the send queue is not empty, for example when sending
      // asynchronous data like a Blob.
      ReflectApply(queueSendImpl, this, [data]);
    }
  }

  close(code = undefined, reason = undefined) {
    socketState(this);
    const prefix = "Failed to execute 'close' on 'WebSocket'";

    if (code !== undefined) {
      code = webidl.converters["unsigned short"](code, prefix, "Argument 1", {
        clamp: true,
      });
    }

    if (reason !== undefined) {
      reason = webidl.converters.USVString(reason, prefix, "Argument 2");
    }

    if (socketState(this).role === CLIENT) {
      if (
        code !== undefined &&
        !(code === 1000 || (3000 <= code && code < 5000))
      ) {
        throw new DOMException(
          `The close code must be either 1000 or in the range of 3000 to 4999: received ${code}`,
          "InvalidAccessError",
        );
      }
    }

    if (
      reason !== undefined &&
      TypedArrayPrototypeGetByteLength(core.encode(reason)) > 123
    ) {
      throw new DOMException(
        "The close reason may not be longer than 123 bytes",
        "SyntaxError",
      );
    }

    if (socketState(this).cancelHandle) {
      // Cancel ongoing handshake.
      core.tryClose(socketState(this).cancelHandle);

      socketState(this).cancelHandle = undefined;
    }

    if (socketState(this).readyState === CONNECTING) {
      socketState(this).readyState = CLOSING;
    } else if (socketState(this).readyState === OPEN) {
      socketState(this).readyState = CLOSING;

      PromisePrototypeCatch(
        op_ws_close(
          socketState(this).rid,
          code,
          reason,
        ),
        (err) => {
          markSocketClosed(this);

          const errorEv = socketError(err);
          dispatchWebSocketEvent(this, errorEv);

          emitWebSocketClosed(this);
          const closeEv = failedCloseEvent();
          dispatchWebSocketEvent(this, closeEv);
          core.tryClose(socketState(this).rid);
        },
      );
    }
  }

  async [_eventLoop]() {
    const rid = socketState(this).rid;
    while (socketState(this).readyState !== CLOSED) {
      const kind = await op_ws_next_event(rid);
      if (socketState(this).readyState === CLOSED) break;
      /* close the connection if read was cancelled, and we didn't get a close frame */
      if (
        (socketState(this).readyState == CLOSING) &&
        kind <= 3 && socketState(this).role !== CLIENT
      ) {
        markSocketClosed(this);

        emitWebSocketClosed(this);
        const event = new CloseEvent("close");
        dispatchWebSocketEvent(this, event);
        core.tryClose(rid);
        break;
      }

      switch (kind) {
        case 0: {
          /* string */
          const data = op_ws_get_buffer_as_string(rid);
          if (data === undefined) {
            break;
          }

          ReflectApply(idleTimeoutImpl, this, []);
          emitWebSocketFrame(this, "frameReceived", 1, data);
          const event = new MessageEvent("message", {
            data,
            origin: socketState(this).url,
          });
          setIsTrusted(event, true);
          dispatch(this, event);
          break;
        }
        case 1: {
          /* binary */
          const d = op_ws_get_buffer(rid);
          if (d == undefined) {
            break;
          }

          ReflectApply(idleTimeoutImpl, this, []);
          // deno-lint-ignore deno-internal/prefer-primordials
          const buffer = d.buffer;
          emitWebSocketFrame(this, "frameReceived", 2, buffer);
          let data;
          if (this.binaryType === "blob") {
            data = new Blob([buffer]);
          } else {
            data = buffer;
          }

          const event = new MessageEvent("message", {
            data,
            origin: socketState(this).url,
          });
          setIsTrusted(event, true);
          dispatch(this, event);
          break;
        }
        case 2: {
          /* pong */
          ReflectApply(idleTimeoutImpl, this, []);
          break;
        }
        case 3: {
          /* error */
          markSocketClosed(this);

          const message = op_ws_get_error(rid);
          emitWebSocketFrameError(this, message);
          const error = new Error(message);
          const errorEv = socketError(error, message);
          dispatchWebSocketEvent(this, errorEv);

          emitWebSocketClosed(this);
          const closeEv = failedCloseEvent();
          dispatchWebSocketEvent(this, closeEv);
          core.tryClose(rid);
          break;
        }
        default: {
          /* close */
          const code = kind;
          const reason = code == 1005 ? "" : op_ws_get_error(rid);
          const prevState = socketState(this).readyState;
          markSocketClosed(this);
          if (socketState(this).idleTimeoutTimeout) {
            core.cancelTimer(socketState(this).idleTimeoutTimeout);
          }

          if (prevState === OPEN) {
            try {
              await op_ws_close(
                rid,
                code,
                reason,
              );
            } catch {
              // ignore failures
            }
          }

          emitWebSocketClosed(this);
          const event = new CloseEvent("close", {
            wasClean: true,
            code: code,
            reason,
          });
          dispatchWebSocketEvent(this, event);
          core.tryClose(rid);
          break;
        }
      }
    }
  }

  async [_queueSend](data) {
    const queue = socketState(this).sendQueue;

    ArrayPrototypePush(queue, data);

    if (queue.length > 1) {
      // There is already a send in progress, so we just push to the queue
      // and let that task handle sending of this data.
      return;
    }

    while (queue.length > 0) {
      const data = queue[0];
      if (ArrayBufferIsView(data)) {
        op_ws_send_binary(socketState(this).rid, data);
        emitWebSocketFrame(this, "frameSent", 2, data);
      } else if (isArrayBuffer(data)) {
        op_ws_send_binary_ab(socketState(this).rid, data);
        emitWebSocketFrame(this, "frameSent", 2, data);
      } else if (ObjectPrototypeIsPrototypeOf(BlobPrototype, data)) {
        // deno-lint-ignore deno-internal/prefer-primordials
        const ab = await data.slice().arrayBuffer();
        op_ws_send_binary_ab(socketState(this).rid, ab);
        emitWebSocketFrame(this, "frameSent", 2, ab);
      } else {
        const string = String(data);
        op_ws_send_text(
          socketState(this).rid,
          string,
        );
        emitWebSocketFrame(this, "frameSent", 1, string);
      }
      ArrayPrototypeShift(queue);
    }
  }

  [_serverHandleIdleTimeout]() {
    if (socketState(this).idleTimeoutDuration) {
      if (socketState(this).idleTimeoutTimeout) {
        core.cancelTimer(socketState(this).idleTimeoutTimeout);
      }
      socketState(this).idleTimeoutTimeout = core.createSystemTimer(
        async () => {
          if (socketState(this).readyState === OPEN) {
            await PromisePrototypeCatch(op_ws_send_ping(socketState(this).rid), () => {});
            socketState(this).idleTimeoutTimeout = core.createSystemTimer(
              async () => {
                if (socketState(this).readyState === OPEN) {
                  socketState(this).readyState = CLOSING;
                  const reason = "No response from ping frame.";
                  await PromisePrototypeCatch(
                    op_ws_close(socketState(this).rid, 1001, reason),
                    () => {},
                  );
                  markSocketClosed(this);

                  const errEvent = new ErrorEvent("error", {
                    message: reason,
                  });
                  dispatchWebSocketEvent(this, errEvent);

                  const event = new CloseEvent("close", {
                    wasClean: false,
                    code: 1001,
                    reason,
                  });
                  dispatchWebSocketEvent(this, event);
                  core.tryClose(socketState(this).rid);
                } else {
                  if (socketState(this).idleTimeoutTimeout) {
                    core.cancelTimer(socketState(this).idleTimeoutTimeout);
                  }
                }
              },
              (socketState(this).idleTimeoutDuration / 2) * 1000,
              true,
            );
          } else {
            if (socketState(this).idleTimeoutTimeout) {
              core.cancelTimer(socketState(this).idleTimeoutTimeout);
            }
          }
        },
        (socketState(this).idleTimeoutDuration / 2) * 1000,
        true,
      );
    }
  }

  [SymbolFor("Deno.privateCustomInspect")](inspect, inspectOptions) {
    return inspect(
      createFilteredInspectProxy({
        object: this,
        evaluate: ObjectPrototypeIsPrototypeOf(WebSocketPrototype, this),
        keys: [
          "url",
          "readyState",
          "extensions",
          "protocol",
          "binaryType",
          "bufferedAmount",
          "onmessage",
          "onerror",
          "onclose",
          "onopen",
        ],
      }),
      inspectOptions,
    );
  }
}

ObjectDefineProperties(WebSocket, {
  CONNECTING: {
    __proto__: null,
    value: 0,
    enumerable: true,
  },
  OPEN: {
    __proto__: null,
    value: 1,
    enumerable: true,
  },
  CLOSING: {
    __proto__: null,
    value: 2,
    enumerable: true,
  },
  CLOSED: {
    __proto__: null,
    value: 3,
    enumerable: true,
  },
});

defineEventHandler(WebSocket.prototype, "message");
defineEventHandler(WebSocket.prototype, "error");
defineEventHandler(WebSocket.prototype, "close");
defineEventHandler(WebSocket.prototype, "open");

webidl.configureInterface(WebSocket);
const WebSocketPrototype = WebSocket.prototype;
const queueSendImpl = WebSocketPrototype[_queueSend];
const eventLoopImpl = WebSocketPrototype[_eventLoop];
const idleTimeoutImpl = WebSocketPrototype[_serverHandleIdleTimeout];
for (const [symbol, field] of [
  [_rid, "rid"],
  [_role, "role"],
  [_readyState, "readyState"],
  [_extensions, "extensions"],
  [_protocol, "protocol"],
  [_url, "url"],
  [_binaryType, "binaryType"],
  [_sendQueue, "sendQueue"],
  [_cancelHandle, "cancelHandle"],
  [_idleTimeoutDuration, "idleTimeoutDuration"],
  [_idleTimeoutTimeout, "idleTimeoutTimeout"],
  [_inspectorRequestId, "inspectorRequestId"],
]) {
  const serverState = (socket) => {
    const state = socketState(socket);
    if (state.role !== SERVER) throw new TypeError("Server WebSocket state is not available on a client");
    return state;
  };
  ObjectDefineProperties(WebSocketPrototype, {
    [symbol]: {
      get() { return serverState(this)[field]; },
      set(value) { serverState(this)[field] = value; },
      configurable: true,
    },
  });
}

for (const [name, value] of [["CONNECTING", CONNECTING], ["OPEN", OPEN], ["CLOSING", CLOSING], ["CLOSED", CLOSED]]) {
  ObjectDefineProperties(WebSocketPrototype, {
    [name]: {value, enumerable: true},
  });
}

function createWebSocketBranded() {
  const socket = webidl.createBranded(WebSocket);
  op_ws_initialize(socket, ObjectCreate(null));
  socketState(socket).rid = undefined;
  socketState(socket).role = SERVER;
  socketState(socket).readyState = CONNECTING;
  socketState(socket).extensions = "";
  socketState(socket).protocol = "";
  socketState(socket).url = "";
  // We use ArrayBuffer for server websockets for backwards compatibility
  // and performance reasons.
  //
  // https://github.com/denoland/deno/issues/15340#issuecomment-1872353134
  socketState(socket).binaryType = "arraybuffer";
  socketState(socket).idleTimeoutDuration = 0;
  socketState(socket).idleTimeoutTimeout = undefined;
  socketState(socket).sendQueue = [];
  return socket;
}

export {
  _eventLoop,
  _idleTimeoutDuration,
  _idleTimeoutTimeout,
  _protocol,
  _readyState,
  _rid,
  _role,
  _serverHandleIdleTimeout,
  CLIENT,
  createWebSocketBranded,
  disposeWebSocket,
  emitWebSocketClosed,
  installServerInspector,
  SERVER,
  setWebSocketHandshakeHooks,
  WebSocket,
};
