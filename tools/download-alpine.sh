#!/bin/sh


# https://dl-cdn.alpinelinux.org/alpine/v3.24/releases/aarch64/alpine-minirootfs-3.24.1-aarch64.tar.gz
# https://dl-cdn.alpinelinux.org/alpine/v3.24/releases/aarch64/alpine-minirootfs-3.24.1-aarch64.tar.gz.sha256


if ! command -v curl >/dev/null ; then
  if ! [ -z "$shr" ] ; then
    alias curl='sh "$shr" curl'
  else
    echo No curl found
    exit 1
  fi
fi


ALPINE_VERSION=3.24.1
MAIN_VER=$(echo $ALPINE_VERSION | grep -o -E '[0-9]+\.[0-9]+')

ARCH=aarch64
BASE_URL=https://dl-cdn.alpinelinux.org/alpine

FILE=alpine-minirootfs-$ALPINE_VERSION-$ARCH.tar.gz

FULL_URL=$BASE_URL/v$MAIN_VER/releases/$ARCH/$FILE

SHA256=$(curl -#k $FULL_URL.sha256)

echo This script downloads an unmodified Alpine Linux minimal root filesystem directly from the official Alpine Linux distribution servers.

printf "\033[32m URL: $FULL_URL\n"
printf " Hash: $SHA256 \033[0m \n"

echo -n "Continue? 繼續嗎？(Y/n)"

read ctn

if echo $ctn | grep -i n ; then
  echo "User cancelled download!"
  exit 1
fi

if [ -f "$FILE" ] ; then
  echo "File already exist!"
else
  curl -kLO $FULL_URL
fi

echo "Doing sha256 checksum for file integrity..."

echo "$SHA256" | sha256sum -c -
