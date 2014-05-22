var S = require("./structs.js");

function absoluteSteps(path) {
    var steps = [];
    path.split('/').forEach(function (str) {
        if (str === '..') steps.pop();
        else if (str && str !== '.') steps.push(str);
    });
    return steps;
}

/* comparing C rounding trick from FAT spec with Math.ceil
function tryBoth(d) {
    var a = ((d.RootEntCnt * 32) + (d.BytsPerSec - 1)) / d.BytsPerSec >>> 0,
        b = Math.ceil((d.RootEntCnt * 32) / d.BytsPerSec);
    if (b !== a) console.log("try", b, a, (b === a) ? '' : '*');
    return (b === a);
}
// BytsPerSec — "may take on only the following values: 512, 1024, 2048 or 4096"
[512, 1024, 2048, 4096].forEach(function (bps) {
    // RootEntCnt — "a count that when multiplied by 32 results in an even multiple of BPB_BytsPerSec"
    for (var evenMultiplier = 0; evenMultiplier < 1024*1024*16; evenMultiplier += 2) {
        var rec = (bps * evenMultiplier) / 32;
        tryBoth({RootEntCnt:rec, BytsPerSec:bps});
    }
});
*/

function hex(n, ff) {
    return (1+ff+n).toString(16).slice(1);
}


