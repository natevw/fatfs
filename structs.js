// see http://staff.washington.edu/dittrich/misc/fatgen103.pdf
// and http://www.cse.scu.edu/~tschwarz/COEN252_09/Lectures/FAT.html

var _ = require('struct-fu');

var bootBase = _.struct([
    _.byte('jmpBoot', 3),
    _.char('OEMName', 8),
    _.uint16le('BytsPerSec'),
    _.uint8('SecPerClus'),
    _.uint16le('ResvdSecCnt'),      // Rsvd in table, but Resvd in calcs…
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

var bootInfo = _.struct([
    _.uint8('DrvNum'),
    _.uint8('Reserved1'),
    _.uint8('BootSig'),
    _.uint32le('VolID'),
    _.char('VolLab', 11),
    _.char('FilSysType', 8)
]);

exports.boot16 = _.struct([
    bootBase,
    bootInfo
]);

exports.boot32 = _.struct([
    bootBase,
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
    _.uint16le('BkBootSec'),
    _.byte('Reserved', 12),
    bootInfo
]);

var time = _.struct([
    _.ubit('hour',5),
    _.ubit('minutes',6),
    _.ubit('seconds',5)
]);

var date = _.struct('date', [
    _.ubit('year',7),
    _.ubit('month',4),
    _.ubit('day',5)
]);


exports.dirEntry = _.struct([
    _.struct('Name', [
        _.char('filename',8),
        _.char('extension',3)
    ]),
    _.struct('Attr', [
        _.bool('readonly'),
        _.bool('hidden'),
        _.bool('system'),
        _.bool('volume_id'),
        _.bool('directory'),
        _.bool('archive'),
        _.ubit('reserved', 2)
    ].reverse()),
    _.byte('NTRes', 1),
    _.uint8('CrtTimeTenth'),
    _.struct('CrtTime', [time]),
    _.struct('CrtDate', [date]),
    _.struct('LastAccDate', [date]),
    _.uint16le('FstClusHI'),
    _.struct('WrtTime', [time]),
    _.struct('WrtDate', [date]),
    _.uint16le('FstClusLO'),
    _.uint32le('FileSize')
]);


exports.longDirFlag = 0x0F;
exports.longDirEntry = _.struct([
    _.uint8('Ord'),
    _.char16('Name1', 5),            // NOTE: byte instead of char for UTF16
    _.uint8('Attr'),
    _.uint8('Type'),
    _.uint8('Chksum'),
    _.char16('Name2', 6),
    _.uint16le('FstClusLO'),
    _.char16('Name3', 2)
]);

if (exports.longDirEntry.size !== exports.dirEntry.size) throw Error("Structs ain't right!");

exports.fatField = {
    'fat12': _.struct([
        _.ubit('NextCluster0bc', 8),
        _.ubit('NextCluster1c', 4),
        _.ubit('NextCluster0a', 4),
        _.ubit('NextCluster1ab', 8),
    ]),
    'fat16': _.struct([
        _.uint16le('NextCluster'),
    ]),
    'fat32': _.struct([
        /* more properly, this is:
        _.ubit('reserved', 4),
        _.ubitLE('NextCluster', 28)
        */
        _.uint32le('NextCluster')
    ]),
};

var _errors = {
    IO: "Input/output error",
    NOENT: "No such file or directory",
    INVAL: "Invalid argument"
};

exports.err = {};
Object.keys(_errors).forEach(function (sym) {
    var msg = _errors[sym];
    exports.err[sym] = function () {
        var e = new Error(msg);
        e.code = sym;
        return e;
    };
});
