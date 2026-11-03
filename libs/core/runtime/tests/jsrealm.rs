// Copyright 2018-2026 the Deno authors. MIT license.

use std::future::poll_fn;
use std::rc::Rc;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::Ordering;
use std::task::Poll;

use crate::JsRuntime;
use crate::JsRuntimeForSnapshot;
use crate::RuntimeOptions;
use crate::error::CoreErrorKind;
use crate::error::ExtensionLazyInitCountMismatchError;
use crate::error::ExtensionLazyInitOrderMismatchError;
use crate::modules::StaticModuleLoader;
use crate::op2;

#[test]
fn test_new_realm_with_embedder_context() {
  struct Marker(u32);
  #[op2(fast)]
  fn op_context_marker(scope: &mut v8::PinScope) -> u32 {
    scope
      .get_current_context()
      .get_slot::<Marker>()
      .map_or(0, |v| v.0)
  }
  deno_core::extension!(context_test, ops = [op_context_marker]);
  let mut runtime = JsRuntime::new(RuntimeOptions {
    extensions: vec![context_test::init()],
    ..Default::default()
  });
  let context = {
    deno_core::scope!(scope, runtime);
    let template = v8::ObjectTemplate::new(scope);
    template.set_internal_field_count(2);
    let context = v8::Context::new(
      scope,
      v8::ContextOptions {
        global_template: Some(template),
        ..Default::default()
      },
    );
    context.set_slot(Rc::new(Marker(17)));
    v8::Global::new(scope, context)
  };
  let realm = runtime
    .new_realm(crate::CreateRealmOptions {
      context: Some(context.clone()),
      ..Default::default()
    })
    .unwrap();
  realm.execute_script(runtime.v8_isolate(), "realm.js", r#"
    if (Deno.core.ops.op_context_marker() !== 17) throw Error('wrong op context');
    globalThis.realmValue = 42;
    Promise.resolve().then(() => { globalThis.realmJob = 'done'; });
  "#).unwrap();
  futures::executor::block_on(runtime.run_event_loop(Default::default()))
    .unwrap();
  realm
    .execute_script(
      runtime.v8_isolate(),
      "realm-job.js",
      "if (realmJob !== 'done') throw Error('realm job did not run');",
    )
    .unwrap();
  runtime
    .execute_script(
      "main.js",
      r#"
    if (Deno.core.ops.op_context_marker() !== 0 || 'realmValue' in globalThis)
      throw Error('realm state leaked into main');
  "#,
    )
    .unwrap();
  assert!(
    runtime
      .new_realm(crate::CreateRealmOptions {
        context: Some(context),
        ..Default::default()
      })
      .is_err()
  );
  let main = runtime.main_context();
  assert!(
    runtime
      .new_realm(crate::CreateRealmOptions {
        context: Some(main),
        ..Default::default()
      })
      .is_err()
  );
  let plain_context = {
    deno_core::scope!(scope, runtime);
    let context = v8::Context::new(scope, Default::default());
    v8::Global::new(scope, context)
  };
  assert!(
    runtime
      .new_realm(crate::CreateRealmOptions {
        context: Some(plain_context),
        ..Default::default()
      })
      .is_err()
  );
  let ordinary = runtime.new_realm(Default::default()).unwrap();
  ordinary
    .execute_script(
      runtime.v8_isolate(),
      "ordinary.js",
      r#"
    if (Deno.core.ops.op_context_marker() !== 0 || 'realmValue' in globalThis)
      throw Error('independent default realm');
  "#,
    )
    .unwrap();
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
  let startup_data = {
    deno_core::extension!(
      module_snapshot,
      esm_entry_point = "mod:test",
      esm = ["mod:test" =
        { source = "globalThis.TEST = 'foo'; export const TEST = 'bar';" },]
    );

    let runtime = JsRuntimeForSnapshot::new(RuntimeOptions {
      extensions: vec![module_snapshot::init()],
      module_loader: Some(Rc::new(StaticModuleLoader::default())),
      ..Default::default()
    });
    runtime.snapshot()
  };
  let snapshot = Box::leak(startup_data);
  let mut runtime = JsRuntime::new(RuntimeOptions {
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
