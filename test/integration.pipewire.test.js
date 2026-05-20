"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const enabled = process.env.XCRAFT_PIPEWIRE_INTEGRATION === "1";

test(
  "listCaptureNodes returns an array from PipeWire",
  { skip: !enabled },
  () => {
    const { listCaptureNodes } = require("..");
    const nodes = listCaptureNodes();

    assert.equal(Array.isArray(nodes), true);

    for (const node of nodes) {
      assert.equal(typeof node.id, "number");
      assert.equal(typeof node.name, "string");
      assert.equal(typeof node.mediaClass, "string");
      assert.equal(typeof node.isAudio, "boolean");
      assert.equal(typeof node.isCapture, "boolean");
      assert.equal(typeof node.isSink, "boolean");
    }
  },
);

test(
  "openInputStream can open the default PipeWire input briefly",
  { skip: !enabled },
  async () => {
    const { openInputStream } = require("..");

    let chunks = 0;
    let bytes = 0;

    const stream = openInputStream(
      "",
      1,
      "f32",
      48000,
      1024,
      (buffer, info) => {
        chunks++;
        bytes += buffer.length;

        assert.equal(Buffer.isBuffer(buffer), true);
        assert.equal(typeof info.frames, "number");
        assert.equal(typeof info.channels, "number");
        assert.equal(typeof info.sampleRate, "number");
        assert.equal(typeof info.sampleFormat, "string");
      },
    );

    await new Promise((resolve) => setTimeout(resolve, 1000));
    stream.close();

    assert.equal(stream.closed, true);
    assert.equal(chunks >= 0, true);
    assert.equal(bytes >= 0, true);
  },
);

test(
  "audify-compatible backend can start, stop and start again",
  { skip: !enabled },
  async () => {
    const Backend = require("../lib/backend");
    const backend = new Backend();

    const device = backend
      .getDevices()
      .find((item) => item.inputChannels > 0) || { id: "" };

    backend.openInputStream(
      device.id,
      1,
      backend.SampleFormat.FLOAT32,
      48000,
      1024,
      () => {},
    );

    backend.start();
    await new Promise((resolve) => setTimeout(resolve, 300));
    backend.stop();

    backend.start();
    await new Promise((resolve) => setTimeout(resolve, 300));
    backend.stop();

    backend.closeStream();
    assert.equal(backend.started, false);
  },
);
