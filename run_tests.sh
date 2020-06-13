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

npm run label-test

BLKID=$(blkid tests/label.img)
DOSFSLABEL=$(dosfslabel tests/label.img)

if ! [[ $BLKID == *'LABEL_FATBOOT="cidata"'* ]]; then
  echo "blkid: LABEL_FATBOOT is invalid"
  exit 1
fi

echo "blkid LABEL_FATBOOT valid"

if ! [[ $BLKID == *'LABEL="cidata"'* ]]; then
  echo "blkid: LABEL is invalid"
  exit 1
fi

echo "blkid LABEL valid"

if ! [[ $DOSFSLABEL == *"cidata"* ]]; then
  echo "dosfslabel: label is invalid"
  exit 1
fi

echo "dosfslabel LABEL valid"