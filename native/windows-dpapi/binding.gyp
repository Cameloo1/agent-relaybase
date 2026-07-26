{
  "targets": [
    {
      "target_name": "relaybase_windows",
      "sources": ["src/relaybase_windows.cc"],
      "defines": ["NAPI_VERSION=8", "UNICODE", "_UNICODE"],
      "libraries": ["crypt32.lib"]
    }
  ]
}
