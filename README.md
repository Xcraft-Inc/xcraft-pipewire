# xcraft-pipewire

Minimal Node.js N-API PipeWire audio capture addon.

## Install

```bash
sudo apt install build-essential pkg-config libpipewire-0.3-dev
npm install
```

## Low-level API

```js
const pipewire = require("xcraft-pipewire");

const stream = pipewire.openInputStream(
  "alsa_input.example.source",
  1,
  "f32",
  48000,
  1024,
  (buffer, info) => {
    console.log(buffer.length, info);
  },
);

stream.close();
```

The low-level API starts capture immediately.

## Audify-compatible backend

```js
const PipeWire = require("xcraft-pipewire/lib/backend.js");

const audio = new PipeWire();
const devices = audio.getDevices();
const input = devices.find((device) => device.inputChannels > 0);

audio.openInputStream(
  input.id,
  1,
  audio.SampleFormat.FLOAT32,
  input.sampleRate,
  1024,
  (buffer, info) => {
    console.log("callback", buffer.length, info);
  },
);

// openInputStream only configures the stream.
// Capture really starts here.
audio.start();

audio.stop();
audio.closeStream();
```

The audify-compatible backend is an `EventEmitter`:

```js
audio.on("open", (info) => console.log("configured", info));
audio.on("start", () => console.log("started"));
audio.on("data", (buffer, info) => console.log("data", buffer.length, info));
audio.on("stop", () => console.log("stopped"));
audio.on("close", () => console.log("closed"));
audio.on("error", (error) => console.error(error));
```

## Devices

```js
const devices = audio.getDevices();
```

Each returned device is shaped like:

```js
{
  (id,
    nativeId,
    name,
    nodeName,
    inputChannels,
    outputChannels,
    sampleRate,
    isDefaultInput,
    isDefaultOutput,
    isCapture,
    isSink,
    raw);
}
```

`id` is intentionally the PipeWire `node.name`, because it is more useful than the volatile numeric PipeWire object id for reopening streams.

## Tests

```bash
npm test
```

Integration tests against a real PipeWire server are opt-in:

```bash
XCRAFT_PIPEWIRE_INTEGRATION=1 npm test
```
