'use strict';

const pipewire = require('..');

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
  if (typeof dataCallback !== 'function') {
    throw new TypeError('dataCalllback must be a function');
  }

  return {
    deviceId: deviceId == null ? '' : String(deviceId),
    channels: toPositiveInteger(channels, 'channels'),
    sampleFormat: normalizeFormat(sampleFormat),
    sampleRate: toPositiveInteger(sampleRate, 'sampleRate'),
    frameSize: toPositiveInteger(frameSize, 'frameSize'),
    dataCallback,
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

class PipeWireCompatibleBackend {
  #stream = null;
  #log = null;

  constructor(options = {}) {
    this.options = options;
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

  getDevices() {
    const devices = pipewire.listCaptureNodes().map(toAudifyDevice);

    if (this.#log && typeof this.#log.dbg === 'function') {
      this.#log.dbg(devices);
    }

    return devices;
  }

  start() {
    /**
     * RtAudio separates openStream() and start().
     * This minimal PipeWire addon starts its stream immediately in openInputStream().
     * So start() is intentionally a no-op for API compatibility.
     */
  }

  stop() {
    if (!this.#stream) {
      return;
    }

    this.#stream.close();
    this.#stream = null;
  }

  closeStream() {
    this.stop();
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

    this.stop();

    this.#stream = pipewire.openInputStream(
      params.deviceId,
      params.channels,
      params.sampleFormat,
      params.sampleRate,
      params.frameSize,
      params.dataCallback
    );
  }
}

module.exports = PipeWireCompatibleBackend;
module.exports.PipeWireCompatibleBackend = PipeWireCompatibleBackend;
module.exports.PipeWireFormat = PipeWireFormat;
module.exports.PipeWireApi = PipeWireApi;
module.exports._internals = {
  SUPPORTED_NATIVE_FORMATS,
  normalizeFormat,
  toAudifyDevice,
};
