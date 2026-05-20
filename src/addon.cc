#include <napi.h>

#include <atomic>
#include <chrono>
#include <cstdlib>
#include <cstring>
#include <mutex>
#include <stdexcept>
#include <string>
#include <thread>
#include <vector>

#include <pipewire/pipewire.h>
#include <spa/param/audio/format-utils.h>

struct AudioChunk {
  std::vector<uint8_t> bytes;
  uint32_t frames = 0;
  uint32_t channels = 0;
  uint32_t sampleRate = 0;
  std::string sampleFormat;
};

static std::string DictValue(const struct spa_dict* props, const char* key) {
  if (!props || !key) {
    return "";
  }

  const char* value = spa_dict_lookup(props, key);
  return value ? value : "";
}

class PipeWireInputStream : public Napi::ObjectWrap<PipeWireInputStream> {
public:
  static Napi::Object Init(Napi::Env env, Napi::Object exports) {
    Napi::Function ctor = DefineClass(env, "PipeWireInputStream", {
      InstanceMethod("close", &PipeWireInputStream::CloseWrapped)
    });

    constructor = Napi::Persistent(ctor);
    constructor.SuppressDestruct();

    exports.Set("PipeWireInputStream", ctor);
    return exports;
  }

  static void EnsurePipeWireInitialized() {
    static std::once_flag once;
    std::call_once(once, []() {
      pw_init(nullptr, nullptr);
    });
  }

  static Napi::Object NewInstance(
    Napi::Env env,
    const std::string& deviceId,
    uint32_t channels,
    const std::string& sampleFormat,
    uint32_t sampleRate,
    uint32_t frameSize,
    Napi::Function callback
  ) {
    /*
      Do not create an EscapableHandleScope here.
      NewInstance() is called from an exported native callback which already
      owns the lifetime of the return value. Some Node/N-API builds do not
      have an active HandleScope at this point unless the exported callback
      creates one explicitly; creating an EscapableHandleScope here can crash
      with:
        v8::HandleScope::CreateHandle() Cannot create a handle without a HandleScope
    */
    Napi::Object obj = constructor.New({});
    auto* self = Napi::ObjectWrap<PipeWireInputStream>::Unwrap(obj);

    self->Start(
      env,
      deviceId,
      channels,
      sampleFormat,
      sampleRate,
      frameSize,
      callback
    );

    return obj;
  }

  PipeWireInputStream(const Napi::CallbackInfo& info)
    : Napi::ObjectWrap<PipeWireInputStream>(info) {
  }

  ~PipeWireInputStream() override {
    DisposeFromDestructor();
  }

private:
  static Napi::FunctionReference constructor;

  struct pw_main_loop* loop_ = nullptr;
  struct pw_stream* stream_ = nullptr;

  struct spa_audio_info format_ = {};
  struct pw_stream_events streamEvents_ = {};

  std::thread loopThread_;
  std::mutex lifecycleMutex_;

  std::atomic<bool> closing_{false};
  std::atomic<bool> closed_{true};
  std::atomic<bool> tsfnCreated_{false};
  std::atomic<bool> objectReferenced_{false};

  Napi::ThreadSafeFunction tsfn_;

  std::string sampleFormat_;
  uint32_t requestedChannels_ = 0;
  uint32_t requestedSampleRate_ = 0;
  uint32_t frameSize_ = 0;

  static enum spa_audio_format ToSpaFormat(const std::string& sampleFormat) {
    if (sampleFormat == "f32" || sampleFormat == "float32") {
      return SPA_AUDIO_FORMAT_F32;
    }

    if (sampleFormat == "s16" || sampleFormat == "int16") {
      return SPA_AUDIO_FORMAT_S16;
    }

    return SPA_AUDIO_FORMAT_UNKNOWN;
  }

  static uint32_t BytesPerSample(const std::string& sampleFormat) {
    if (sampleFormat == "f32" || sampleFormat == "float32") {
      return 4;
    }

    if (sampleFormat == "s16" || sampleFormat == "int16") {
      return 2;
    }

    return 0;
  }

