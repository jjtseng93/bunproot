#!/bin/sh

apt update
apt install pulseaudio alsa-utils

# Not in Android Native Termux
#   Lines 9-22

apt install pulseaudio-utils

# # Test basic sound card ability
# ## 1. Adjust volumes
# - MM = mute, click on it or press m to toggle

# alsamixer

# ## 2. Play a noise
# - `D = device`: card 0, device 0
#   * Use `aplay -l` to show
# - `c = channel stereo`

# speaker-test -D hw:0,0 -c 2

unset PULSE_SERVER

pulseaudio --start --exit-idle-time=-1 -L \
  'module-native-protocol-tcp listen=127.0.0.1 auth-anonymous=1'

export PULSE_SERVER=127.0.0.1

# Not in Android Termux
pactl load-module module-alsa-sink \
  device=hw:0,0 sink_name=buninu

# Should see a Default Sink: not null
# Android: OpenSL_ES_sink
pactl info

# Android Native Termux
paplay $PREFIX/share/sounds/alsa/Front_Center.wav
# Buninu Linux inside chroot debian:13
paplay /usr/share/sounds/alsa/Front_Center.wav

# Playing sound in another container
export PULSE_SERVER=127.0.0.1
bun casty.js youtu.be/kGtFAROe1zQ
# FAR owe not zero, one z Q not L
