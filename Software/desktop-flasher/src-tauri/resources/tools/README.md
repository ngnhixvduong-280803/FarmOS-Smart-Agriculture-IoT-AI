# Native flash tool resource

The release build places a code-signed, standalone `farmos-esptool` executable in `esptool/`.
It contains the Python runtime and esptool dependencies required to flash FarmOS release images. It is produced by the trusted release-tool pipeline, not downloaded by the end-user application.
