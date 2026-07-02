# logos-js-sdk

A **protocol-native, Qt-free** JavaScript SDK for Logos: a thin [koffi](https://koffi.dev)
wrapper over the logos-protocol `lp_*` C ABI. A Node process is an out-of-process
**consumer** (`lp_client_*`) and/or **provider** (`lp_provider_*`) over a *plain*
transport — plain TCP, TCP+SSL, or a plain-local Unix socket. There is **no
embedded Qt host and no Qt event loop**.

It loads a shared `liblogos_protocol` directly; it does not use `liblogos_core`.

## Consume a module

```js
const { LogosClient, tcp } = require('logos-js-sdk');

const logos = new LogosClient('my_app', { transport: tcp('127.0.0.1', 6001) });
const calc  = logos.module('calc_module');

const sum = await calc.call('add', 5, 3);         // async → Promise
const off = calc.on('computed', (v) => { … });    // event subscription (off() to stop)
const iface = calc.getMethods();                   // introspection
```

## Provide a module

```js
const { Provider, tcp } = require('logos-js-sdk');

const p = new Provider('greeter', tcp('127.0.0.1', 6002));
p.register({
  handlers: { hello: (name) => `hi ${name}` },     // synchronous handlers
  events: ['greeted'],
});
p.saveToken('caller_module', authToken);            // authorize a caller
p.emit('greeted', 'world');
```

## Typed bindings from a `.lidl` contract

```sh
logos-lidl-gen-js calc.lidl            > calc_client.js      # typed consumer client
logos-lidl-gen-js calc.lidl --provider > calc_provider.js    # provider scaffold
```

The generated client wraps each method as `async fn(...) → Promise` and each event
as `on<Event>(handler)`. The provider scaffold gives an impl-class stub and a
`serve(transports, impl)` factory. Codegen reuses logos-lidl's canonical grammar
via its C ABI (no JS re-implementation).

## Finding the native libraries

The SDK loads `liblogos_protocol.{so,dylib}` and (for codegen) `liblogos_lidl_c`.
Point it at them with `LOGOS_PROTOCOL_LIB` / `LOGOS_LIDL_LIB` (explicit paths) or
`LOGOS_PROTOCOL_ROOT` / `LOGOS_LIDL_ROOT` (a prefix with `lib/`), or drop them in
`./lib/`. The Nix dev shell sets these for you:

```sh
nix develop      # exports LOGOS_PROTOCOL_LIB / LOGOS_LIDL_LIB, provides node
npm ci && npm test
```

## Test

`npm test` runs `test/e2e.js`: a Node provider (child process) and a Node
consumer exchange async calls, an object result, a `{_bytes}` round-trip,
introspection, an event, a sync call, and a `.lidl`→JS codegen round-trip — all
over a plain transport with no Qt loop. It also runs hermetically as
`nix flake check` (`checks.<system>.e2e`).

## Status / limitations

- Provider method handlers are **synchronous** (return a value, not a Promise).
  Async request/response awaits a deferred-reply ABI.
- Requires a logos-protocol with the Qt-free `lp_provider_*`/`lp_client_*` path
  and a shared `liblogos_protocol`, and a shared `liblogos_lidl_c` for codegen.