  void Start(
    Napi::Env env,
    const std::string& deviceId,
    uint32_t channels,
    const std::string& sampleFormat,
    uint32_t sampleRate,
    uint32_t frameSize,
    Napi::Function callback
  ) {
    EnsurePipeWireInitialized();

    auto spaFormat = ToSpaFormat(sampleFormat);
    if (spaFormat == SPA_AUDIO_FORMAT_UNKNOWN) {
      Napi::TypeError::New(env, "Unsupported sampleFormat. Use 'f32', 'float32', 's16' or 'int16'.")
        .ThrowAsJavaScriptException();
      return;
    }

    if (channels == 0) {
      Napi::TypeError::New(env, "channels must be > 0")
        .ThrowAsJavaScriptException();
      return;
    }

    if (sampleRate == 0) {
      Napi::TypeError::New(env, "sampleRate must be > 0")
        .ThrowAsJavaScriptException();
      return;
    }

    sampleFormat_ = sampleFormat;
    requestedChannels_ = channels;
    requestedSampleRate_ = sampleRate;
    frameSize_ = frameSize;

    Ref();
    objectReferenced_ = true;

    try {
      tsfn_ = Napi::ThreadSafeFunction::New(
        env,
        callback,
        "XcraftPipeWireCaptureCallback",
        0,
        1
      );
      tsfnCreated_ = true;

      loop_ = pw_main_loop_new(nullptr);
      if (!loop_) {
        throw std::runtime_error("pw_main_loop_new failed");
      }

      streamEvents_ = {};
      streamEvents_.version = PW_VERSION_STREAM_EVENTS;
      streamEvents_.process = &PipeWireInputStream::OnProcess;
      streamEvents_.param_changed = &PipeWireInputStream::OnParamChanged;

      struct pw_properties* props = pw_properties_new(
        PW_KEY_MEDIA_TYPE, "Audio",
        PW_KEY_MEDIA_CATEGORY, "Capture",
        PW_KEY_MEDIA_ROLE, "Music",
        nullptr
      );

      if (!props) {
        throw std::runtime_error("pw_properties_new failed");
      }

      if (!deviceId.empty()) {
        pw_properties_set(props, PW_KEY_TARGET_OBJECT, deviceId.c_str());
      }

      std::string latency;
      if (frameSize > 0 && sampleRate > 0) {
        latency = std::to_string(frameSize) + "/" + std::to_string(sampleRate);
        pw_properties_set(props, PW_KEY_NODE_LATENCY, latency.c_str());
      }

      stream_ = pw_stream_new_simple(
        pw_main_loop_get_loop(loop_),
        "xcraft-pipewire-capture",
        props,
        &streamEvents_,
        this
      );

      if (!stream_) {
        /*
          pw_stream_new_simple() takes ownership of props, including on failure.
          Do not call pw_properties_free(props) here, otherwise we risk a double free
          on older/newer PipeWire builds that follow the documented ownership rule.
        */
        throw std::runtime_error("pw_stream_new_simple failed");
      }

      uint8_t buffer[1024];
      struct spa_pod_builder builder = SPA_POD_BUILDER_INIT(buffer, sizeof(buffer));

      struct spa_audio_info_raw raw = {};
      raw.format = spaFormat;
      raw.rate = sampleRate;
      raw.channels = channels;

      const struct spa_pod* params[1];
      uint32_t nParams = 0;

      params[nParams++] = spa_format_audio_raw_build(
        &builder,
        SPA_PARAM_EnumFormat,
        &raw
      );

      int res = pw_stream_connect(
        stream_,
        PW_DIRECTION_INPUT,
        PW_ID_ANY,
        static_cast<pw_stream_flags>(
          PW_STREAM_FLAG_AUTOCONNECT |
          PW_STREAM_FLAG_MAP_BUFFERS |
          PW_STREAM_FLAG_RT_PROCESS
        ),
        params,
        nParams
      );

      if (res < 0) {
        throw std::runtime_error("pw_stream_connect failed");
      }

      closed_ = false;
      closing_ = false;

      loopThread_ = std::thread([this]() {
        RunLoopAndCleanup();
      });
    } catch (const std::exception& ex) {
      DisposeAfterFailedStart();
      Napi::Error::New(env, ex.what()).ThrowAsJavaScriptException();
      return;
    }
  }

  void RunLoopAndCleanup() {
    if (loop_) {
      pw_main_loop_run(loop_);
    }

    if (stream_) {
      pw_stream_destroy(stream_);
      stream_ = nullptr;
    }

    if (loop_) {
      pw_main_loop_destroy(loop_);
      loop_ = nullptr;
    }

    if (tsfnCreated_) {
      tsfn_.Release();
      tsfnCreated_ = false;
    }

    closed_ = true;
  }

