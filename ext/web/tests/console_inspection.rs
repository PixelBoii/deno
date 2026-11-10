// Copyright 2018-2026 the Deno authors. MIT license.

#[tokio::test(flavor = "current_thread")]
async fn platform_inspection_preserves_cli_hooks_and_private_callbacks() {
  deno_core::extension!(
    inspection_test_setup,
    esm_entry_point = "ext:inspection_test_setup/setup.js",
    esm = ["ext:inspection_test_setup/setup.js" = {
      source = r#"
        import { core } from "ext:core/mod.js";
        globalThis.consoleInspection = core.loadExtScript("ext:deno_web/01_console.js");
        globalThis.entryClass = core.loadExtScript("ext:deno_web/15_performance.js").PerformanceEntry;
        globalThis.registerInspector = core.ops.op_console_register_private_inspector;
        globalThis.webidlInspection = core.loadExtScript("ext:deno_webidl/00_webidl.js");
        globalThis.urlSearchParamsClass = core.loadExtScript("ext:deno_web/00_url.js").URLSearchParams;
        globalThis.urlClass = core.loadExtScript("ext:deno_web/00_url.js").URL;
      "#
    }],
    options = {private_inspection: bool},
    state = |state, options| {
      if options.private_inspection {
        deno_web::enable_private_console_inspection(state);
      }
    },
  );
  for private_inspection in [false, true] {
    let mut runtime = deno_core::JsRuntime::new(deno_core::RuntimeOptions {
      extensions: vec![
        deno_webidl::deno_webidl::init(),
        deno_web::deno_web::init(
          std::sync::Arc::new(deno_web::BlobStore::default()),
          None,
          false,
          Default::default(),
        ),
        inspection_test_setup::init(private_inspection),
      ],
      ..Default::default()
    });
    runtime.execute_script("file:///console-inspection-test.js", format!(r#"
      const native = {private_inspection};
      const assert = condition => {{if (!condition) throw new Error('console inspection conformance');}};
      const key = Symbol.for('Deno.privateCustomInspect');
      assert(Object.hasOwn(entryClass.prototype, key) === !native);
      let calls = 0;
      const object = {{ordinary:42, [key]() {{calls++; return 'custom inspector';}}}};
      const result = consoleInspection.inspect(object);
      assert(native ? result.includes('ordinary: 42') : result === 'custom inspector');
      assert(calls === (native ? 0 : 1) && Object.hasOwn(object, key));
      for (const inherited of [false, true]) {{
        let tagReads = 0;
        const tagged = {{get [Symbol.toStringTag]() {{tagReads++; return 'AuthorTag';}}}};
        const value = inherited ? Object.create(tagged) : tagged;
        consoleInspection.inspect(value);
        assert(tagReads === (native ? 0 : 1));
        assert(value[Symbol.toStringTag] === 'AuthorTag');
        assert(tagReads === (native ? 1 : 2));
      }}
      assert(consoleInspection.inspect({{[Symbol.toStringTag]:'StoredTag'}}).includes('StoredTag'));
      const prototype = {{}};
      let privateCalls = 0;
      registerInspector(prototype, function() {{privateCalls++; return 'Platform actual=' + this.actual;}});
      const value = Object.assign(Object.create(prototype), {{actual:73}});
      const formatted = consoleInspection.inspect(value);
      assert(native ? formatted === 'Platform actual=73' : formatted.includes('actual: 73'));
      assert(privateCalls === (native ? 1 : 0));
      const defined = {{actual:19}};
      webidlInspection.definePropertiesWithPrivateInspect(defined, {{
        [key]: {{value() {{return 'Defined actual=' + this.actual;}}}},
      }});
      assert(consoleInspection.inspect(defined) === 'Defined actual=19');
      assert(Object.hasOwn(defined, key) === !native);
      const params = new urlSearchParamsClass('a=1&b=2');
      const iterator = params.entries();
      let iteratorPreview = consoleInspection.inspect(iterator);
      if (!iteratorPreview.includes('"a", "1"')) throw new Error('iterator preview=' + iteratorPreview);
      assert(iterator.next().value.join() === 'a,1');
      iteratorPreview = consoleInspection.inspect(iterator);
      if (!iteratorPreview.includes('"b", "2"') || iteratorPreview.includes('"a", "1"')) throw new Error('advanced iterator preview=' + iteratorPreview);
      params.append('c', '3');
      assert(iterator.next().value.join() === 'b,2');
      assert(iterator.next().value.join() === 'c,3' && iterator.next().done);
      const linkedUrl = new urlClass('https://example.test/?a=1');
      const query = linkedUrl.searchParams;
      assert(Reflect.ownKeys(query).length === 0);
      query.toString = () => {{throw new Error('author serializer');}};
      Object.freeze(query);
      urlSearchParamsClass.prototype.append.call(query, 'b', '2');
      assert(linkedUrl.search === '?a=1&b=2');
      linkedUrl.search = '?reset=3';
      assert(urlSearchParamsClass.prototype.get.call(query, 'reset') === '3');
      let stackReads = 0;
      function actualErrorCreator() {{return new Error('captured native message');}}
      const error = actualErrorCreator();
      Object.defineProperty(error, 'stack', {{get() {{stackReads++; return 'CLI supplied stack';}}}});
      const displayed = consoleInspection.inspect(error);
      assert(stackReads === (native ? 0 : 1));
      if (native) {{
        assert(displayed.includes('captured native message'));
        assert(displayed.includes('actualErrorCreator'));
        assert(displayed.includes('file:///console-inspection-test.js'));
      }} else {{assert(displayed.includes('CLI supplied stack'));}}
      if (!native) {{
        const descriptor = Object.getOwnPropertyDescriptor(defined, key);
        assert(!descriptor.writable && !descriptor.configurable);
      }}
    "#)).unwrap();
  }
}
