// Copyright 2018-2026 the Deno authors. MIT license.

use deno_core::{op2, v8};
use deno_error::JsErrorBox;

fn key<'s>(
  scope: &mut v8::PinScope<'s, '_>,
  kind: u32,
) -> Result<v8::Local<'s, v8::Private>, JsErrorBox> {
  let name = match kind {
    0 => "deno_web::PerformanceObserver::state",
    1 => "deno_web::PerformanceObserverEntryList::state",
    2 => "deno_web::PerformanceObserverEntryList::factory",
    _ => return Err(JsErrorBox::type_error("Unknown performance state")),
  };
  let name = v8::String::new(scope, name).unwrap();
  Ok(v8::Private::for_api(scope, Some(name)))
}

#[op2(fast)]
pub(crate) fn op_performance_object_bind(
  scope: &mut v8::PinScope,
  object: v8::Local<v8::Object>,
  data: v8::Local<v8::Object>,
  kind: u32,
) -> Result<(), JsErrorBox> {
  let key = key(scope, kind)?;
  if kind > 1 || object.set_private(scope, key, data.into()) != Some(true) {
    return Err(JsErrorBox::type_error("Could not create performance state"));
  }
  deno_core::mark_as_unserializable_host_object(scope, object);
  Ok(())
}

#[op2]
pub(crate) fn op_performance_object_data<'s>(
  scope: &mut v8::PinScope<'s, '_>,
  value: v8::Local<v8::Value>,
  kind: u32,
) -> Result<v8::Local<'s, v8::Object>, JsErrorBox> {
  let key = key(scope, kind)?;
  if kind > 1 || value.is_proxy() {
    return Err(JsErrorBox::type_error("Illegal invocation"));
  }
  v8::Local::<v8::Object>::try_from(value)
    .ok()
    .and_then(|object| object.get_private(scope, key))
    .and_then(|value| value.try_into().ok())
    .ok_or_else(|| JsErrorBox::type_error("Illegal invocation"))
}

#[op2(fast)]
pub(crate) fn op_performance_observer_register_factory(
  scope: &mut v8::PinScope,
  factory: v8::Local<v8::Function>,
) {
  let key = key(scope, 2).unwrap();
  let global = scope.get_current_context().global(scope);
  assert_eq!(global.set_private(scope, key, factory.into()), Some(true));
}

#[op2]
pub(crate) fn op_performance_observer_callback_factory<'s>(
  scope: &mut v8::PinScope<'s, '_>,
  callback: v8::Local<v8::Object>,
) -> Result<v8::Local<'s, v8::Value>, JsErrorBox> {
  let context = callback.get_creation_context(scope).ok_or_else(|| {
    JsErrorBox::type_error("The callback realm is unavailable")
  })?;
  let key = key(scope, 2)?;
  let global = context.global(scope);
  Ok(
    global
      .get_private(scope, key)
      .unwrap_or_else(|| v8::undefined(scope).into()),
  )
}
