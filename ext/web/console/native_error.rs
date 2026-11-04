// Copyright 2018-2026 the Deno authors. MIT license.

//! Browser console previews use the exception's captured native data. Reading
//! the page's `stack` property would execute getters/prepareStackTrace merely
//! because an object was logged. The inspector still receives the original
//! object through V8's console; this text renders every captured native frame.

use deno_core::v8;

fn string_data_property<'s>(
  scope: &mut v8::PinScope<'s, '_>,
  mut object: v8::Local<'s, v8::Object>,
  name: &str,
) -> Option<String> {
  let key = v8::String::new(scope, name)?;
  loop {
    if object.is_proxy() {
      return None;
    }
    if let Some(descriptor) = object
      .get_own_property_descriptor(scope, key.into())
      .and_then(|value| v8::Local::<v8::Object>::try_from(value).ok())
    {
      let value_key = v8::String::new(scope, "value")?;
      return descriptor
        .get(scope, value_key.into())
        .filter(|value| value.is_string())
        .map(|value| value.to_rust_string_lossy(scope));
    }
    object = object.get_prototype(scope)?.try_into().ok()?;
  }
}

pub(super) fn format<'s>(
  scope: &mut v8::PinScope<'s, '_>,
  error: v8::Local<'s, v8::Object>,
) -> String {
  let name = string_data_property(scope, error, "name").unwrap_or_else(|| {
    error.get_constructor_name().to_rust_string_lossy(scope)
  });
  let message =
    string_data_property(scope, error, "message").unwrap_or_default();
  let mut result = match (name.is_empty(), message.is_empty()) {
    (true, _) => message,
    (_, true) => name,
    _ => format!("{name}: {message}"),
  };
  if let Some(trace) = v8::Exception::get_stack_trace(scope, error.into()) {
    for index in 0..trace.get_frame_count() {
      let Some(frame) = trace.get_frame(scope, index) else {
        continue;
      };
      let function = frame
        .get_function_name(scope)
        .map(|name| name.to_rust_string_lossy(scope))
        .unwrap_or_default();
      let source = frame
        .get_script_name_or_source_url(scope)
        .map(|name| name.to_rust_string_lossy(scope))
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| "<anonymous>".into());
      let location = if frame.get_line_number() > 0
        && frame.get_line_number() != usize::MAX
      {
        format!(
          "{source}:{}:{}",
          frame.get_line_number(),
          frame.get_column()
        )
      } else {
        source
      };
      result.push_str("\n    at ");
      if function.is_empty() {
        result.push_str(&location);
      } else {
        if frame.is_constructor() {
          result.push_str("new ");
        }
        result.push_str(&function);
        result.push_str(" (");
        result.push_str(&location);
        result.push(')');
      }
    }
  }
  result
}
