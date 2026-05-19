'use strict';

const PipeWire = require('../lib/audify-compatible');

class PipewireAudifyCompliant {
  #backend;
  #log = console;

  constructor() {
    this.#backend = new PipeWire({ log: this.#log });
  }

  get SampleFormat() {
    return this.#backend.SampleFormat;
  }

  getDevices() {
    return this.#backend.getDevices();
  }

  start() {
    this.#backend.start();
  }

  stop() {
    this.#backend.stop();
  }

  openInputStream(
    deviceId,
    channels,
    sampleFormat,
    sampleRate,
    frameSize,
    dataCalllback
  ) {
    this.#backend.openInputStream(
      deviceId,
      channels,
      sampleFormat,
      sampleRate,
      frameSize,
      dataCalllback
    );
  }
}

module.exports = PipewireAudifyCompliant;

if (require.main === module) {
  const backend = new PipewireAudifyCompliant();
  const devices = backend.getDevices();
  console.log(devices);

  const input = devices.find((device) => device.inputChannels > 0);
  if (!input) {
    console.error('No PipeWire capture node found');
    process.exit(1);
  }

  backend.openInputStream(
    input.id,
    1,
    backend.SampleFormat.FLOAT32,
    input.sampleRate,
    1024,
    (buffer, info) => {
      console.log('chunk', buffer.length, info);
    }
  );

  backend.start();

  setTimeout(() => {
    backend.stop();
    process.exit(0);
  }, 10000);
}
