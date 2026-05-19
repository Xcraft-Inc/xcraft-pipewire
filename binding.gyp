{
  "targets": [
    {
      "target_name": "pipewire_capture",
      "sources": ["src/addon.cc"],
      "include_dirs": [
        "<!@(node -p \"require('node-addon-api').include\")",
        "<!@(pkg-config --cflags-only-I libpipewire-0.3 | sed 's/-I//g')"
      ],
      "libraries": [
        "<!@(pkg-config --libs libpipewire-0.3)"
      ],
      "cflags_cc": [
        "-std=c++17",
        "-fexceptions"
      ],
      "defines": [
        "NAPI_CPP_EXCEPTIONS"
      ]
    }
  ]
}
