// Copyright 2018-2026 the Deno authors. MIT license.

use std::future::poll_fn;
use std::rc::Rc;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::Ordering;
use std::task::Context;
use std::task::Poll;
use std::task::Waker;

use crate::JsRealm;
use crate::JsRuntime;
use crate::JsRuntimeForSnapshot;
use crate::OpState;
use crate::RuntimeOptions;
use crate::error::CoreErrorKind;
use crate::error::ExtensionLazyInitCountMismatchError;
use crate::error::ExtensionLazyInitOrderMismatchError;
use crate::event_loop::V8CloseCallback;
use crate::modules::StaticModuleLoader;
use crate::op2;

/// Evaluates `expr` in `realm` and panics if it isn't truthy.
fn assert_js(runtime: &mut JsRuntime, realm: &JsRealm, expr: &str) {
  realm
    .execute_script(
      runtime.v8_isolate(),
      "assert.js",
      format!("if (!({expr})) throw new Error({expr:?});"),
    )
    .unwrap();
}

#[tokio::test]
async fn test_two_realms() {
  #[op2]
  async fn op_yield() {
    tokio::task::yield_now().await;
  }

  deno_core::extension!(test_ext, ops = [op_yield]);
  let mut runtime = JsRuntime::new(RuntimeOptions {
    extensions: vec![test_ext::init()],
    ..Default::default()
  });
  let realms = [
    (runtime.main_realm(), 1),
    (runtime.new_realm(Default::default()).unwrap(), 2),
  ];
  let mut evaluations = Vec::new();

  for (realm, value) in &realms {
    let id = realm
      .load_side_es_module_from_code(
        runtime.v8_isolate(),
        "file:///test.js".into(),
        Some(
          format!(
            "globalThis.value = {value}; \
             await Deno.core.ops.op_yield(); value += 1;"
          )
          .into(),
        ),
      )
      .await
      .unwrap();
    evaluations.push(realm.mod_evaluate(runtime.v8_isolate(), id));
  }

  runtime.run_event_loop(Default::default()).await.unwrap();
  for evaluation in evaluations {
    evaluation.await.unwrap();
  }

  for (realm, value) in &realms {
    assert_js(&mut runtime, realm, &format!("value === {}", value + 1));
  }
}

#[tokio::test]
async fn test_realm_nested_refed_immediates() {
  let mut runtime = JsRuntime::new(RuntimeOptions::default());
  let realm = runtime.new_realm(Default::default()).unwrap();
  realm
    .execute_script(
      runtime.v8_isolate(),
      "setup.js",
      r#"
      globalThis.count = 0;
      function queue(fn) {
        Deno.core.immediateRefCount(true);
        Deno.core.queueImmediate({
          _idleNext: null, _idlePrev: null, _argv: null, _destroyed: false,
          _onImmediate() {
            Deno.core.immediateRefCount(false);
            fn();
          },
        });
      }
      queue(() => { count++; queue(() => count++); });
      "#,
    )
    .unwrap();
  assert_js(&mut runtime, &realm, "Deno.core.eventLoopHasMoreWork()");
  runtime.run_event_loop(Default::default()).await.unwrap();
  assert_js(&mut runtime, &realm, "count === 2");
}

#[tokio::test]
async fn test_realm_close_callbacks() {
  let mut runtime = JsRuntime::new(RuntimeOptions::default());
  let realm = runtime.new_realm(Default::default()).unwrap();
  realm
    .execute_script(runtime.v8_isolate(), "setup.js", "globalThis.events = [];")
    .unwrap();

  let state = realm.0.context_state.clone();
  realm
    .0
    .context_state
    .event_loop_phases
    .borrow_mut()
    .v8_close_callbacks
    .push_back(V8CloseCallback {
      callback: Box::new(move |scope| {
        JsRuntime::eval::<v8::Promise>(
          scope,
          "Promise.resolve().then(() => events.push('microtask'))",
        )
        .unwrap();
        state
          .event_loop_phases
          .borrow_mut()
          .v8_close_callbacks
          .push_back(V8CloseCallback {
            callback: Box::new(|scope| {
              JsRuntime::eval::<v8::Number>(scope, "events.push('close')")
                .unwrap();
            }),
          });
      }),
    });

  assert_js(&mut runtime, &realm, "Deno.core.eventLoopHasMoreWork()");
  let mut cx = Context::from_waker(Waker::noop());
  assert!(
    runtime
      .poll_event_loop(&mut cx, Default::default())
      .is_pending()
  );
  // Close-callback microtasks run this tick; newly queued close callbacks
  // keep the runtime alive for the following tick.
  assert_js(&mut runtime, &realm, "events.join(',') === 'microtask'");
  runtime.run_event_loop(Default::default()).await.unwrap();
  assert_js(
    &mut runtime,
    &realm,
    "events.join(',') === 'microtask,close'",
  );
}

