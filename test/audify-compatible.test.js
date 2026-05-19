"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const compat = require("../lib/backend.js");
const { _internals } = compat;

test("audify-compatible exposes RtAudio-like sample format names", () => {
  const backend = new compat({ pipewire: fakePipewire() });

  assert.equal(backend.SampleFormat.SINT16, "s16");
  assert.equal(backend.SampleFormat.FLOAT32, "f32");
  assert.equal(backend.SampleFormat.SINT8, "s8");
  assert.equal(backend.SampleFormat.SINT24, "s24");
  assert.equal(backend.SampleFormat.SINT32, "s32");
});

test("audify-compatible normalizes supported formats", () => {
  assert.equal(_internals.normalizeFormat("s16"), "s16");
  assert.equal(_internals.normalizeFormat("int16"), "s16");
  assert.equal(_internals.normalizeFormat("f32"), "f32");
  assert.equal(_internals.normalizeFormat("float32"), "f32");
});

test("audify-compatible rejects formats not implemented by native addon yet", () => {
  assert.throws(() => _internals.normalizeFormat("s8"), /does not support/);
  assert.throws(() => _internals.normalizeFormat("s24"), /does not support/);
  assert.throws(() => _internals.normalizeFormat("s32"), /does not support/);
});

test("audify-compatible maps PipeWire node to audify-like device", () => {
  const device = _internals.toAudifyDevice({
    id: 42,
    name: "alsa_input.test.source",
    description: "Test Source",
    mediaClass: "Audio/Source",
    isCapture: true,
    isSink: false,
    audioChannels: 1,
    audioRate: 44100,
  });

  assert.equal(device.id, "alsa_input.test.source");
  assert.equal(device.nativeId, 42);
  assert.equal(device.name, "Test Source");
  assert.equal(device.inputChannels, 1);
  assert.equal(device.outputChannels, 0);
  assert.equal(device.sampleRate, 44100);
  assert.equal(device.isDefaultInput, false);
  assert.equal(device.isDefaultOutput, false);
});

test("openInputStream only configures stream; start opens native capture", () => {
  const calls = [];
  const backend = new compat({
    pipewire: fakePipewire({
      openInputStream(...args) {
        calls.push(args);
        return { close() {} };
      },
    }),
  });

  const callback = () => {};
  backend.openInputStream(
    "source.one",
    1,
    backend.SampleFormat.FLOAT32,
    48000,
    256,
    callback,
  );

  assert.equal(calls.length, 0);
  assert.equal(backend.started, false);
  assert.equal(backend.isStreamOpen, true);

  backend.start();

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].slice(0, 5), ["source.one", 1, "f32", 48000, 256]);
  assert.equal(typeof calls[0][5], "function");
  assert.equal(backend.started, true);
});

test("start emits data and also calls audify-style callback", () => {
  let nativeCallback = null;
  const backend = new compat({
    pipewire: fakePipewire({
      openInputStream(...args) {
        nativeCallback = args[5];
        return { close() {} };
      },
    }),
  });

  let eventData = null;
  let callbackData = null;

  backend.on("data", (buffer, info) => {
    eventData = { buffer, info };
  });

  backend.openInputStream(
    "source.one",
    1,
    "f32",
    48000,
    256,
    (buffer, info) => {
      callbackData = { buffer, info };
    },
  );

  backend.start();

  const buffer = Buffer.from([1, 2, 3, 4]);
  const info = { frames: 1, channels: 1 };
  nativeCallback(buffer, info);

  assert.equal(eventData.buffer, buffer);
  assert.equal(eventData.info, info);
  assert.equal(callbackData.buffer, buffer);
  assert.equal(callbackData.info, info);
});

test("stop closes native stream and is idempotent", () => {
  let closeCount = 0;
  const backend = new compat({
    pipewire: fakePipewire({
      openInputStream() {
        return {
          close() {
            closeCount++;
          },
        };
      },
    }),
  });

  backend.openInputStream("source.one", 1, "f32", 48000, 256, () => {});
  backend.start();
  backend.stop();
  backend.stop();

  assert.equal(closeCount, 1);
  assert.equal(backend.started, false);
  assert.equal(backend.isStreamOpen, true);
});

test("closeStream clears configured stream", () => {
  const backend = new compat({ pipewire: fakePipewire() });

  backend.openInputStream("source.one", 1, "f32", 48000, 256, () => {});
  assert.equal(backend.isStreamOpen, true);

  backend.closeStream();
  assert.equal(backend.isStreamOpen, false);
});

test("start without openInputStream throws", () => {
  const backend = new compat({ pipewire: fakePipewire() });
  assert.throws(() => backend.start(), /openInputStream/);
});

test("getDevices maps native nodes", () => {
  const backend = new compat({
    pipewire: fakePipewire({
      listCaptureNodes() {
        return [
          {
            id: 42,
            name: "source.one",
            description: "Source One",
            mediaClass: "Audio/Source",
            isCapture: true,
            isSink: false,
            audioChannels: 1,
            audioRate: 48000,
          },
        ];
      },
    }),
  });

  const devices = backend.getDevices();
  assert.equal(devices.length, 1);
  assert.equal(devices[0].id, "source.one");
  assert.equal(devices[0].inputChannels, 1);
});

function fakePipewire(overrides = {}) {
  return {
    listCaptureNodes() {
      return [];
    },
    openInputStream() {
      return { close() {} };
    },
    ...overrides,
  };
}
