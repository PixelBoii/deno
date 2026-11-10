// Copyright 2018-2026 the Deno authors. MIT license.

use std::cell::RefCell;
use std::rc::Rc;

#[test]
fn native_console_forwarding_coerces_once_without_inspector_previews() {
  let mut runtime = deno_core::JsRuntime::new(deno_core::RuntimeOptions {
    inspector: true,
    ..Default::default()
  });
  let messages = Rc::new(RefCell::new(Vec::new()));
  let sink = messages.clone();
  runtime.inspector().set_console_message_callback(Some(Rc::new(
    move |level, message| sink.borrow_mut().push((level, message.to_owned())),
  )));
  runtime.execute_script("console-forwarding.js", r#"
    const check = (value) => {if (!value) throw new Error('native console forwarding');};
    let calls = 0;
    const value = {toString() {calls++; return '23';}};
    Deno.core.v8Console.log('%s %d', value, value);
    check(calls === 2);
    let traps = 0;
    const prototype = new Proxy({}, {ownKeys() {traps++; return [];}});
    Deno.core.v8Console.warn(Object.create(prototype));
    check(traps === 0);
    const sentinel = {};
    let thrown;
    try {Deno.core.v8Console.log('%s', {toString() {throw sentinel;}});}
    catch (error) {thrown = error;}
    check(thrown === sentinel);
  "#).unwrap();
  let received = messages.borrow();
  assert_eq!(received.len(), 2);
  assert!(received[0].1.contains("23"));
  assert_ne!(received[0].0, received[1].0);
  drop(received);
  runtime.inspector().set_console_message_callback(None);
  runtime.execute_script("console-forwarding-disabled.js", "Deno.core.v8Console.log('after removal')").unwrap();
  assert_eq!(messages.borrow().len(), 2);
}