#[tokio::test]
async fn test_realm_close_exception() {
  let mut runtime = JsRuntime::new(RuntimeOptions::default());
  let realm = runtime.new_realm(Default::default()).unwrap();
  realm
    .0
    .context_state
    .event_loop_phases
    .borrow_mut()
    .v8_close_callbacks
    .push_back(V8CloseCallback {
      callback: Box::new(|scope| {
        let _ = JsRuntime::eval::<v8::Object>(
          scope,
          "Deno.core.__reportException(new Error('close error'))",
        );
      }),
    });
  let error = runtime
    .run_event_loop(Default::default())
    .await
    .unwrap_err();
  assert!(error.to_string().contains("close error"));
}

#[test]
fn test_two_realms_extension_js() {
  deno_core::extension!(
    test_ext,
    esm_entry_point = "ext:test_ext/main.js",
    esm = ["ext:test_ext/main.js" = {
      source = "import { core } from 'ext:core/mod.js';
                extensionValue.value += 1;
                globalThis.loadLazy = () => core.loadExtScript('ext:test_ext/lazy.js');
                globalThis.loadLazyEsm = core.createLazyLoader('ext:test_ext/lazy_esm.js');"
    }],
    lazy_loaded_esm = ["ext:test_ext/lazy_esm.js" =
      { source = "export const value = extensionValue.value;" }],
    lazy_loaded_js = ["ext:test_ext/lazy.js" =
      { source = "(() => ({ value: extensionValue.value }))()" }],
    js = ["ext:test_ext/init.js" =
      { source = "globalThis.extensionValue = { value: 1 };" }]
  );
  let mut runtime = JsRuntime::new(RuntimeOptions {
    extensions: vec![test_ext::init()],
    ..Default::default()
  });
  runtime
    .execute_script("main.js", "extensionValue.value = 42;")
    .unwrap();
  let realm = runtime.new_realm(Default::default()).unwrap();

  for (realm, expected) in [(runtime.main_realm(), 42), (realm, 2)] {
    assert_js(
      &mut runtime,
      &realm,
      &format!(
        "extensionValue.value === {expected} && \
         loadLazy().value === {expected} && \
         loadLazyEsm().value === {expected}"
      ),
    );
  }
}

#[test]
fn test_new_realm_extension_js_error() {
  #[op2(fast)]
  fn op_count(state: &mut OpState) -> u32 {
    let count = state.borrow_mut::<u32>();
    *count += 1;
    *count
  }

  deno_core::extension!(
    test_ext,
    ops = [op_count],
    js = ["ext:test_ext/init.js" = {
      source = "globalThis.count = Deno.core.ops.op_count();
                if (count === 2) throw new Error('extension init failed');"
    }],
    state = |state| state.put(0u32)
  );
  let mut runtime = JsRuntime::new(RuntimeOptions {
    extensions: vec![test_ext::init()],
    ..Default::default()
  });
  let err = runtime.new_realm(Default::default()).err().unwrap();
  assert!(err.to_string().contains("extension init failed"));
  // The failed realm still consumed a count: OpState is shared, not reset.
  let realm = runtime.new_realm(Default::default()).unwrap();
  assert_js(&mut runtime, &realm, "count === 3");
  let main_realm = runtime.main_realm();
  assert_js(&mut runtime, &main_realm, "count === 1");
}

#[test]
fn test_set_format_exception_callback_realms() {
  let mut runtime = JsRuntime::new(RuntimeOptions::default());
  let main_realm = runtime.main_realm();

  let realm_expectations = &[(&main_realm, "main_realm")];

  // Set up format exception callbacks.
  for (realm, realm_name) in realm_expectations {
    realm
      .execute_script(
        runtime.v8_isolate(),
        "",
        format!(
          r#"
          Deno.core.ops.op_set_format_exception_callback((error) => {{
            Deno.core.isNativeError(error); // test reentrancy
            return `{realm_name} / ${{error}}`;
          }});
        "#
        ),
      )
      .unwrap();
  }

  for (realm, realm_name) in realm_expectations {
    // Immediate exceptions
    {
      let result = realm.execute_script(
        runtime.v8_isolate(),
        "",
        format!("throw new Error('{realm_name}');"),
      );
      assert!(result.is_err());
      let error = result.unwrap_err();
      assert_eq!(
        error.exception_message,
        format!("{realm_name} / Error: {realm_name}")
      );
    }

    // Promise rejections
    {
      realm
        .execute_script(
          runtime.v8_isolate(),
          "",
          format!("Promise.reject(new Error('{realm_name}'));"),
        )
        .unwrap();

      let result =
        futures::executor::block_on(runtime.run_event_loop(Default::default()));
      assert!(result.is_err());
      let CoreErrorKind::Js(error) = result.unwrap_err().into_kind() else {
        unreachable!()
      };
      assert_eq!(
        error.exception_message,
        format!("Uncaught (in promise) {realm_name} / Error: {realm_name}")
      );
    }
  }
}

