#!/bin/bash

if ! [ -x "$(command -v blkid)" ]; then
  echo 'Error: util-linux is not installed.' >&2
  exit 1
fi

if ! [ -x "$(command -v dosfslabel)" ]; then
  echo 'Error: dosfstools is not installed.' >&2
  exit 1
fi

rm tests/label.img || true

set -e

dd if=/dev/zero of=tests/label.img bs=1M count=10
mkfs.vfat tests/label.img

npm run label-testcase

BLKID=$(blkid tests/label.img)
DOSFSLABEL=$(dosfslabel tests/label.img)

if ! [[ $BLKID == *'LABEL="CIDATA"'* ]]; then
  echo "blkid: LABEL is invalid"
  exit 1
fi

echo "blkid: LABEL is valid"

if ! [[ $DOSFSLABEL == *"CIDATA"* ]]; then
  echo "dosfslabel: label is invalid"
  exit 1
fi

echo "dosfslabel: label is valid"