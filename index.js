'use strict';

function loadNative() {
  try {
    return require('./build/Release/xcraft_pipewire.node');
  } catch (error) {
    const message = `Native addon is not built or cannot be loaded: ${error.message}`;

    return {
      openInputStream() {
        throw new Error(message);
      },
      listCaptureNodes() {
        throw new Error(message);
      },
    };
  }
}

class InputStream {
  constructor(nativeStream) {
    this._nativeStream = nativeStream;
    this.closed = false;
  }

  close() {
    if (this.closed) {
      return;
    }

    this.closed = true;

    if (this._nativeStream && typeof this._nativeStream.close === 'function') {
      this._nativeStream.close();
    }

    this._nativeStream = null;
  }

  [Symbol.dispose]() {
    this.close();
  }
}

const SUPPORTED_FORMATS = new Set(['f32', 'float32', 's16', 'int16']);

function normalizeDeviceId(deviceId) {
  if (deviceId == null) {
    return '';
  }

  if (typeof deviceId !== 'string') {
    throw new TypeError('deviceId must be a string, null or undefined');
  }

  return deviceId;
}

function normalizePositiveInteger(value, name, fallback) {
  const resolved = value == null ? fallback : value;

  if (!Number.isInteger(resolved) || resolved <= 0) {
    throw new TypeError(`${name} must be a positive integer`);
  }

  return resolved;
}

function normalizeSampleFormat(sampleFormat) {
  const resolved = sampleFormat == null ? 'f32' : sampleFormat;

  if (typeof resolved !== 'string' || !SUPPORTED_FORMATS.has(resolved)) {
    throw new TypeError("sampleFormat must be one of: 'f32', 'float32', 's16', 'int16'");
  }

  return resolved;
}

function normalizeNodes(nodes) {
  if (!Array.isArray(nodes)) {
    return [];
  }

  return nodes.map((node) => ({
    id: Number(node.id),
    name: String(node.name || ''),
    description: String(node.description || ''),
    mediaClass: String(node.mediaClass || ''),
    mediaType: String(node.mediaType || ''),
    mediaCategory: String(node.mediaCategory || ''),
    nodeNick: String(node.nodeNick || ''),
    deviceId: String(node.deviceId || ''),
    alsaCardName: String(node.alsaCardName || ''),
    alsaCard: String(node.alsaCard || ''),
    objectPath: String(node.objectPath || ''),
    audioChannels: Number(node.audioChannels || 0),
    audioRate: Number(node.audioRate || 0),
    isAudio: Boolean(node.isAudio),
    isCapture: Boolean(node.isCapture),
    isSink: Boolean(node.isSink),
  }));
}

function createApi(native) {
  if (!native || typeof native.openInputStream !== 'function') {
    throw new Error('Invalid native xcraft_pipewire addon');
  }

  function openInputStream(
    deviceId,
    channels,
    sampleFormat,
    sampleRate,
    frameSize,
    dataCallback
  ) {
    const resolvedDeviceId = normalizeDeviceId(deviceId);
    const resolvedChannels = normalizePositiveInteger(channels, 'channels', 1);
    const resolvedSampleFormat = normalizeSampleFormat(sampleFormat);
    const resolvedSampleRate = normalizePositiveInteger(sampleRate, 'sampleRate', 48000);
    const resolvedFrameSize = normalizePositiveInteger(frameSize, 'frameSize', 1024);

    if (typeof dataCallback !== 'function') {
      throw new TypeError('dataCallback must be a function');
    }

    const nativeStream = native.openInputStream(
      resolvedDeviceId,
      resolvedChannels,
      resolvedSampleFormat,
      resolvedSampleRate,
      resolvedFrameSize,
      dataCallback
    );

    return new InputStream(nativeStream);
  }

  function listCaptureNodes() {
    if (typeof native.listCaptureNodes !== 'function') {
      return [];
    }

    return normalizeNodes(native.listCaptureNodes());
  }

  function listInputNodes() {
    return listCaptureNodes().filter((node) => node.isCapture);
  }

  function listSinkNodes() {
    return listCaptureNodes().filter((node) => node.isSink);
  }

  function findNode(predicate) {
    if (typeof predicate !== 'function') {
      throw new TypeError('predicate must be a function');
    }

    return listCaptureNodes().find(predicate) || null;
  }

  function findNodeByName(name) {
    if (typeof name !== 'string') {
      throw new TypeError('name must be a string');
    }

    return findNode((node) => node.name === name);
  }

  function findNodeByText(text) {
    if (typeof text !== 'string') {
      throw new TypeError('text must be a string');
    }

    const needle = text.toLowerCase();

    return findNode((node) => {
      return (
        node.name.toLowerCase().includes(needle) ||
        node.description.toLowerCase().includes(needle) ||
        node.alsaCardName.toLowerCase().includes(needle) ||
        node.nodeNick.toLowerCase().includes(needle)
      );
    });
  }

  return {
    InputStream,
    openInputStream,
    listCaptureNodes,
    listInputNodes,
    listSinkNodes,
    findNode,
    findNodeByName,
    findNodeByText,
  };
}

module.exports = createApi(loadNative());
module.exports._createApi = createApi;
module.exports.InputStream = InputStream;

module.exports.PipeWireCompatibleBackend = require('./lib/audify-compatible');