#[tokio::test]
async fn js_realm_ref_unref_ops() {
  // Never resolves.
  #[op2]
  async fn op_pending() {
    std::future::pending().await
  }

  deno_core::extension!(test_ext, ops = [op_pending]);
  let mut runtime = JsRuntime::new(RuntimeOptions {
    extensions: vec![test_ext::init()],
    ..Default::default()
  });

  poll_fn(move |cx| {
    let main_realm = runtime.main_realm();

    main_realm
      .execute_script(
        runtime.v8_isolate(),
        "",
        r#"
        const { op_pending } = Deno.core.ops;
        var promise = op_pending();
        "#,
      )
      .unwrap();
    assert!(matches!(
      runtime.poll_event_loop(cx, Default::default()),
      Poll::Pending
    ));

    main_realm
      .execute_script(
        runtime.v8_isolate(),
        "",
        r#"
          Deno.core.unrefOpPromise(promise);
        "#,
      )
      .unwrap();

    assert!(matches!(
      runtime.poll_event_loop(cx, Default::default()),
      Poll::Ready(Ok(()))
    ));
    Poll::Ready(())
  })
  .await;
}

#[test]
fn es_snapshot() {
  let _snapshot_lock = super::snapshot_test_lock();
  deno_core::extension!(
    module_snapshot,
    esm_entry_point = "mod:test",
    esm = ["mod:test" =
      { source = "globalThis.TEST = 'foo'; export const TEST = 'bar';" },]
  );

  let startup_data = {
    let runtime = JsRuntimeForSnapshot::new(RuntimeOptions {
      extensions: vec![module_snapshot::init()],
      module_loader: Some(Rc::new(StaticModuleLoader::default())),
      ..Default::default()
    });
    runtime.snapshot()
  };
  let snapshot = Box::leak(startup_data);
  let mut runtime = JsRuntime::new(RuntimeOptions {
    extensions: vec![module_snapshot::init()],
    module_loader: None,
    startup_snapshot: Some(snapshot),
    ..Default::default()
  });

  // The module was evaluated ahead of time
  {
    let global_test = runtime.execute_script("", "globalThis.TEST").unwrap();
    deno_core::scope!(scope, runtime);
    let global_test = v8::Local::new(scope, global_test);
    assert!(global_test.is_string());
    assert_eq!(global_test.to_rust_string_lossy(scope).as_str(), "foo");
  }

  // A fresh realm re-executes the supplied sources instead of using the
  // already-evaluated modules from the main realm's snapshot.
  let realm = runtime.new_realm(Default::default()).unwrap();
  assert_js(&mut runtime, &realm, "TEST === 'foo'");

  // The module can be imported
  {
    let test_export_promise = runtime
      .execute_script("", "import('mod:test').then(module => module.TEST)")
      .unwrap();
    #[allow(deprecated, reason = "test code")]
    let test_export =
      futures::executor::block_on(runtime.resolve_value(test_export_promise))
        .unwrap();

    deno_core::scope!(scope, runtime);
    let test_export = v8::Local::new(scope, test_export);
    assert!(test_export.is_string());
    assert_eq!(test_export.to_rust_string_lossy(scope).as_str(), "bar");
  }
}

#[test]
fn lazy() {
  static CALLED: AtomicBool = AtomicBool::new(false);

  deno_core::extension!(
    lazy_ext,
    options = {
      a: String,
      b: bool,
    },
    state = |_state, _options| {
      CALLED.store(true, Ordering::Relaxed);
    },
  );

  deno_core::extension!(lazy_bad, state = |_state| {},);

  let extensions = vec![lazy_ext::lazy_init()];

  let runtime = JsRuntime::new(RuntimeOptions {
    extensions,
    ..Default::default()
  });

  let err = runtime
    .lazy_init_extensions(vec![])
    .unwrap_err()
    .into_kind();
  assert!(matches!(
    err,
    CoreErrorKind::ExtensionLazyInitCountMismatch(
      ExtensionLazyInitCountMismatchError {
        lazy_init_extensions_len: 1,
        arguments_len: 0,
      }
    )
  ));

  let err = runtime
    .lazy_init_extensions(vec![lazy_bad::args()])
    .unwrap_err()
    .into_kind();
  assert!(matches!(
    err,
    CoreErrorKind::ExtensionLazyInitOrderMismatch(
      ExtensionLazyInitOrderMismatchError {
        expected: "lazy_ext",
        actual: "lazy_bad",
      }
    )
  ));

  assert!(!CALLED.load(Ordering::Relaxed));

  runtime
    .lazy_init_extensions(vec![lazy_ext::args("".into(), true)])
    .unwrap();

  assert!(CALLED.load(Ordering::Relaxed));
}
