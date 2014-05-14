var S = require("./structs.js");

function absoluteSteps(path) {
    var steps = [];
    path.split('/').forEach(function (str) {
        if (str === '..') steps.pop();
        else if (str && str !== '.') steps.push(str);
    });
    return steps;
}

exports.createFileSystem = function (volume) {
    var fs = {};
    
    var sectorBuffer = new Buffer(512);
    
    volume.read(sectorBuffer, 0, 512, 0, function (e,n) {
        var d = S.boot16.valueFromBytes(sectorBuffer);
        console.log(e,n,d);
        
        var rootDirSectors = ((d.RootEntCnt * 32) + (d.BytsPerSec - 1)) / d.BytsPerSec;
        console.log("RootDirSectors", rootDirSectors);
    });
    
    
    fs.readdir = function (path, cb) {
        var steps = absoluteSteps(path);
        console.log("STEPS", steps);
    };
    
    return fs;
}