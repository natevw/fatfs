//From https://github.com/vatesfr/xen-orchestra/blob/9f0b22d3e9c4672d96cb3f63b1e0fd42609e2406/packages/xo-server/src/fatfs-buffer.js

var assert = require('assert')

var fat16 = require('../structs').boot16

const SECTOR_SIZE = 512

const TEN_MIB = 10 * 1024 * 1024

// Creates a 10MB buffer and initializes it as a FAT 16 volume.
module.exports.init = ({ label = 'NO LABEL   ' } = {}) => {
  assert.strictEqual(typeof label, 'string')
  assert.strictEqual(label.length, 11)

  const buf = Buffer.alloc(TEN_MIB)

  // https://github.com/natevw/fatfs/blob/master/structs.js
  fat16.pack(
    {
      jmpBoot: Buffer.from('eb3c90', 'hex'),
      OEMName: 'mkfs.fat',
      BytsPerSec: SECTOR_SIZE,
      SecPerClus: 4,
      ResvdSecCnt: 1,
      NumFATs: 2,
      RootEntCnt: 512,
      TotSec16: 20480,
      Media: 248,
      FATSz16: 20,
      SecPerTrk: 32,
      NumHeads: 64,
      HiddSec: 0,
      TotSec32: 0,
      DrvNum: 128,
      Reserved1: 0,
      BootSig: 41,
      VolID: 895111106,
      VolLab: label,
      FilSysType: 'FAT16   ',
    },
    buf
  )

  // End of sector.
  buf[0x1fe] = 0x55
  buf[0x1ff] = 0xaa

  // Mark sector as reserved.
  buf[0x200] = 0xf8
  buf[0x201] = 0xff
  buf[0x202] = 0xff
  buf[0x203] = 0xff

  // Mark sector as reserved.
  buf[0x2a00] = 0xf8
  buf[0x2a01] = 0xff
  buf[0x2a02] = 0xff
  buf[0x2a03] = 0xff

  return buf
}

var buffer = (buffer) => {
  return {
    sectorSize: SECTOR_SIZE,
    numSectors: Math.floor(buffer.length / SECTOR_SIZE),
    readSectors: (i, target, cb) => {
      buffer.copy(target, 0, i * SECTOR_SIZE)
      cb()
    },
    writeSectors: (i, source, cb) => {
      source.copy(buffer, i * SECTOR_SIZE, 0)
      cb()
    },
  }
}

module.exports.buffer = buffer