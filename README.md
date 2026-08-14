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

`LOGOS_E2E_PROVIDER_LIB` gives the provider **child** its own
`liblogos_protocol`, so each half can be exercised against a different protocol
build. Because the two halves have different upstream requirements (see below),
this is what attributes a failure to a half rather than to "the protocol":

```sh
LOGOS_PROTOCOL_LIB=<protocol master>/lib/liblogos_protocol.dylib \
LOGOS_E2E_PROVIDER_LIB=<provider-capable protocol>/lib/liblogos_protocol.dylib \
  npm test          # consumer half, run against protocol master
```

## Status / limitations

- Provider method handlers are **synchronous** (return a value, not a Promise).
  Async request/response awaits a deferred-reply ABI.

### What each half needs from logos-protocol

The two halves of this SDK have *different* upstream requirements, and the flake
pin is driven by the stricter one:

| half | needs | on logos-protocol master? |
|---|---|---|
| consumer (`LogosClient`, `lp_client_*`) | a shared `liblogos_protocol` + a Qt-free plain transport | **yes** — verified: async call, event, `getMethods`, `callSync` all round-trip |
| provider (`Provider`, `lp_provider_*`) | the C ABI actually *serving* a module | **no** — logos-protocol#12 is still open |

The shared library is merged (logos-protocol#4): master installs
`$out/lib/liblogos_protocol.{so,dylib}` in the ordinary `logos-protocol` /
`logos-protocol-lib` package, alongside the static archive. It is *not* a
separate package there, so `flake.nix` resolves
`logos-protocol-shared or logos-protocol` and works against either pin.

Serving is not. On master `lp_provider_register()` returns `LP_OK`, stores the
callbacks and opens no socket; `lp_provider_emit_event` / `lp_provider_save_token`
return `LP_ERR_UNSUPPORTED`. `Provider.register()` probes for exactly that and
throws a descriptive error instead of letting it surface as a consumer-side
"Connection refused" 30 s later. Until logos-protocol#12–#16 merge, `flake.nix`
pins the branch at the tip of that stack; flipping it to master afterwards is a
one-line change.

Codegen additionally needs a shared `liblogos_lidl_c` (logos-lidl#6, also still
open — master builds only a static `logos_lidl_c`). The e2e skips the codegen
round-trip when `LOGOS_LIDL_LIB` is unset, so the rest of the suite does not
depend on it.
