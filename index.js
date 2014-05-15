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
    
    var sectorBuffer = new Buffer(512);
    
    
    
    
    // TODO: when/where to do this stuff? do we need a 'ready' event… :-(
    volume.read(sectorBuffer, 0, 512, 0, function (e,n) {
        if (sectorBuffer[510] !== 0x55 || sectorBuffer[511] !== 0xAA) throw Error("Invalid volume signature!");
        var isFAT16 = sectorBuffer.readUInt16LE(22),        // HACK: get FATSz16 without full decode
            bootStruct = (isFAT16) ? S.boot16 : S.boot32;
        var d = bootStruct.valueFromBytes(sectorBuffer);
        if (!d.BytsPerSec) throw Error("This looks like an ExFAT volume! (unsupported)");
        
        console.log(e,n,d);
        
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
        
        console.log("rootDirSectors", rootDirSectors, "firstDataSector", firstDataSector, "countofClusters", countofClusters, "=>", fatType);
        
        var firstRootDirSecNum = (isFAT16) ? d.ResvdSecCnt + d.NumFATs*d.FATSz16 : findInFAT(d.RootClus);
        console.log("firstRootDirSecNum", firstRootDirSecNum);
        
        // TODO: fetch root directory entry
        // TODO: chase files through (first) FAT
        
        function findInFAT(n) {
            // TODO: needs to handle FAT12
            var scale = 2;
            var FATOffset = n * scale,
                ThisFATSecNum = d.ResvdSecCnt + Math.floor(FATOffset / d.BytsPerSec);
                ThisFATEntOffset = FATOffset % d.BytsPerSec;
        }
        
        d.TotSec16
        
        //d.BytsPerSec
    });
    
    fs.readdir = function (path, cb) {
        var steps = absoluteSteps(path);
        console.log("STEPS", steps);
    };
    
    return fs;
}