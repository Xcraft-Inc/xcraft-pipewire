# pipewire-capture

Minimal Node.js N-API PipeWire audio capture addon.

It exposes two layers:

- low-level PipeWire helpers: `openInputStream()`, `listCaptureNodes()`
- an audify-compatible backend: `lib/audify-compatible.js`

## Install

```sh
sudo apt install build-essential pkg-config libpipewire-0.3-dev
npm install
```

## Low-level usage

```js
const { openInputStream, listInputNodes } = require('pipewire-capture');

const input = listInputNodes()[0];

const stream = openInputStream(
  input?.name || '',
  1,
  'f32',
  48000,
  1024,
  (buffer, info) => {
    console.log(buffer.length, info);
  }
);

process.once('SIGINT', () => {
  stream.close();
  process.exit(0);
});
```

## Audify-compatible backend

This backend follows the shape used by the existing `xcraft-audify` wrapper:

```js
const PipeWire = require('pipewire-capture/lib/audify-compatible');

class AudioBackend {
  #pipewire = new PipeWire();

  get SampleFormat() {
    return this.#pipewire.SampleFormat;
  }

  getDevices() {
    return this.#pipewire.getDevices();
  }

  start() {
    this.#pipewire.start();
  }

  stop() {
    this.#pipewire.stop();
  }

  openInputStream(deviceId, channels, sampleFormat, sampleRate, frameSize, dataCalllback) {
    this.#pipewire.openInputStream(
      deviceId,
      channels,
      sampleFormat,
      sampleRate,
      frameSize,
      dataCalllback
    );
  }
}
```

The native PipeWire addon currently supports:

- `SampleFormat.SINT16`
- `SampleFormat.FLOAT32`

The compatibility backend exposes `SINT8`, `SINT24` and `SINT32` for API shape compatibility, but rejects them explicitly until the native addon implements those formats.

## Examples

```sh
npm run list
node examples/audify-compatible-backend.js
```

## Tests

```sh
npm test
```

PipeWire integration tests are opt-in:

```sh
PIPEWIRE_CAPTURE_INTEGRATION=1 npm test
```