exports.createFileSystem = function (volume) {
    var fs = {};
    
    var sectorBuffer;               // NOTE: must 
    function setSectorSize(len) {
        if (!sectorBuffer || sectorBuffer.length !== len) sectorBuffer = new Buffer(len);
    }
    function readSector(secNum, cb) {
        var secSize = sectorBuffer.length;
        volume.read(sectorBuffer, 0, secSize, secNum*secSize, cb);
    }
    function readFromSectorOffset(secNum, offset, len, cb) {
        var secSize = sectorBuffer.length;
        volume.read(sectorBuffer, 0, len, secNum*secSize+offset, cb);
    }
    
    // TODO: when/where to do this stuff? do we need a 'ready' event… :-(
    setSectorSize(512);
    readSector(0, function (e) {
        if (e) throw e;
        
        if (sectorBuffer[510] !== 0x55 || sectorBuffer[511] !== 0xAA) throw Error("Invalid volume signature!");
        var isFAT16 = sectorBuffer.readUInt16LE(22),        // HACK: get FATSz16 without full decode
            bootStruct = (isFAT16) ? S.boot16 : S.boot32;
        var d = bootStruct.valueFromBytes(sectorBuffer);
        if (!d.BytsPerSec) throw Error("This looks like an ExFAT volume! (unsupported)");
        setSectorSize(d.BytsPerSec);
        
//console.log(d);
        
        var FATSz = (isFAT16) ? d.FATSz16 : d.FATSz32,
            rootDirSectors = Math.ceil((d.RootEntCnt * 32) / d.BytsPerSec),
            firstDataSector = d.ResvdSecCnt + (d.NumFATs * FATSz) + rootDirSectors,
            totSec = (d.TotSec16) ? d.TotSec16 : d.TotSec32,
            dataSec = totSec - firstDataSector,
            countofClusters = Math.floor(dataSec / d.SecPerClus);
        
        var fatType;
        if (countofClusters < 4085) {
            fatType = 'fat12';
        } else if (countofClusters < 65525) {
            fatType = 'fat16';
        } else {
            fatType = 'fat32';
        }
        
        // TODO: abort if (TotSec16/32 > DskSz) to e.g. avoid corrupting subsequent partitions!
        
        
//console.log("rootDirSectors", rootDirSectors, "firstDataSector", firstDataSector, "countofClusters", countofClusters, "=>", fatType);
        
        
        
        function sectorForCluster(n) {
            return firstDataSector + (n-2)*d.SecPerClus;
        }
        
        // TODO: fetch root directory entry
        // TODO: chase files through (first) FAT
        
        function fetchFromFAT(clusterNum, cb) {
            var entryStruct = S.fatField[fatType],
                FATOffset = (fatType === 'fat12') ? Math.floor(clusterNum/2) * entryStruct.size : clusterNum * entryStruct.size,
                SecNum = d.ResvdSecCnt + Math.floor(FATOffset / d.BytsPerSec);
                EntOffset = FATOffset % d.BytsPerSec;
            readFromSectorOffset(SecNum, EntOffset, entryStruct.size, function (e) {
                if (e) return cb(e);
                var entry = entryStruct.valueFromBytes(sectorBuffer);
                if (fatType === 'fat12') {
                    if (clusterNum % 2) {
                        entry.NextCluster = (entry.NextCluster0a << 8) + entry.NextCluster0bc;
                    } else {
                        entry.NextCluster = (entry.NextCluster1ab << 4) + entry.NextCluster1c;
                    }
                }
                else if (fatType === 'fat32') entry.NextCluster &= 0x0FFFFFFF;
                cb(null, entry.NextCluster);
            });
        }
        
        
        // TODO: this is a great candidate for special test coverage!
        var _snInvalid = /[^A-Z0-9$%'-_@~`!(){}^#&.]/g;         // NOTE: '.' is not valid but we split it away
        function shortname(name) {
            var lossy = false;
            name = name.toUpperCase().replace(/ /g, '').replace(/^\.+/, '');
            name = name.replace(_snInvalid, function () {
                lossy = true;
                return '_';
            });
            
            var parts = name.split('.'),
                basis3 = parts.pop(),
                basis8 = parts.join('');
            if (!parts.length) {
                basis8 = basis3;
                basis3 = '';
            }
            if (basis8.length > 8) {
                basis8 = basis8.slice(0,8);
                // NOTE: technically, spec's "lossy conversion" flag is NOT set by excess length.
                //       But since lossy conversion and truncated names both need a numeric tail…
                lossy = true;
            }
            if (basis3.length > 3) {
                basis3 = basis3.slice(0,3);
                lossy = true;
            }
            return {basis:[basis8,basis3], lossy:lossy};
        }
        
        function findInDirectory(dir_c, name, cb) {
            
            
            
            
            var s = sectorForCluster(dir_c);
            readSector(s, function (e) {
                if (e) throw e;
                
                var off = {bytes:0};
                while (off.bytes < sectorBuffer.length) {
                    var startBytes = off.bytes,
                        entry = S.dirEntry.valueFromBytes(sectorBuffer, off);
                    
                    
                    console.log(hex(sectorBuffer[startBytes],0xFF), entry);
                    
                    
                }
            });
            
        }
        
        fs._sectorForCluster = sectorForCluster;
        fs._fetchFromFat = fetchFromFat;
        
        // NOTE: will be negative (and potentially a non-integer) for FAT12/FAT16!
        //var firstRootDirSecNum = (isFAT16) ? firstDataSector - rootDirSectors : sectorForCluster(d.RootClus);
        fs._rootDirCluster = (isFAT16) ? 2 - rootDirSectors / d.SecPerClus : d.RootClus;
        fs._findInDirectory = findInDirectory;
        
//        fetchFromFAT(2, function (e,d) {
//            if (e) throw e;
//            else console.log("Next cluster is", d.toString(16));
//            fetchFromFAT(3, function (e,d) {
//                if (e) throw e;
//                else console.log("Next cluster is", d.toString(16));
//                fetchFromFAT(4, function (e,d) {
//                    if (e) throw e;
//                    else console.log("Next cluster is", d.toString(16));
//                });
//            });
//        });
    });
    
    fs.readdir = function (path, cb) {
        var steps = absoluteSteps(path);
        // TODO: implement
    };
    fs.readFile = function (path, opts, cb) {
        if (typeof opts === 'function ') {
            cb = opts;
            opts = {};
        }
        // TODO: opts.flag, opts.encoding
        var steps = absoluteSteps(path);
        console.log("steps to file:", steps);
        
        readSector(firstRootDirSecNum, function (e) {
            if (e) throw e;
            console.log("firstRootDirSecNum", firstRootDirSecNum, sectorBuffer);
            
            var off = {bytes:0};
            while (off.bytes < sectorBuffer.length) {
                var startBytes = off.bytes,
                    entry = S.dirEntry.valueFromBytes(sectorBuffer, off);
                console.log(hex(sectorBuffer[startBytes],0xFF), entry);
            }
        });
        
        
    };
    
    
    return fs;
}