  void DisposeAfterFailedStart() {
    closing_ = true;
    closed_ = true;

    if (stream_) {
      pw_stream_destroy(stream_);
      stream_ = nullptr;
    }

    if (loop_) {
      pw_main_loop_destroy(loop_);
      loop_ = nullptr;
    }

    if (tsfnCreated_) {
      tsfn_.Release();
      tsfnCreated_ = false;
    }

    if (objectReferenced_) {
      Unref();
      objectReferenced_ = false;
    }
  }

  void DisposeFromDestructor() {
    CloseNativeOnly();
  }

  void CloseNativeOnly() {
    std::lock_guard<std::mutex> lock(lifecycleMutex_);

    if (closing_.exchange(true)) {
      return;
    }

    if (loop_) {
      pw_main_loop_quit(loop_);
    }

    if (loopThread_.joinable()) {
      if (std::this_thread::get_id() != loopThread_.get_id()) {
        loopThread_.join();
      } else {
        loopThread_.detach();
      }
    }

    closed_ = true;
  }

  Napi::Value CloseWrapped(const Napi::CallbackInfo& info) {
    CloseNativeOnly();

    if (objectReferenced_) {
      Unref();
      objectReferenced_ = false;
    }

    return info.Env().Undefined();
  }

  static void OnParamChanged(
    void* userdata,
    uint32_t id,
    const struct spa_pod* param
  ) {
    auto* self = static_cast<PipeWireInputStream*>(userdata);

    if (param == nullptr || id != SPA_PARAM_Format) {
      return;
    }

    if (spa_format_parse(
      param,
      &self->format_.media_type,
      &self->format_.media_subtype
    ) < 0) {
      return;
    }

    if (
      self->format_.media_type != SPA_MEDIA_TYPE_audio ||
      self->format_.media_subtype != SPA_MEDIA_SUBTYPE_raw
    ) {
      return;
    }

    spa_format_audio_raw_parse(param, &self->format_.info.raw);
  }

  static void OnProcess(void* userdata) {
    auto* self = static_cast<PipeWireInputStream*>(userdata);

    if (self->closing_ || self->closed_) {
      return;
    }

    struct pw_buffer* pwBuffer = pw_stream_dequeue_buffer(self->stream_);
    if (pwBuffer == nullptr) {
      return;
    }

    struct spa_buffer* spaBuffer = pwBuffer->buffer;
    if (
      spaBuffer == nullptr ||
      spaBuffer->n_datas == 0 ||
      spaBuffer->datas[0].data == nullptr ||
      spaBuffer->datas[0].chunk == nullptr
    ) {
      pw_stream_queue_buffer(self->stream_, pwBuffer);
      return;
    }

    void* data = spaBuffer->datas[0].data;
    uint32_t offset = spaBuffer->datas[0].chunk->offset;
    uint32_t size = spaBuffer->datas[0].chunk->size;

    if (size == 0) {
      pw_stream_queue_buffer(self->stream_, pwBuffer);
      return;
    }

    uint8_t* bytes = static_cast<uint8_t*>(data) + offset;
    auto* chunk = new AudioChunk();

    try {
      chunk->bytes.resize(size);
      std::memcpy(chunk->bytes.data(), bytes, size);

      uint32_t channels = self->format_.info.raw.channels;
      uint32_t rate = self->format_.info.raw.rate;
      uint32_t bytesPerSample = BytesPerSample(self->sampleFormat_);

      chunk->channels = channels;
      chunk->sampleRate = rate;
      chunk->sampleFormat = self->sampleFormat_;

      if (channels > 0 && bytesPerSample > 0) {
        chunk->frames = size / bytesPerSample / channels;
      }
    } catch (...) {
      delete chunk;
      pw_stream_queue_buffer(self->stream_, pwBuffer);
      return;
    }

    pw_stream_queue_buffer(self->stream_, pwBuffer);

    napi_status status = self->tsfn_.NonBlockingCall(
      chunk,
      [](Napi::Env env, Napi::Function jsCallback, AudioChunk* chunk) {
        Napi::HandleScope scope(env);

        try {
          Napi::Buffer<uint8_t> buffer = Napi::Buffer<uint8_t>::Copy(
            env,
            chunk->bytes.data(),
            chunk->bytes.size()
          );

          Napi::Object info = Napi::Object::New(env);
          info.Set("frames", Napi::Number::New(env, chunk->frames));
          info.Set("channels", Napi::Number::New(env, chunk->channels));
          info.Set("sampleRate", Napi::Number::New(env, chunk->sampleRate));
          info.Set("sampleFormat", Napi::String::New(env, chunk->sampleFormat));

          jsCallback.Call({buffer, info});
        } catch (...) {
          // Intentionally swallowed. A future EventEmitter wrapper should surface callback errors.
        }

        delete chunk;
      }
    );

    if (status != napi_ok) {
      delete chunk;
    }
  }
};

