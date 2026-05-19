'use strict';

const { EventEmitter } = require('node:events');
const defaultPipewire = require('..');

const PipeWireFormat = Object.freeze({
  /**
   * Kept for API compatibility with xcraft-audify.
   * The native PipeWire addon currently supports SINT16 and FLOAT32 only.
   */
  RTAUDIO_SINT8: 's8',
  RTAUDIO_SINT16: 's16',
  RTAUDIO_SINT24: 's24',
  RTAUDIO_SINT32: 's32',
  RTAUDIO_FLOAT32: 'f32',
});

const PipeWireApi = Object.freeze({
  UNSPECIFIED: 'pipewire',
  LINUX_PIPEWIRE: 'pipewire',
});

const SUPPORTED_NATIVE_FORMATS = new Set([
  PipeWireFormat.RTAUDIO_SINT16,
  PipeWireFormat.RTAUDIO_FLOAT32,
  'int16',
  's16',
  'float32',
  'f32',
]);

function normalizeFormat(sampleFormat) {
  switch (sampleFormat) {
    case PipeWireFormat.RTAUDIO_SINT16:
    case 'int16':
    case 's16':
      return 's16';

    case PipeWireFormat.RTAUDIO_FLOAT32:
    case 'float32':
    case 'f32':
      return 'f32';

    case PipeWireFormat.RTAUDIO_SINT8:
    case PipeWireFormat.RTAUDIO_SINT24:
    case PipeWireFormat.RTAUDIO_SINT32:
      throw new Error(
        `PipeWire backend does not support sample format ${sampleFormat} yet; use SINT16 or FLOAT32`
      );

    default:
      throw new Error(
        `Unsupported sample format ${String(sampleFormat)}; use SINT16 or FLOAT32`
      );
  }
}

function toPositiveInteger(value, name) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive integer`);
  }

  return value;
}

function normalizeInputParams(deviceId, channels, sampleFormat, sampleRate, frameSize, dataCallback) {
  if (dataCallback != null && typeof dataCallback !== 'function') {
    throw new TypeError('dataCalllback must be a function when provided');
  }

  return {
    deviceId: deviceId == null ? '' : String(deviceId),
    channels: toPositiveInteger(channels, 'channels'),
    sampleFormat: normalizeFormat(sampleFormat),
    sampleRate: toPositiveInteger(sampleRate, 'sampleRate'),
    frameSize: toPositiveInteger(frameSize, 'frameSize'),
    dataCallback: dataCallback || null,
  };
}

function guessInputChannels(node) {
  if (!node.isCapture) {
    return 0;
  }

  return Number(node.audioChannels || 0) || 2;
}

function guessOutputChannels(node) {
  if (!node.isSink) {
    return 0;
  }

  return Number(node.audioChannels || 0) || 2;
}

function toAudifyDevice(node) {
  return {
    /**
     * Audify/RtAudio uses numeric IDs. PipeWire targeting is more stable with node.name,
     * so id is intentionally the openable PipeWire target string.
     */
    id: node.name || String(node.id),
    nativeId: node.id,
    name: node.description || node.name || `PipeWire node ${node.id}`,
    nodeName: node.name,
    description: node.description,
    mediaClass: node.mediaClass,
    inputChannels: guessInputChannels(node),
    outputChannels: guessOutputChannels(node),
    sampleRate: Number(node.audioRate || 0) || 48000,
    isDefaultInput: false,
    isDefaultOutput: false,
    isCapture: node.isCapture,
    isSink: node.isSink,
    raw: node,
  };
}

class PipeWireCompatibleBackend extends EventEmitter {
  #pipewire;
  #stream = null;
  #pendingInput = null;
  #started = false;
  #log = null;

  constructor(options = {}) {
    super();

    this.options = options;
    this.#pipewire = options.pipewire || defaultPipewire;
    this.#log = options.log || null;
  }

  get SampleFormat() {
    return {
      SINT8: PipeWireFormat.RTAUDIO_SINT8,
      SINT16: PipeWireFormat.RTAUDIO_SINT16,
      SINT24: PipeWireFormat.RTAUDIO_SINT24,
      SINT32: PipeWireFormat.RTAUDIO_SINT32,
      FLOAT32: PipeWireFormat.RTAUDIO_FLOAT32,
    };
  }

  get started() {
    return this.#started;
  }

  get isStreamOpen() {
    return this.#pendingInput !== null;
  }

  getDevices() {
    const devices = this.#pipewire.listCaptureNodes().map(toAudifyDevice);

    if (this.#log && typeof this.#log.dbg === 'function') {
      this.#log.dbg(devices);
    }

    return devices;
  }

  openInputStream(
    deviceId,
    channels,
    sampleFormat,
    sampleRate,
    frameSize,
    dataCalllback
  ) {
    const params = normalizeInputParams(
      deviceId,
      channels,
      sampleFormat,
      sampleRate,
      frameSize,
      dataCalllback
    );

    /**
     * RtAudio-compatible behavior:
     * openStream/openInputStream configures the stream, but capture starts only on start().
     */
    this.stop();
    this.#pendingInput = params;

    this.emit('open', {
      deviceId: params.deviceId,
      channels: params.channels,
      sampleFormat: params.sampleFormat,
      sampleRate: params.sampleRate,
      frameSize: params.frameSize,
    });
  }

  start() {
    if (this.#started) {
      return;
    }

    if (!this.#pendingInput) {
      throw new Error('No input stream is configured; call openInputStream() before start()');
    }

    const params = this.#pendingInput;

    try {
      this.#stream = this.#pipewire.openInputStream(
        params.deviceId,
        params.channels,
        params.sampleFormat,
        params.sampleRate,
        params.frameSize,
        (buffer, info) => {
          this.emit('data', buffer, info);

          if (params.dataCallback) {
            try {
              params.dataCallback(buffer, info);
            } catch (error) {
              this.emit('error', error);
            }
          }
        }
      );

      this.#started = true;
      this.emit('start');
    } catch (error) {
      this.#stream = null;
      this.#started = false;
      this.emit('error', error);
      throw error;
    }
  }

  stop() {
    if (!this.#stream && !this.#started) {
      return;
    }

    const stream = this.#stream;
    this.#stream = null;
    this.#started = false;

    if (stream && typeof stream.close === 'function') {
      stream.close();
    }

    this.emit('stop');
  }

  closeStream() {
    this.stop();
    this.#pendingInput = null;
    this.emit('close');
  }

  close() {
    this.closeStream();
  }

  [Symbol.dispose]() {
    this.close();
  }
}

module.exports = PipeWireCompatibleBackend;
module.exports.PipeWireCompatibleBackend = PipeWireCompatibleBackend;
module.exports.PipeWireFormat = PipeWireFormat;
module.exports.PipeWireApi = PipeWireApi;
module.exports._internals = {
  SUPPORTED_NATIVE_FORMATS,
  normalizeFormat,
  normalizeInputParams,
  toAudifyDevice,
};
