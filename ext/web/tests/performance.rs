// Copyright 2018-2026 the Deno authors. MIT license.

#[test]
fn performance_timeline_defaults_and_observer_order() {
  deno_core::extension!(
    performance_test_setup,
    esm_entry_point = "ext:performance_test_setup/setup.js",
    esm = ["ext:performance_test_setup/setup.js" = {
      source = r#"
        import { core } from "ext:core/mod.js";
        globalThis.timeline = core.loadExtScript("ext:deno_web/15_performance.js");
      "#
    }],
  );
  let mut runtime = deno_core::JsRuntime::new(deno_core::RuntimeOptions {
    extensions: vec![
      deno_webidl::deno_webidl::init(),
      deno_web::deno_web::init(
        std::sync::Arc::new(deno_web::BlobStore::default()),
        None,
        false,
        Default::default(),
      ),
      performance_test_setup::init(),
    ],
    ..Default::default()
  });
  runtime.execute_script("file:///performance-test.js", r#"
    const {performance: p, PerformanceObserver: Observer} = timeline;
    const assert = (condition) => { if (!condition) throw new Error('performance conformance') };
    timeline.setTimeOrigin();
    assert(Math.abs(p.timeOrigin + p.now() - Date.now()) < 100);
    assert(Observer.supportedEntryTypes.join() === 'mark,measure');
    assert(Object.isFrozen(Observer.supportedEntryTypes));
    const observer = new Observer(() => { throw new Error('queue was drained') });
    observer.observe({type: 'mark'});
    observer.observe({type: 'measure'});
    p.mark('late', {startTime: 20});
    p.mark('', {startTime: 10});
    p.measure('span', {start: 0, end: 5});
    assert(observer.takeRecords().map(e => e.startTime).join() === '20,10,0');
    assert(p.getEntries().map(e => e.startTime).join() === '0,10,20');
    assert(p.getEntriesByName('').length === 1);
    assert(p.getEntriesByType('').length === 0);
    observer.disconnect();
  "#).unwrap();
}