Napi::FunctionReference PipeWireInputStream::constructor;

struct ListedNode {
  uint32_t id = 0;

  std::string name;
  std::string description;
  std::string mediaClass;
  std::string mediaType;
  std::string mediaCategory;
  std::string nodeNick;
  std::string deviceId;
  std::string alsaCardName;
  std::string alsaCard;
  std::string objectPath;

  uint32_t audioChannels = 0;
  uint32_t audioRate = 0;

  bool isCapture = false;
  bool isSink = false;
  bool isAudio = false;
};

struct RegistryListState {
  struct pw_thread_loop* loop = nullptr;
  struct pw_context* context = nullptr;
  struct pw_core* core = nullptr;
  struct pw_registry* registry = nullptr;

  struct spa_hook registryListener = {};
  struct spa_hook coreListener = {};

  bool loopStarted = false;
  bool loopLocked = false;
  bool registryListenerAdded = false;
  bool coreListenerAdded = false;

  int pending = 0;
  bool done = false;

  std::vector<ListedNode> nodes;
};

struct RegistryListGuard {
  RegistryListState* state = nullptr;

  explicit RegistryListGuard(RegistryListState* s)
    : state(s) {
  }

  ~RegistryListGuard() {
    if (!state) {
      return;
    }

    if (state->loopLocked) {
      pw_thread_loop_unlock(state->loop);
      state->loopLocked = false;
    }

    if (state->loopStarted && state->loop) {
      pw_thread_loop_stop(state->loop);
      state->loopStarted = false;
    }

    if (state->registryListenerAdded) {
      spa_hook_remove(&state->registryListener);
      state->registryListenerAdded = false;
    }

    if (state->coreListenerAdded) {
      spa_hook_remove(&state->coreListener);
      state->coreListenerAdded = false;
    }

    if (state->registry) {
      pw_proxy_destroy(reinterpret_cast<struct pw_proxy*>(state->registry));
      state->registry = nullptr;
    }

    if (state->core) {
      pw_core_disconnect(state->core);
      state->core = nullptr;
    }

    if (state->context) {
      pw_context_destroy(state->context);
      state->context = nullptr;
    }

    if (state->loop) {
      pw_thread_loop_destroy(state->loop);
      state->loop = nullptr;
    }
  }
};

static uint32_t DictUInt32(const struct spa_dict* props, const char* key) {
  std::string value = DictValue(props, key);
  if (value.empty()) {
    return 0;
  }

  char* end = nullptr;
  unsigned long parsed = std::strtoul(value.c_str(), &end, 10);
  if (end == value.c_str()) {
    return 0;
  }

  return static_cast<uint32_t>(parsed);
}

static bool IsAudioNode(const std::string& mediaClass, const std::string& mediaType) {
  if (mediaType == "Audio") {
    return true;
  }

  if (mediaClass.rfind("Audio/", 0) == 0) {
    return true;
  }

  return false;
}

static bool IsCaptureNode(const std::string& mediaClass) {
  return (
    mediaClass == "Audio/Source" ||
    mediaClass == "Audio/Duplex" ||
    mediaClass == "Stream/Input/Audio"
  );
}

static bool IsSinkNode(const std::string& mediaClass) {
  return (
    mediaClass == "Audio/Sink" ||
    mediaClass == "Stream/Output/Audio"
  );
}

