// see http://staff.washington.edu/dittrich/misc/fatgen103.pdf
// and http://www.cse.scu.edu/~tschwarz/COEN252_09/Lectures/FAT.html

var _ = require('struct-fu');

exports.bootBase = _.struct([
    _.byte('jmpBoot', 3),
    _.char('OEMName', 8),
    _.uint16le('BytsPerSec'),
    _.uint8('SecPerClus'),
    _.uint16le('RsvdSecCnt'),
    _.uint8('NumFATs'),
    _.uint16le('RootEntCnt'),
    _.uint16le('TotSec16'),
    _.uint8('Media'),
    _.uint16le('FATSz16'),
    _.uint16le('SecPerTrk'),
    _.uint16le('NumHeads'),
    _.uint32le('HiddSec'),
    _.uint32le('TotSec32')
]);

exports.boot16 = _.struct([
    _.uint8('DrvNum'),
    _.uint8('Reserved1'),
    _.uint8('BootSig'),
    _.uint32le('VolID'),
    _.char('VolLab', 11),
    _.char('FilSysType', 8)
]);

exports.boot32 = _.struct([
    _.uint32le('FATSz32'),
    _.struct('ExtFlags', [
        _.ubit('NumActiveFAT', 4),
        _.ubit('_reserved1', 3),
        _.bool('MirroredFAT'),
        _.ubit('_reserved2', 8)
    ].reverse()),
    _.struct('FSVer', [
        _.uint8('Major'),
        _.uint8('Minor')
    ]),
    _.uint32le('RootClus'),
    _.uint16le('FSInfo'),
    _.unit16le('BkBootSec'),
    _.byte('Reserved', 12),
    // NOTE: this is exports.boot16
    _.uint8('DrvNum'),
    _.uint8('Reserved1'),
    _.uint8('BootSig'),
    _.uint32le('VolID'),
    _.char('VolLab', 11),
    _.char('FilSysType', 8)
]);