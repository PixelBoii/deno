// Copyright 2018-2026 the Deno authors. MIT license.

use deno_core::FromV8;
use deno_core::convert::ByteString;
use deno_core::{op2, v8};
use deno_error::JsErrorBox;

fn base64_operation(
  scope: &mut v8::PinScope,
  args: &v8::FunctionCallbackArguments,
  mut rv: v8::ReturnValue,
) -> Result<(), JsErrorBox> {
  let data = args.data().cast::<v8::Array>();
  let mode = data
    .get_index(scope, 0)
    .unwrap()
    .uint32_value(scope)
    .unwrap();
  let check = data.get_index(scope, 1).unwrap();
  if let Ok(check) = check.try_cast::<v8::Function>() {
    let receiver = v8::Local::new(scope, args.this());
    let undefined = v8::undefined(scope);
    let Some(valid) = check.call(scope, undefined.into(), &[receiver.into()])
    else {
      return Ok(());
    };
    if !valid.boolean_value(scope) {
      return Err(JsErrorBox::type_error("Illegal invocation"));
    }
  }
  let name = if mode == 0 { "atob" } else { "btoa" };
  if args.length() < 1 {
    return Err(JsErrorBox::type_error(format!(
      "Failed to execute '{name}': 1 argument required"
    )));
  }
  let Some(text) = args.get(0).to_string(scope) else {
    return Ok(());
  };
  // The HTML codec accepts a DOMString, then validates its code units as
  // Latin-1. The error belongs to the codec rather than ByteString conversion.
  let bytes = ByteString::from_v8(scope, text.into()).map_err(|_| {
    JsErrorBox::new(
      "DOMExceptionInvalidCharacterError",
      "The string contains characters outside of the Latin1 range",
    )
  })?;
  let result = if mode == 0 {
    let decoded =
      super::decode_base64_atob(bytes).map_err(JsErrorBox::from_err)?;
    v8::String::new_from_one_byte(
      scope,
      decoded.as_ref(),
      v8::NewStringType::Normal,
    )
    .ok_or_else(|| JsErrorBox::range_error("Decoded string is too large"))?
  } else {
    super::base64_encode_to_v8_string(
      scope,
      bytes.as_ref(),
      v8::simdutf::Base64Options::Default,
    )
    .map_err(JsErrorBox::from_err)?
  };
  rv.set(result.into());
  Ok(())
}

fn base64_callback(
  scope: &mut v8::PinScope,
  args: v8::FunctionCallbackArguments,
  rv: v8::ReturnValue,
) {
  if let Err(error) = base64_operation(scope, &args, rv) {
    let exception = deno_core::error::to_v8_error(scope, &error);
    scope.throw_exception(exception);
  }
}

#[op2]
pub(crate) fn op_create_base64_binding<'s>(
  scope: &mut v8::PinScope<'s, '_>,
  mode: u32,
  check: v8::Local<'s, v8::Value>,
) -> Result<v8::Local<'s, v8::Function>, JsErrorBox> {
  if mode > 1 || !(check.is_null_or_undefined() || check.is_function()) {
    return Err(JsErrorBox::type_error("Invalid Base64 binding"));
  }
  let name = if mode == 0 { "atob" } else { "btoa" };
  let mode = v8::Integer::new_from_unsigned(scope, mode);
  let data = v8::Array::new_with_elements(scope, &[mode.into(), check]);
  let function = v8::Function::builder(base64_callback)
    .data(data.into())
    .length(1)
    .constructor_behavior(v8::ConstructorBehavior::Throw)
    .build(scope)
    .ok_or_else(|| JsErrorBox::generic("Could not create Base64 binding"))?;
  let name = v8::String::new(scope, name).unwrap();
  function.set_name(name);
  Ok(function)
}