static void OnRegistryGlobal(
  void* data,
  uint32_t id,
  uint32_t permissions,
  const char* type,
  uint32_t version,
  const struct spa_dict* props
) {
  (void)permissions;
  (void)version;

  auto* state = static_cast<RegistryListState*>(data);

  if (!type || std::strcmp(type, PW_TYPE_INTERFACE_Node) != 0) {
    return;
  }

  ListedNode node;
  node.id = id;

  node.name = DictValue(props, PW_KEY_NODE_NAME);
  node.description = DictValue(props, PW_KEY_NODE_DESCRIPTION);
  node.mediaClass = DictValue(props, PW_KEY_MEDIA_CLASS);
  node.mediaType = DictValue(props, PW_KEY_MEDIA_TYPE);
  node.mediaCategory = DictValue(props, PW_KEY_MEDIA_CATEGORY);
  node.nodeNick = DictValue(props, PW_KEY_NODE_NICK);
  node.deviceId = DictValue(props, PW_KEY_DEVICE_ID);
  node.objectPath = DictValue(props, PW_KEY_OBJECT_PATH);

  node.alsaCardName = DictValue(props, "alsa.card_name");
  node.alsaCard = DictValue(props, "alsa.card");

  node.audioChannels = DictUInt32(props, "audio.channels");
  node.audioRate = DictUInt32(props, "audio.rate");

  node.isAudio = IsAudioNode(node.mediaClass, node.mediaType);
  node.isCapture = IsCaptureNode(node.mediaClass);
  node.isSink = IsSinkNode(node.mediaClass);

  if (!node.isAudio) {
    return;
  }

  if (!node.isCapture && !node.isSink) {
    return;
  }

  state->nodes.push_back(std::move(node));
}

static void OnRegistryGlobalRemove(void* data, uint32_t id) {
  (void)data;
  (void)id;
}

static const struct pw_registry_events* GetRegistryEvents() {
  static const struct pw_registry_events events = []() {
    struct pw_registry_events e = {};
    e.version = PW_VERSION_REGISTRY_EVENTS;
    e.global = OnRegistryGlobal;
    e.global_remove = OnRegistryGlobalRemove;
    return e;
  }();

  return &events;
}

static void OnCoreDone(void* data, uint32_t id, int seq) {
  (void)id;

  auto* state = static_cast<RegistryListState*>(data);

  if (seq == state->pending) {
    state->done = true;
    pw_thread_loop_signal(state->loop, false);
  }
}

static void OnCoreError(
  void* data,
  uint32_t id,
  int seq,
  int res,
  const char* message
) {
  (void)id;
  (void)seq;
  (void)res;
  (void)message;

  auto* state = static_cast<RegistryListState*>(data);
  state->done = true;
  pw_thread_loop_signal(state->loop, false);
}

static const struct pw_core_events* GetCoreEvents() {
  static const struct pw_core_events events = []() {
    struct pw_core_events e = {};
    e.version = PW_VERSION_CORE_EVENTS;
    e.done = OnCoreDone;
    e.error = OnCoreError;
    return e;
  }();

  return &events;
}

static Napi::Object NodeToObject(Napi::Env env, const ListedNode& node) {
  Napi::Object item = Napi::Object::New(env);

  item.Set("id", Napi::Number::New(env, node.id));
  item.Set("name", Napi::String::New(env, node.name));
  item.Set("description", Napi::String::New(env, node.description));
  item.Set("mediaClass", Napi::String::New(env, node.mediaClass));
  item.Set("mediaType", Napi::String::New(env, node.mediaType));
  item.Set("mediaCategory", Napi::String::New(env, node.mediaCategory));
  item.Set("nodeNick", Napi::String::New(env, node.nodeNick));
  item.Set("deviceId", Napi::String::New(env, node.deviceId));
  item.Set("alsaCardName", Napi::String::New(env, node.alsaCardName));
  item.Set("alsaCard", Napi::String::New(env, node.alsaCard));
  item.Set("objectPath", Napi::String::New(env, node.objectPath));
  item.Set("audioChannels", Napi::Number::New(env, node.audioChannels));
  item.Set("audioRate", Napi::Number::New(env, node.audioRate));

  item.Set("isAudio", Napi::Boolean::New(env, node.isAudio));
  item.Set("isCapture", Napi::Boolean::New(env, node.isCapture));
  item.Set("isSink", Napi::Boolean::New(env, node.isSink));

  return item;
}

