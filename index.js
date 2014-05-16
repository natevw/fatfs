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
        
        var firstRootDirSecNum = d.ResvdSecCnt + ((isFAT16) ? d.NumFATs*d.FATSz16 : d.RootClus*d.SecPerClus);
//console.log("firstRootDirSecNum", firstRootDirSecNum);
        
//        readSector(firstRootDirSecNum, function (e) {
//            if (e) throw e;
//            console.log(sectorBuffer);
//            
//            var entry = S.dirEntry.valueFromBytes(sectorBuffer);
//            console.log(entry);
//        });
        
        
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
        
        fetchFromFAT(2, function (e,d) {
            if (e) throw e;
            else console.log("Next cluster is", d.toString(16));
            fetchFromFAT(3, function (e,d) {
                if (e) throw e;
                else console.log("Next cluster is", d.toString(16));
                fetchFromFAT(4, function (e,d) {
                    if (e) throw e;
                    else console.log("Next cluster is", d.toString(16));
                });
            });
        });
        
        //d.BytsPerSec
    });
    
    fs.readdir = function (path, cb) {
        var steps = absoluteSteps(path);
        console.log("readdir steps:", steps);
    };
    
    return fs;
}