'use strict';

const PipeWire = require('../lib/audify-compatible');

class PipewireAudifyCompliant {
  #backend;
  #log = console;

  constructor() {
    this.#backend = new PipeWire({ log: this.#log });
  }

  on(...args) {
    return this.#backend.on(...args);
  }

  once(...args) {
    return this.#backend.once(...args);
  }

  off(...args) {
    return this.#backend.off(...args);
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

  closeStream() {
    this.#backend.closeStream();
  }

  openInputStream(
    deviceId,
    channels,
    sampleFormat,
    sampleRate,
    frameSize,
    dataCalllback
  ) {
    /**
     * Like RtAudio/audify: this only configures the stream.
     * Capture starts when start() is called.
     */
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

  backend.on('open', (info) => console.log('stream configured', info));
  backend.on('start', () => console.log('capture started'));
  backend.on('stop', () => console.log('capture stopped'));
  backend.on('error', (error) => console.error('capture error', error));

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
      console.log('callback chunk', buffer.length, info);
    }
  );

  backend.on('data', (buffer, info) => {
    console.log('event chunk', buffer.length, info.frames);
  });

  backend.start();

  setTimeout(() => {
    backend.stop();
    backend.closeStream();
    process.exit(0);
  }, 3000);
}