Napi::Value ListCaptureNodes(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  Napi::HandleScope scope(env);

  PipeWireInputStream::EnsurePipeWireInitialized();

  RegistryListState state;
  RegistryListGuard guard(&state);

  state.loop = pw_thread_loop_new("xcraft-pipewire-list-nodes", nullptr);
  if (!state.loop) {
    Napi::Error::New(env, "pw_thread_loop_new failed").ThrowAsJavaScriptException();
    return env.Null();
  }

  pw_thread_loop_lock(state.loop);
  state.loopLocked = true;

  state.context = pw_context_new(
    pw_thread_loop_get_loop(state.loop),
    nullptr,
    0
  );

  if (!state.context) {
    Napi::Error::New(env, "pw_context_new failed").ThrowAsJavaScriptException();
    return env.Null();
  }

  state.core = pw_context_connect(state.context, nullptr, 0);
  if (!state.core) {
    Napi::Error::New(env, "pw_context_connect failed").ThrowAsJavaScriptException();
    return env.Null();
  }

  pw_core_add_listener(state.core, &state.coreListener, GetCoreEvents(), &state);
  state.coreListenerAdded = true;

  state.registry = pw_core_get_registry(
    state.core,
    PW_VERSION_REGISTRY,
    0
  );

  if (!state.registry) {
    Napi::Error::New(env, "pw_core_get_registry failed").ThrowAsJavaScriptException();
    return env.Null();
  }

  pw_registry_add_listener(
    state.registry,
    &state.registryListener,
    GetRegistryEvents(),
    &state
  );
  state.registryListenerAdded = true;

  if (pw_thread_loop_start(state.loop) < 0) {
    Napi::Error::New(env, "pw_thread_loop_start failed").ThrowAsJavaScriptException();
    return env.Null();
  }
  state.loopStarted = true;

  state.pending = pw_core_sync(state.core, PW_ID_CORE, 0);

  while (!state.done) {
    pw_thread_loop_wait(state.loop);
  }

  pw_thread_loop_unlock(state.loop);
  state.loopLocked = false;

  Napi::Array result = Napi::Array::New(env, state.nodes.size());

  for (size_t i = 0; i < state.nodes.size(); i++) {
    result.Set(i, NodeToObject(env, state.nodes[i]));
  }

  return result;
}

Napi::Value OpenInputStream(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  Napi::HandleScope scope(env);

  if (info.Length() < 6) {
    Napi::TypeError::New(
      env,
      "openInputStream(deviceId, channels, sampleFormat, sampleRate, frameSize, callback)"
    ).ThrowAsJavaScriptException();
    return env.Null();
  }

  std::string deviceId = info[0].IsString()
    ? info[0].As<Napi::String>().Utf8Value()
    : "";

  if (!info[1].IsNumber()) {
    Napi::TypeError::New(env, "channels must be a number").ThrowAsJavaScriptException();
    return env.Null();
  }

  if (!info[2].IsString()) {
    Napi::TypeError::New(env, "sampleFormat must be a string").ThrowAsJavaScriptException();
    return env.Null();
  }

  if (!info[3].IsNumber()) {
    Napi::TypeError::New(env, "sampleRate must be a number").ThrowAsJavaScriptException();
    return env.Null();
  }

  if (!info[4].IsNumber()) {
    Napi::TypeError::New(env, "frameSize must be a number").ThrowAsJavaScriptException();
    return env.Null();
  }

  if (!info[5].IsFunction()) {
    Napi::TypeError::New(env, "callback must be a function").ThrowAsJavaScriptException();
    return env.Null();
  }

  uint32_t channels = info[1].As<Napi::Number>().Uint32Value();
  std::string sampleFormat = info[2].As<Napi::String>().Utf8Value();
  uint32_t sampleRate = info[3].As<Napi::Number>().Uint32Value();
  uint32_t frameSize = info[4].As<Napi::Number>().Uint32Value();
  Napi::Function callback = info[5].As<Napi::Function>();

  return PipeWireInputStream::NewInstance(
    env,
    deviceId,
    channels,
    sampleFormat,
    sampleRate,
    frameSize,
    callback
  );
}

Napi::Object InitAll(Napi::Env env, Napi::Object exports) {
  PipeWireInputStream::Init(env, exports);

  exports.Set(
    "openInputStream",
    Napi::Function::New(env, OpenInputStream)
  );

  exports.Set(
    "listCaptureNodes",
    Napi::Function::New(env, ListCaptureNodes)
  );

  return exports;
}

NODE_API_MODULE(xcraft_pipewire, InitAll)
